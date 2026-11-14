/**
 * A minimal, READ-ONLY IMAP client (P1-7). Dependency-free (node:tls).
 *
 * It can do exactly five things: log in, open a mailbox with EXAMINE (the
 * read-only form of SELECT), search by date, fetch headers and text with
 * BODY.PEEK (which does not even set the \Seen flag), and log out. Any other
 * command is refused in `command()` before it is sent, so this client cannot
 * move, delete, flag, mark read, send or append mail, by construction.
 */
import net from 'node:net';
import tls from 'node:tls';

const ALLOWED = /^(LOGIN|EXAMINE|UID SEARCH|UID FETCH|LOGOUT|CAPABILITY|NOOP)\b/;
/** Never mark read, never write: a FETCH must use BODY.PEEK only. */
const WRITE_FETCH = /\bBODY\[|\bRFC822(?!\.SIZE|\.HEADER)\b|\+FLAGS|-FLAGS/i;

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export class ImapReadOnlyClient {
  /**
   * @param {{ host: string, port?: number, secure?: boolean, timeoutMs?: number,
   *   servername?: string, connectImpl?: Function }} options
   */
  constructor({ host, port = 993, secure = true, timeoutMs = 30_000, connectImpl } = {}) {
    Object.assign(this, { host, port, secure, timeoutMs, connectImpl });
    this.buffer = Buffer.alloc(0);
    this.tag = 0;
    this.waiters = [];
    this.sent = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      const socket = this.connectImpl
        ? this.connectImpl()
        : this.secure
          ? tls.connect({ host: this.host, port: this.port, servername: this.host })
          : net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setTimeout?.(this.timeoutMs, () => socket.destroy(new Error(`IMAP timed out after ${this.timeoutMs} ms`)));
      socket.once('error', onError);
      socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); });
      socket.on('close', () => { for (const w of this.waiters.splice(0)) w.reject(new Error('IMAP connection closed')); });
      // The server greets first ("* OK ..."): wait for that untagged line.
      this.waiters.push({
        tag: '*', lines: [],
        resolve: () => { socket.off('error', onError); socket.on('error', () => {}); resolve(); },
        reject,
      });
      this.pump();
    });
  }

  /** Parse complete responses out of the buffer, honouring {n} literals. */
  pump() {
    for (;;) {
      const waiter = this.waiters[0];
      if (!waiter) return;
      const line = this.readLine();
      if (line === null) return;
      if (waiter.tag === '*') {
        if (/^\* (OK|PREAUTH)/i.test(line.text)) { this.waiters.shift(); waiter.resolve([]); continue; }
        if (/^\* BYE/i.test(line.text)) { this.waiters.shift(); waiter.reject(new Error(`IMAP server refused: ${line.text}`)); continue; }
        continue;
      }
      if (line.text.startsWith(`${waiter.tag} `)) {
        this.waiters.shift();
        const status = line.text.slice(waiter.tag.length + 1);
        if (/^OK/i.test(status)) waiter.resolve(waiter.lines);
        else waiter.reject(new Error(`IMAP ${status.replace(/^(NO|BAD)\s*/i, '').slice(0, 200) || 'command failed'}`));
      } else {
        waiter.lines.push(line);
      }
    }
  }

  /** One logical response line, with any literals it carries. */
  readLine() {
    let pos = 0;
    const parts = [];
    const literals = [];
    for (;;) {
      const nl = this.buffer.indexOf('\r\n', pos);
      if (nl === -1) return null;
      const text = this.buffer.subarray(pos, nl).toString('latin1');
      const lit = /\{(\d+)\}$/.exec(text);
      if (!lit) {
        parts.push(text);
        this.buffer = this.buffer.subarray(nl + 2);
        return { text: parts.join(''), literals };
      }
      const size = Number(lit[1]);
      const start = nl + 2;
      if (this.buffer.length < start + size) return null;
      parts.push(text);
      literals.push(this.buffer.subarray(start, start + size));
      pos = start + size;
    }
  }

  command(cmd) {
    if (!ALLOWED.test(cmd)) throw new Error(`refused: this inbox reader is read-only (${cmd.split(' ')[0]})`);
    if (/^UID FETCH/.test(cmd) && WRITE_FETCH.test(cmd)) throw new Error('refused: fetches must use BODY.PEEK so nothing is marked read');
    this.tag += 1;
    const tag = `A${this.tag}`;
    this.sent.push(cmd.startsWith('LOGIN') ? 'LOGIN ***' : cmd);
    return new Promise((resolve, reject) => {
      this.waiters.push({ tag, lines: [], resolve, reject });
      this.socket.write(`${tag} ${cmd}\r\n`);
      this.pump();
    });
  }

  login(user, password) { return this.command(`LOGIN ${quote(user)} ${quote(password)}`); }

  /** Open a mailbox read-only. */
  examine(mailbox = 'INBOX') { return this.command(`EXAMINE ${quote(mailbox)}`); }

  /** UIDs of messages since a date. */
  async searchSince(date) {
    const d = new Date(date);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const lines = await this.command(`UID SEARCH SINCE ${d.getUTCDate()}-${month}-${d.getUTCFullYear()}`);
    const hit = lines.find((l) => /^\* SEARCH/i.test(l.text));
    return hit ? hit.text.replace(/^\* SEARCH\s*/i, '').split(/\s+/).filter(Boolean).map(Number) : [];
  }

  /**
   * Headers and the first `maxBytes` of the text of each UID. Read-only:
   * BODY.PEEK never sets \Seen.
   * @returns {Promise<Array<{ uid: number, header: Buffer, text: Buffer }>>}
   */
  async fetch(uids, { maxBytes = 20_000 } = {}) {
    if (!uids.length) return [];
    const lines = await this.command(
      `UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.${maxBytes}>)`,
    );
    const out = [];
    for (const line of lines) {
      const uid = /UID (\d+)/i.exec(line.text);
      if (!uid || !/FETCH/i.test(line.text)) continue;
      // Asked for in this order, so returned in this order: header, then text.
      out.push({ uid: Number(uid[1]), header: line.literals[0] ?? Buffer.alloc(0), text: line.literals[1] ?? Buffer.alloc(0) });
    }
    return out;
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch { /* closing anyway */ }
    this.socket?.end();
  }
}
