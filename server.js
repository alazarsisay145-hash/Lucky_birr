const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// security + logging
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// health check
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// telegram webhook
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'telegram-secret';
const WEBHOOK_PATH = `/webhook/${WEBHOOK_SECRET}`;

app.post(WEBHOOK_PATH, async (req, res, next) => {
  try {
    const update = req.body;
    res.sendStatus(200); // acknowledge quickly

    const chatId = update?.message?.chat?.id;
    const text = update?.message?.text;

    if (BOT_TOKEN && chatId && text) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `You said: ${text}` })
      });
    }
  } catch (e) {
    next(e);
  }
});

// serve mini app static files
app.use(express.static(__dirname));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/webhook/') || req.path === '/healthz') return next();
  res.sendFile(path.join(__dirname, 'Index.html'));
});

// error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(PORT, () => {
  console.log(`Lucky Birr server running on port ${PORT}`);
  console.log(`Telegram webhook path: ${WEBHOOK_PATH}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
