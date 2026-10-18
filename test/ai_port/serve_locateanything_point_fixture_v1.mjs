/** Localhost-only bounded static server for the isolated point Canvas check. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const [rootArg, stateArg] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
const state = path.resolve(stateArg);
if (path.dirname(state) !== root || fs.existsSync(state)) throw Error('New task state path required');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
for (const [name, expected] of Object.entries(manifest.files)) {
  if (path.basename(name) !== name || sha(fs.readFileSync(path.join(root, name))) !== expected) {
    throw Error('Fixture identity mismatch');
  }
}
const allowed = new Set([...Object.keys(manifest.files), 'manifest.json']);
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) {
    res.writeHead(403).end(); return;
  }
  const name = req.url === '/' ? 'index.html' : req.url?.slice(1);
  if (!allowed.has(name)) { res.writeHead(404).end(); return; }
  const data = fs.readFileSync(path.join(root, name));
  const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html';
  res.writeHead(200, {'Content-Type':mime+'; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store'}).end(data);
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(state, JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port+'/',
    root,started:Date.now(),maximum_seconds:180,manifest_sha256:sha(fs.readFileSync(path.join(root,'manifest.json')))},null,2)+'\n', {flag:'wx'});
});
const timer = setTimeout(() => {server.close();server.closeAllConnections();}, 180000);
server.on('close', () => clearTimeout(timer));
