require('dotenv').config();

const bcrypt = require('bcryptjs');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const contentSecurityPolicy = {
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    connectSrc: ["'self'", 'https://api.telegram.org', 'https://telegram.org'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    formAction: ["'self'"],
    frameAncestors: ["'self'", 'https://t.me', 'https://telegram.org', 'https://*.telegram.org'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    mediaSrc: ["'self'", 'blob:', 'data:'],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://telegram.org'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
  }
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'screenshots';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Normalize WEBSITE_URL: strip trailing slash, validate format.
const WEBSITE_URL = (() => {
  const raw = (process.env.WEBSITE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) {
    console.warn(
      'WEBSITE_URL is not set. CORS will only allow requests without an Origin header.' +
      ' Set WEBSITE_URL to your deployed service URL (e.g. https://lucky-birr.onrender.com) in the Render dashboard.'
    );
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      console.warn(
        `WEBSITE_URL "${raw}" is not HTTPS. In production, CORS should only allow HTTPS origins.`
      );
    }
    return parsed.origin;
  } catch {
    console.warn(
      `WEBSITE_URL "${raw}" is not a valid URL. CORS will only allow requests without an Origin header.` +
      ' Set WEBSITE_URL to your deployed service URL (e.g. https://lucky-birr.onrender.com) in the Render dashboard.'
    );
    return '';
  }
})();

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Database features will not work.');
}
if (TELEGRAM_BOT_TOKEN && !ADMIN_CHAT_ID) {
  console.warn('TELEGRAM_BOT_TOKEN is set but ADMIN_CHAT_ID is missing. Telegram notifications are disabled. Set ADMIN_CHAT_ID to your Telegram chat/user ID.');
} else if (!TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID) {
  console.warn('ADMIN_CHAT_ID is set but TELEGRAM_BOT_TOKEN is missing. Telegram notifications are disabled. Set TELEGRAM_BOT_TOKEN to your bot token from @BotFather.');
} else if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID is missing. Telegram notifications are disabled.');
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.warn('TELEGRAM_WEBHOOK_SECRET is missing. Webhook endpoint is disabled.');
}
if (!JWT_SECRET) {
  console.warn('JWT_SECRET is missing. Authentication will not work.');
}

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy
  })
);
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
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const submitRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions, please try again later.' }
});

function verifyJWT(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = auth.slice(7);
  if (!JWT_SECRET) {
    return res.status(500).json({ error: 'JWT not configured on server' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_EMAILS.includes((req.user.email || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

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

app.get('/readyz', (_req, res) => {
  const checks = {
    database: Boolean(supabase),
    jwt: Boolean(JWT_SECRET),
    telegram: Boolean(TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID)
  };
  const ready = checks.database && checks.jwt;
  res.status(ready ? 200 : 503).json({ ok: ready, checks });
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

app.post('/api/submit', submitRateLimit, upload.single('screenshot'), async (req, res, next) => {
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
      return res.status(503).json({ error: 'Service temporarily unavailable' });
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
        return res.status(502).json({ error: 'Failed to upload screenshot. Please try again.' });
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
      if (screenshotPath) {
        supabase.storage.from(SUPABASE_BUCKET).remove([screenshotPath]).catch((e) => {
          console.warn('Failed to remove orphaned upload:', e.message);
        });
      }
      return res.status(500).json({ error: 'Failed to save submission. Please try again.' });
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

// ===== AUTH ROUTES =====

app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
  try {
    const { email, phone, password, fullName } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({
        error: 'Password must contain uppercase, lowercase, and a number'
      });
    }

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error: insertError } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        phone: phone || null,
        password_hash: passwordHash,
        full_name: fullName || null,
        balance: 0
      })
      .select('id, email, phone, full_name, balance')
      .single();

    if (insertError) {
      return res.status(500).json({ error: 'Failed to create user' });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'JWT not configured on server' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());

    return res.status(201).json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name,
        balance: user.balance,
        isAdmin
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, phone, full_name, balance, password_hash')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'JWT not configured on server' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name,
        balance: user.balance,
        isAdmin
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/me', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, phone, full_name, balance')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name,
        balance: user.balance,
        isAdmin
      }
    });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', verifyJWT, (_req, res) => {
  return res.json({ ok: true, message: 'Logged out' });
});

// ===== SUBMISSIONS (JWT-protected) =====

app.post('/api/submissions', verifyJWT, submitRateLimit, upload.single('screenshot'), async (req, res, next) => {
  try {
    const { ticketNumber, tier, amount, paymentMethod } = req.body;

    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return res.status(400).json({ error: 'Amount must be a valid positive number' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
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
        console.warn('Screenshot upload failed:', uploadError.message);
        return res.status(502).json({ error: 'Failed to upload screenshot. Please try again.' });
      }

      const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filePath);
      screenshotUrl = publicUrlData?.publicUrl || null;
      screenshotPath = filePath;
    }

    const { data: userRecord } = await supabase
      .from('users')
      .select('full_name, email, phone')
      .eq('id', req.user.id)
      .maybeSingle();

    const { data: submission, error: insertError } = await supabase
      .from('submissions')
      .insert({
        user_id: req.user.id,
        ticket_number: ticketNumber ? Number(ticketNumber) : null,
        tier: tier || null,
        amount: amountNumber,
        payment_method: paymentMethod || 'telebirr',
        screenshot_url: screenshotUrl,
        screenshot_path: screenshotPath,
        status: 'pending'
      })
      .select('id')
      .single();

    if (insertError) {
      console.warn('Submission insert failed:', insertError.message);
      if (screenshotPath) {
        supabase.storage.from(SUPABASE_BUCKET).remove([screenshotPath]).catch((e) => {
          console.warn('Failed to remove orphaned upload:', e.message);
        });
      }
      return res.status(500).json({ error: 'Failed to save submission. Please try again.' });
    }

    const userName = userRecord?.full_name || userRecord?.email || 'Unknown';
    const userPhone = userRecord?.phone || 'N/A';

    const details =
      '📥 New Lucky Birr Submission\n' +
      `👤 User: ${userName}\n` +
      `📧 Email: ${userRecord?.email || 'N/A'}\n` +
      `📞 Phone: ${userPhone}\n` +
      `🎫 Tier: ${tier || 'N/A'}\n` +
      `🎟 Ticket: ${ticketNumber || 'N/A'}\n` +
      `💵 Amount: ${amountNumber} ETB\n` +
      `💳 Payment: ${paymentMethod || 'N/A'}`;

    const notificationSent = await notifyAdmin(details, screenshotUrl);

    return res.status(201).json({
      ok: true,
      submissionId: submission.id,
      message: 'Submission received',
      notificationSent
    });
  } catch (error) {
    return next(error);
  }
});

// ===== ADMIN ROUTES =====

app.get('/api/admin/submissions', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: submissions, error, count } = await supabase
      .from('submissions')
      .select('*, users(email, full_name, phone)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.warn('Admin submissions query failed:', error.message);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    return res.json({ ok: true, submissions: submissions || [], total: count || 0, page });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/submissions/:id/approve', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { id } = req.params;

    const { data: submission, error: fetchError } = await supabase
      .from('submissions')
      .select('*, users(email, full_name)')
      .eq('id', id)
      .maybeSingle();

    if (fetchError || !submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission already processed' });
    }

    const { error: updateError } = await supabase
      .from('submissions')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', id);

    if (updateError) {
      console.warn('Submission approve failed:', updateError.message);
      return res.status(500).json({ error: 'Failed to approve submission' });
    }
    const userName = submission.users?.full_name || submission.users?.email || 'Unknown';
    const details =
      `✅ Submission #${id} APPROVED\n` +
      `👤 User: ${userName}\n` +
      `💵 Amount: ${submission.amount} ETB`;
    await notifyAdmin(details, null);

    return res.json({ ok: true, message: 'Submission approved' });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/admin/submissions/:id/reject', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { id } = req.params;
    const { reason } = req.body;

    const { error: updateError } = await supabase
      .from('submissions')
      .update({ status: 'rejected', admin_notes: reason || null, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (updateError) {
      console.warn('Submission reject failed:', updateError.message);
      return res.status(500).json({ error: 'Failed to reject submission' });
    }

    return res.json({ ok: true, message: 'Submission rejected' });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/admin/stats', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data: stats, error } = await supabase
      .from('submissions')
      .select('status, amount');

    if (error) {
      console.warn('Admin stats query failed:', error.message);
      return res.status(500).json({ error: 'Failed to fetch stats' });
    }

    const approved = stats?.filter((s) => s.status === 'approved') || [];
    const pending = stats?.filter((s) => s.status === 'pending') || [];
    const totalPool = approved.reduce((acc, s) => acc + Number(s.amount), 0);

    return res.json({
      ok: true,
      sold: approved.length,
      pending: pending.length,
      totalPool,
      totalProfit: Math.round(totalPool * 0.25 * 100) / 100,
      submissions: stats?.length || 0
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'Index.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return next();
  }
  return res.sendFile(path.join(__dirname, 'Index.html'));
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lucky Birr server listening on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

function mimeToExtension(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function notifyAdmin(details, screenshotUrl) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
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
