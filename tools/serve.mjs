// A tiny static file server for the tools and checks. Serves `root` (and,
// for the reference pass, an extra directory mounted at /frames/). Plain
// http on localhost counts as a secure context, so the camera API works.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.task': 'application/octet-stream', '.ico': 'image/x-icon',
};

export function serve(root, mounts = {}) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let base = root;
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (p.startsWith(prefix)) { base = dir; p = p.slice(prefix.length - 1); break; }
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(base, path.normalize(p));
    if (!file.startsWith(path.resolve(base))) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      // Range requests: a <video> seeks with them.
      const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? +range[1] : 0;
        const end = range[2] ? +range[2] : st.size - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': st.size });
        fs.createReadStream(file).pipe(res);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
