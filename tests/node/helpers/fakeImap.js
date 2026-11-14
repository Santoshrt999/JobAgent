/**
 * A tiny IMAP server for tests: canned messages, and a record of every
 * command it received (so tests can prove the client never writes).
 */
import net from 'node:net';

export async function startFakeImap(messages) {
  const commands = [];
  const server = net.createServer((socket) => {
    socket.write('* OK fake IMAP ready\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        commands.push(cmd);
        if (/^LOGIN/i.test(cmd)) socket.write(cmd.includes('"wrong"') ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n` : `${tag} OK LOGIN completed\r\n`);
        else if (/^EXAMINE/i.test(cmd)) socket.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        else if (/^UID SEARCH/i.test(cmd)) socket.write(`* SEARCH ${messages.map((m) => m.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
        else if (/^UID FETCH/i.test(cmd)) {
          const wanted = cmd.split(' ')[2].split(',').map(Number);
          messages.filter((m) => wanted.includes(m.uid)).forEach((m, i) => {
            const head = Buffer.from(m.header.replace(/\n/g, '\r\n') + '\r\n\r\n', 'utf8');
            const body = Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8');
            socket.write(`* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT)] {${head.length}}\r\n`);
            socket.write(head);
            socket.write(` BODY[TEXT]<0> {${body.length}}\r\n`);
            socket.write(body);
            socket.write(')\r\n');
          });
          socket.write(`${tag} OK FETCH completed\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) { socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); socket.end(); }
        else socket.write(`${tag} BAD unexpected command\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, commands, close: () => new Promise((r) => server.close(r)) };
}
