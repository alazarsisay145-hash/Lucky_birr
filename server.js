'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const INDEX_FILE = 'Index.html';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// Resolve and validate a URL pathname against a safe root directory.
// Returns null if the resolved path escapes the root (path traversal guard).
function safeResolve(root, urlPathname) {
  const resolved = path.join(root, path.normalize(urlPathname));
  if (!resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

const server = http.createServer((req, res) => {
  // Health check endpoint for Render
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // Extract only the pathname (drops query string, hash, etc.)
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Default to INDEX_FILE (SPA entry point)
  const urlPath = pathname === '/' ? `/${INDEX_FILE}` : pathname;

  const filePath = safeResolve(__dirname, urlPath);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to INDEX_FILE for SPA routing
      fs.readFile(path.join(__dirname, INDEX_FILE), (err2, htmlData) => {
        if (err2) {
          res.writeHead(500);
          res.end('Server error');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlData);
      });
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Lucky Birr running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
