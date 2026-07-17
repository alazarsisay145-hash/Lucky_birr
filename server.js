require('dotenv').config();

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'screenshots';
const WEBSITE_URL = process.env.WEBSITE_URL || '';

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!WEBSITE_URL) {
  console.warn('WEBSITE_URL is not set. CORS will only allow requests without an Origin header.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. /api/submit will not work.');
}
if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID is missing. Telegram notifications are disabled.');
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.warn('TELEGRAM_WEBHOOK_SECRET is missing. Webhook endpoint is disabled.');
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (!WEBSITE_URL) return callback(null, false);
      if (origin === WEBSITE_URL) return callback(null, true);
      return callback(new Error('CORS not allowed'));
    }
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Only png, jpg, jpeg, and webp images are allowed'));
    }
    return cb(null, true);
  }
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

app.post('/webhook/:secret', async (req, res) => {
  if (!TELEGRAM_WEBHOOK_SECRET || req.params.secret !== TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const chatId = req.body?.message?.chat?.id;
    const text = req.body?.message?.text;

    if (TELEGRAM_BOT_TOKEN && chatId && text === '/start') {
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: '✅ Lucky Birr bot is online.'
      });
    }
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
  }
});

app.post('/api/submit', upload.single('screenshot'), async (req, res, next) => {
  try {
    const { fullName, phone, ticketNumber, amount } = req.body;

    if (!fullName || !phone || !ticketNumber || !amount) {
      return res.status(400).json({ error: 'fullName, phone, ticketNumber, and amount are required' });
    }

    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({ error: 'amount must be a valid positive number' });
    }

    if (!supabase) {
      return res.status(500).json({
        error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
      });
    }

    let screenshotUrl = null;
    let screenshotPath = null;

    if (req.file) {
      const ext = mimeToExtension(req.file.mimetype);
      const filePath = `uploads/${Date.now()}-${randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.warn('Supabase storage upload failed:', uploadError.message);
        return res.status(502).json({
          error: `Failed to upload screenshot to bucket "${SUPABASE_BUCKET}". ${uploadError.message}`
        });
      }

      const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filePath);
      screenshotUrl = publicUrlData?.publicUrl || null;
      screenshotPath = filePath;
    }

    const { data: submission, error: insertError } = await supabase
      .from('submissions')
      .insert({
        full_name: fullName,
        phone,
        ticket_number: ticketNumber,
        amount: amountNumber,
        status: 'pending',
        screenshot_url: screenshotUrl,
        screenshot_path: screenshotPath
      })
      .select()
      .single();

    if (insertError) {
      console.warn('Supabase submission insert failed:', insertError.message);
      return res.status(500).json({
        error: `Failed to save submission for approval. ${insertError.message}`
      });
    }

    const details =
      '📥 New Lucky Birr Submission\n' +
      `👤 Name: ${fullName}\n` +
      `📞 Phone: ${phone}\n` +
      `🎟 Ticket: ${ticketNumber}\n` +
      `💵 Amount: ${amountNumber}`;

    const notificationSent = await notifyAdmin(details, screenshotUrl);

    return res.status(201).json({
      ok: true,
      message: 'Submission received and waiting for approval.',
      notificationSent,
      submission
    });
  } catch (error) {
    return next(error);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return next();
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (err.message === 'CORS not allowed') {
    return res.status(403).json({ error: 'CORS not allowed' });
  }

  console.error('Unhandled error:', err.message);
  return res.status(err.statusCode || 500).json({
    error: err.statusCode ? err.message : 'Internal Server Error'
  });
});

const server = app.listen(PORT, () => {
  console.log(`Lucky Birr server listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

function mimeToExtension(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function notifyAdmin(details, screenshotUrl) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !ADMIN_CHAT_ID) {
    return false;
  }

  try {
    if (screenshotUrl) {
      await telegramRequest('sendPhoto', {
        chat_id: ADMIN_CHAT_ID,
        photo: screenshotUrl,
        caption: details
      });
      return true;
    }

    await telegramRequest('sendMessage', {
      chat_id: ADMIN_CHAT_ID,
      text: details
    });
    return true;
  } catch (error) {
    console.warn('Telegram notification failed:', error.message);
    return false;
  }
}

async function telegramRequest(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const rawBody = await response.text();
  let data = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch (_error) {
      data = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Telegram API ${method} failed with status ${response.status} ${response.statusText}. ${rawBody || ''}`.trim()
    );
  }

  if (!data || !data.ok) {
    throw new Error(data?.description || 'Telegram API error');
  }

  return data;
}
