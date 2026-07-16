const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const indexPath = path.join(__dirname, 'index.html');
const pageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get(['/', '/index.html'], pageLimiter, (req, res) => {
  res.sendFile(indexPath);
});

app.get('*', pageLimiter, (req, res) => {
  if (path.extname(req.path)) {
    console.warn(`Missing asset request: ${req.path}`);
    res.status(404).end();
    return;
  }
  res.sendFile(indexPath);
});

app.listen(PORT, () => {
  console.log(`Lucky Birr running on port ${PORT}`);
});
