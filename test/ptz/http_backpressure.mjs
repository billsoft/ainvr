import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../srs-web-console/backend/package.json', import.meta.url));
if (!process.argv.includes('--builtin')) require('undici').install();
for (const mode of ['length', 'chunked', 'eof']) {
 const body = Buffer.alloc(65536, 97);
 const server = createServer(socket => {
  socket.on('error', () => {});
  socket.once('data', () => {
   const header = mode === 'length' ? `Content-Length: ${body.length}\r\n` : mode === 'chunked' ? 'Transfer-Encoding: chunked\r\n' : '';
   socket.write(`HTTP/1.1 200 OK\r\n${header}Connection: close\r\n\r\n`);
   socket.end(mode === 'chunked' ? Buffer.concat([Buffer.from(body.length.toString(16)+'\r\n'), body, Buffer.from('\r\n0\r\n\r\n')]) : body);
  });
 });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {signal:AbortSignal.timeout(3000)});
 await new Promise(resolve => setTimeout(resolve,150));
 assert.equal(await response.text(),body.toString());
 await new Promise(resolve => server.close(resolve));
}
console.log('3 response framings survive paused-consumer socket FIN');
