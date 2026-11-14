// @ts-check
/**
 * Just enough MIME to read a reply (P1-7): unfolded headers, RFC 2047
 * encoded words, multipart bodies (nested), base64 and quoted-printable, and
 * the text/plain part (or text/html, tag-stripped). Pure; never stores mail.
 */

/** Header block -> { lowercased name: value } (first occurrence wins). */
export function parseHeaders(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '');
  const out = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!(name in out)) out[name] = decodeWords(line.slice(at + 1).trim());
  }
  return out;
}

function charsetDecode(bytes, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8');
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

function qpBytes(text, { header = false } = {}) {
  const src = header ? text.replace(/_/g, ' ') : text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(src.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 2047: "=?utf-8?B?...?=" and "=?iso-8859-1?Q?...?=". */
export function decodeWords(value) {
  return String(value ?? '')
    .replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, data) => (
      enc.toUpperCase() === 'B'
        ? charsetDecode(Buffer.from(data, 'base64'), charset)
        : charsetDecode(qpBytes(data, { header: true }), charset)));
}

function contentType(value) {
  const v = String(value ?? 'text/plain');
  const type = v.split(';')[0].trim().toLowerCase() || 'text/plain';
  const param = (name) => (new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(v) ?? [])[2]
    ?? (new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(v) ?? [])[1];
  return { type, charset: param('charset'), boundary: param('boundary') };
}

function decodeBody(raw, encoding, charset) {
  const enc = String(encoding ?? '7bit').trim().toLowerCase();
  const latin = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  if (enc === 'base64') return charsetDecode(Buffer.from(latin.replace(/\s+/g, ''), 'base64'), charset);
  if (enc === 'quoted-printable') return charsetDecode(qpBytes(latin), charset);
  return charsetDecode(Buffer.from(latin, 'latin1'), charset);
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * The readable text of a body, given the message's own content headers.
 * @param {Buffer|string} raw
 * @param {{ contentTypeHeader?: string, encoding?: string }} [options]
 * @returns {string}
 */
export function bodyText(raw, { contentTypeHeader, encoding } = {}) {
  const ct = contentType(contentTypeHeader);
  const latin = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '');
  if (ct.type.startsWith('multipart/') && ct.boundary) {
    const parts = latin.split(`--${ct.boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    const decoded = parts.map((part) => {
      const split = part.search(/\r?\n\r?\n/);
      const head = parseHeaders(split === -1 ? part : part.slice(0, split));
      const body = split === -1 ? '' : part.slice(split).replace(/^\r?\n\r?\n/, '');
      return { type: contentType(head['content-type']).type, text: bodyText(body, { contentTypeHeader: head['content-type'], encoding: head['content-transfer-encoding'] }) };
    });
    const plain = decoded.find((p) => p.type === 'text/plain' && p.text.trim());
    if (plain) return plain.text;
    const nested = decoded.find((p) => p.type.startsWith('multipart/') && p.text.trim());
    if (nested) return nested.text;
    const html = decoded.find((p) => p.type === 'text/html');
    return html ? html.text : '';
  }
  const text = decodeBody(latin, encoding, ct.charset);
  return ct.type === 'text/html' ? htmlToText(text) : text;
}

/** "Acme Talent <no-reply@us.greenhouse-mail.io>" -> { name, address, domain }. */
export function parseAddress(value) {
  const v = String(value ?? '').trim();
  const angle = /<([^>]+)>/.exec(v);
  const address = (angle ? angle[1] : v).trim().toLowerCase();
  const name = angle ? v.slice(0, angle.index).trim().replace(/^"|"$/g, '').trim() : '';
  const domain = address.includes('@') ? address.split('@').pop() : '';
  return { name, address, domain };
}
