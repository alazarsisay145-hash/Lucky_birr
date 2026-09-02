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
const rng = require('./lib/rng');
const gameMath = require('./lib/gameMath');

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
const WEBSITE_URL = process.env.WEBSITE_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!WEBSITE_URL) {
  console.warn('WEBSITE_URL is not set. CORS will only allow requests without an Origin header.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Database features will not work.');
}
// Only warn about Telegram when partially configured; fully absent = intentionally disabled.
if (TELEGRAM_BOT_TOKEN && !ADMIN_CHAT_ID) {
  console.warn('TELEGRAM_BOT_TOKEN is set but ADMIN_CHAT_ID is missing. Telegram notifications are disabled.');
}
if (!TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID) {
  console.warn('ADMIN_CHAT_ID is set but TELEGRAM_BOT_TOKEN is missing. Telegram notifications are disabled.');
}
if (TELEGRAM_WEBHOOK_SECRET && !TELEGRAM_BOT_TOKEN) {
  console.warn('TELEGRAM_WEBHOOK_SECRET is set but TELEGRAM_BOT_TOKEN is missing. Webhook will reject all requests.');
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

app.get('/readyz', async (_req, res) => {
  const checks = {
    database: false,
    jwt: Boolean(JWT_SECRET),
    telegram: Boolean(TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID)
  };
  const body = { ok: false, checks };

  if (!supabase) {
    body.detail = 'Supabase not configured – set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY';
  } else {
    try {
      const { error } = await supabase.from('users').select('id').limit(1);
      if (error) {
        if (error.code === '42P01') {
          body.detail = 'users table not found – run supabase.sql in the Supabase SQL Editor';
        } else {
          body.detail = `Database connectivity error (${error.code}) – verify SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`;
        }
      } else {
        checks.database = true;
      }
    } catch (e) {
      body.detail = `Database connectivity failed: ${e.message}`;
    }
  }

  body.ok = checks.database && checks.jwt;
  res.status(body.ok ? 200 : 503).json(body);
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

    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (lookupError) {
      console.error('Supabase user lookup failed during register:', lookupError.code, lookupError.message);
      if (lookupError.code === '42P01') {
        return res.status(500).json({ error: 'Database schema not set up – run supabase.sql in the Supabase SQL Editor' });
      }
      return res.status(500).json({ error: 'Registration service unavailable – database error' });
    }

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
      console.error('Supabase user insert failed:', insertError.code, insertError.message);
      if (insertError.code === '42P01') {
        return res.status(500).json({ error: 'Database schema not set up – run supabase.sql in the Supabase SQL Editor' });
      }
      return res.status(500).json({ error: 'Failed to create user – database error' });
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

    if (error) {
      console.error('Supabase user lookup failed during login:', error.code, error.message);
      if (error.code === '42P01') {
        return res.status(500).json({ error: 'Database schema not set up – run supabase.sql in the Supabase SQL Editor' });
      }
      return res.status(500).json({ error: 'Login service unavailable – database error' });
    }

    if (!user) {
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

// ===== CHAPA PAYMENT =====
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || '';
const CHAPA_API_URL = 'https://api.chapa.co/v1';

if (!CHAPA_SECRET_KEY) {
  console.warn('CHAPA_SECRET_KEY is missing. Payment gateway features will not work.');
}

async function chapaRequest(endpoint, method, body) {
  const response = await fetch(`${CHAPA_API_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: 'Chapa ' + CHAPA_SECRET_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

// ===== DEPOSIT – INITIALIZE =====
app.post('/api/deposits/initialize', verifyJWT, async (req, res, next) => {
  try {
    if (!CHAPA_SECRET_KEY) {
      return res.status(503).json({ error: 'Payment gateway not configured' });
    }
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { amount, currency = 'ETB', return_url } = req.body;
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 10) {
      return res.status(400).json({ error: 'Minimum deposit amount is 10 ETB' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('email, full_name, phone')
      .eq('id', req.user.id)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const tx_ref = `LB-DEP-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const chapaBody = {
      amount: amountNum.toString(),
      currency,
      email: user.email,
      first_name: (user.full_name || 'Player').split(' ')[0],
      last_name: (user.full_name || 'Player').split(' ').slice(1).join(' ') || 'User',
      phone_number: user.phone || '',
      tx_ref,
      callback_url: `${process.env.WEBSITE_URL || ''}/api/deposits/callback`,
      return_url: return_url || `${process.env.WEBSITE_URL || ''}/`,
      customization: { title: 'Lucky Birr Deposit', description: 'Wallet deposit' }
    };

    const { ok, data: chapaData } = await chapaRequest('/transaction/initialize', 'POST', chapaBody);
    if (!ok || chapaData.status !== 'success') {
      console.warn('Chapa initialize failed:', chapaData);
      return res.status(502).json({ error: 'Payment initialization failed. Please try again.' });
    }

    // Record pending deposit in DB
    await supabase.from('deposits').insert({
      user_id: req.user.id,
      amount: amountNum,
      tx_ref,
      status: 'pending',
      checkout_url: chapaData.data?.checkout_url || null
    });

    return res.json({ ok: true, checkout_url: chapaData.data?.checkout_url, tx_ref });
  } catch (err) {
    return next(err);
  }
});

// ===== DEPOSIT – CALLBACK (Chapa webhook) =====
app.post('/api/deposits/callback', async (req, res) => {
  try {
    // Verify this came from Chapa using a shared webhook secret
    const webhookSecret = process.env.CHAPA_WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const signature = req.headers['chapa-signature'] || '';
      if (signature !== webhookSecret) {
        return res.sendStatus(403);
      }
    }

    const { tx_ref, status } = req.body;
    if (!tx_ref || typeof tx_ref !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tx_ref)) {
      return res.sendStatus(400);
    }
    if (!supabase) return res.sendStatus(503);

    const { data: dep } = await supabase
      .from('deposits')
      .select('*')
      .eq('tx_ref', tx_ref)
      .maybeSingle();

    if (!dep) return res.sendStatus(404);
    if (dep.status === 'completed') return res.sendStatus(200);

    // Always use the tx_ref stored in DB (not user input) for the Chapa verify URL
    const safeTxRef = dep.tx_ref;

    if (status === 'success') {
      // Verify with Chapa before crediting
      const { ok, data: verifyData } = await chapaRequest(`/transaction/verify/${safeTxRef}`, 'GET');
      if (ok && verifyData.status === 'success' && verifyData.data?.status === 'success') {
        await supabase.from('deposits').update({ status: 'completed' }).eq('tx_ref', safeTxRef);
        // Credit user balance
        await supabase.rpc('credit_balance', { uid: dep.user_id, delta: dep.amount });
        // Record transaction
        await supabase.from('transactions').insert({
          user_id: dep.user_id,
          amount: dep.amount,
          type: 'deposit',
          description: `Deposit via Chapa (${safeTxRef})`
        });
        await notifyAdmin(`💰 Deposit confirmed\nUser: ${dep.user_id}\nAmount: ${dep.amount} ETB\nRef: ${safeTxRef}`, null);
      } else {
        await supabase.from('deposits').update({ status: 'failed' }).eq('tx_ref', safeTxRef);
      }
    } else {
      await supabase.from('deposits').update({ status: 'failed' }).eq('tx_ref', safeTxRef);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('Deposit callback error:', err.message);
    return res.sendStatus(500);
  }
});

// ===== DEPOSIT – MANUAL (screenshot upload, for non-Chapa) =====
app.post('/api/deposits/manual', verifyJWT, submitRateLimit, upload.single('screenshot'), async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { amount, payment_method } = req.body;
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 10) {
      return res.status(400).json({ error: 'Minimum deposit is 10 ETB' });
    }
    const allowed = ['telebirr', 'dashen', 'cbe'];
    if (!allowed.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    let screenshotUrl = null;
    let screenshotPath = null;
    if (req.file) {
      const ext = mimeToExtension(req.file.mimetype);
      const filePath = `deposits/${Date.now()}-${randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false
      });
      if (upErr) return res.status(502).json({ error: 'Screenshot upload failed' });
      const { data: urlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(filePath);
      screenshotUrl = urlData?.publicUrl || null;
      screenshotPath = filePath;
    }

    const tx_ref = `LB-MAN-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const { data: dep, error: insErr } = await supabase.from('deposits').insert({
      user_id: req.user.id,
      amount: amountNum,
      tx_ref,
      payment_method,
      screenshot_url: screenshotUrl,
      screenshot_path: screenshotPath,
      status: 'pending'
    }).select('id').single();

    if (insErr) return res.status(500).json({ error: 'Failed to record deposit request' });

    await notifyAdmin(
      `💳 Manual Deposit Request\nUser: ${req.user.id}\nAmount: ${amountNum} ETB\nMethod: ${payment_method}\nRef: ${tx_ref}`,
      screenshotUrl
    );

    return res.status(201).json({ ok: true, depositId: dep.id, message: 'Deposit request received. Admin will confirm shortly.' });
  } catch (err) {
    return next(err);
  }
});

// ===== ADMIN – APPROVE MANUAL DEPOSIT =====
app.post('/api/admin/deposits/:id/approve', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { id } = req.params;

    const { data: dep } = await supabase.from('deposits').select('*').eq('id', id).maybeSingle();
    if (!dep) return res.status(404).json({ error: 'Deposit not found' });
    if (dep.status !== 'pending') return res.status(400).json({ error: 'Deposit already processed' });

    await supabase.from('deposits').update({ status: 'completed' }).eq('id', id);
    await supabase.rpc('credit_balance', { uid: dep.user_id, delta: dep.amount });
    await supabase.from('transactions').insert({
      user_id: dep.user_id,
      amount: dep.amount,
      type: 'deposit',
      description: `Manual deposit approved (${dep.tx_ref})`
    });

    return res.json({ ok: true, message: 'Deposit approved and balance credited' });
  } catch (err) {
    return next(err);
  }
});

// ===== WITHDRAWAL REQUEST =====
app.post('/api/withdrawals', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { amount, payment_method, account_number, account_name } = req.body;
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 50) {
      return res.status(400).json({ error: 'Minimum withdrawal is 50 ETB' });
    }
    const allowed = ['telebirr', 'dashen', 'cbe'];
    if (!allowed.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }
    if (!account_number || !account_name) {
      return res.status(400).json({ error: 'Account number and name are required' });
    }

    // Check balance
    const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amountNum) return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct balance (hold)
    const { error: deductErr } = await supabase.rpc('debit_balance', { uid: req.user.id, delta: amountNum });
    if (deductErr) return res.status(400).json({ error: 'Insufficient balance or balance error' });

    const { data: wd, error: insErr } = await supabase.from('withdrawals').insert({
      user_id: req.user.id,
      amount: amountNum,
      payment_method,
      account_number,
      account_name,
      status: 'pending'
    }).select('id').single();

    if (insErr) {
      // Refund the held balance
      await supabase.rpc('credit_balance', { uid: req.user.id, delta: amountNum });
      return res.status(500).json({ error: 'Failed to create withdrawal request' });
    }

    await supabase.from('transactions').insert({
      user_id: req.user.id,
      amount: -amountNum,
      type: 'withdrawal',
      description: `Withdrawal request via ${payment_method}`
    });

    await notifyAdmin(
      `💸 Withdrawal Request\nUser: ${req.user.id}\nAmount: ${amountNum} ETB\nMethod: ${payment_method}\nAccount: ${account_number} (${account_name})`,
      null
    );

    return res.status(201).json({ ok: true, withdrawalId: wd.id, message: 'Withdrawal request submitted. Will be processed within 24h.' });
  } catch (err) {
    return next(err);
  }
});

// ===== ADMIN – PROCESS WITHDRAWAL =====
app.post('/api/admin/withdrawals/:id/complete', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { id } = req.params;
    const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', id).maybeSingle();
    if (!wd) return res.status(404).json({ error: 'Withdrawal not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    await supabase.from('withdrawals').update({ status: 'completed' }).eq('id', id);
    return res.json({ ok: true, message: 'Withdrawal marked as completed' });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/admin/withdrawals/:id/reject', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { id } = req.params;
    const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', id).maybeSingle();
    if (!wd) return res.status(404).json({ error: 'Withdrawal not found' });
    if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    await supabase.from('withdrawals').update({ status: 'rejected' }).eq('id', id);
    // Refund balance
    await supabase.rpc('credit_balance', { uid: wd.user_id, delta: wd.amount });
    await supabase.from('transactions').insert({
      user_id: wd.user_id,
      amount: wd.amount,
      type: 'withdrawal_refund',
      description: 'Withdrawal rejected – balance refunded'
    });
    return res.json({ ok: true, message: 'Withdrawal rejected and balance refunded' });
  } catch (err) {
    return next(err);
  }
});

// ===== GAME BET (server-authoritative engine) =====
// All wager validation, RNG, payout math, and balance mutation happen here.
// The browser only ever renders the `result` this endpoint returns.
const GAME_CONFIGS = {
  keno: { minBet: 5, maxBet: 500 },
  higher_lower: { minBet: 5, maxBet: 500 },
  aviator: { minBet: 5, maxBet: 1000 }
};

const gameBetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bets, please slow down.' }
});

/**
 * Computes a single round's outcome and payout (in integer cents) using only
 * server-controlled, cryptographically secure randomness and the fixed,
 * versioned paytables in lib/gameMath.js. Throws an Error with `.status` for
 * validation failures so the caller can respond appropriately without ever
 * touching the database.
 */
function computeGameOutcome(game, stakeCents, body) {
  if (game === 'keno') {
    const picks = Array.isArray(body.picks) ? [...new Set(body.picks.map(Number))] : [];
    if (picks.length < 1 || picks.length > 10 || picks.some((n) => !Number.isInteger(n) || n < 1 || n > 80)) {
      const err = new Error('Pick 1–10 distinct numbers between 1 and 80');
      err.status = 400;
      throw err;
    }
    const pool = Array.from({ length: gameMath.KENO_TOTAL }, (_, i) => i + 1);
    const drawn = rng.secureSample(pool, gameMath.KENO_DRAWN);
    const hits = picks.filter((n) => drawn.includes(n)).length;
    const multiplier = gameMath.kenoPayoutMultiplier(picks.length, hits);
    const payoutCents = Math.round(stakeCents * multiplier);
    const result = {
      drawn: [...drawn].sort((a, b) => a - b),
      picks,
      hits,
      multiplier,
      payout: gameMath.fromCents(payoutCents)
    };
    return { payoutCents, result, rngMeta: { drawCount: drawn.length } };
  }

  if (game === 'higher_lower') {
    const guess = body.guess;
    if (guess !== 'higher' && guess !== 'lower') {
      const err = new Error('guess must be "higher" or "lower"');
      err.status = 400;
      throw err;
    }
    const clientPrevCard = Number(body.prev_card);
    const prev_card = (Number.isInteger(clientPrevCard) && clientPrevCard >= 1 && clientPrevCard <= gameMath.HL_RANKS)
      ? clientPrevCard
      : rng.secureInt(1, gameMath.HL_RANKS + 1);
    const multiplier = gameMath.higherLowerMultiplier(prev_card, guess);
    if (multiplier === null) {
      const err = new Error('This guess cannot win from the current card. Choose the other side.');
      err.status = 400;
      throw err;
    }
    const next_card = rng.secureInt(1, gameMath.HL_RANKS + 1);
    const actual = next_card > prev_card ? 'higher' : next_card < prev_card ? 'lower' : 'equal';
    const won = actual !== 'equal' && guess === actual;
    const pushed = actual === 'equal';
    const payoutCents = won ? Math.round(stakeCents * multiplier) : (pushed ? stakeCents : 0);
    const result = { prev_card, next_card, guess, actual, won, pushed, payout: gameMath.fromCents(payoutCents) };
    return { payoutCents, result, rngMeta: { prev_card, next_card } };
  }

  if (game === 'aviator') {
    const r = rng.secureUnitFloat();
    const crash_at = gameMath.aviatorCrashPoint(r);
    const requested = Number(body.cashout_at);
    const cashoutNum = Math.min(
      gameMath.AVIATOR_MAX_MULTIPLIER,
      Math.max(gameMath.AVIATOR_MIN_MULTIPLIER, Number.isFinite(requested) ? requested : gameMath.AVIATOR_MIN_MULTIPLIER)
    );
    const won = cashoutNum <= crash_at;
    const payoutCents = won ? Math.round(stakeCents * cashoutNum) : 0;
    const result = { crash_at, cashout_at: cashoutNum, won, payout: gameMath.fromCents(payoutCents) };
    return { payoutCents, result, rngMeta: {} };
  }

  const err = new Error('Invalid game');
  err.status = 400;
  throw err;
}

app.post('/api/games/bet', gameBetRateLimit, verifyJWT, async (req, res, next) => {
  try {
    const { game, bet_amount } = req.body || {};
    if (!GAME_CONFIGS[game]) return res.status(400).json({ error: 'Invalid game' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const cfg = GAME_CONFIGS[game];
    const betNum = Number(bet_amount);
    if (!Number.isFinite(betNum) || betNum < cfg.minBet || betNum > cfg.maxBet) {
      return res.status(400).json({ error: `Bet must be between ${cfg.minBet} and ${cfg.maxBet} ETB` });
    }
    const stakeCents = gameMath.toCents(betNum);
    if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    // Idempotency key: a client-supplied header lets safe retries (e.g. a
    // dropped response after the server already settled the round) return
    // the original result instead of debiting/crediting twice. If the client
    // does not send one, generate a single-use key so this request is still
    // internally atomic (no cross-retry protection, but no double-processing
    // within this single call either).
    const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').slice(0, 128) || randomUUID();

    let outcome;
    try {
      outcome = computeGameOutcome(game, stakeCents, req.body || {});
    } catch (validationErr) {
      if (validationErr.status) return res.status(validationErr.status).json({ error: validationErr.message });
      throw validationErr;
    }

    const { data: rpcRows, error: rpcErr } = await supabase.rpc('settle_game_round', {
      p_user_id: req.user.id,
      p_game: game,
      p_math_version: gameMath.MATH_VERSION,
      p_idempotency_key: idempotencyKey,
      p_stake_cents: stakeCents,
      p_payout_cents: outcome.payoutCents,
      p_outcome: outcome.result,
      p_rng_meta: outcome.rngMeta
    });
    if (rpcErr) {
      const msg = /insufficient/i.test(rpcErr.message || '') ? 'Insufficient balance' : 'Bet could not be settled';
      return res.status(400).json({ error: msg });
    }
    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (!row) return res.status(500).json({ error: 'Bet could not be settled' });

    const balance = gameMath.fromCents(row.balance_after_cents);
    return res.json({ ok: true, result: outcome.result, balance, replayed: Boolean(row.replayed) });
  } catch (err) {
    return next(err);
  }
});

// ===== GAME RULES / RTP DISCLOSURE =====
app.get('/api/games/rules', (_req, res) => {
  res.json({
    ok: true,
    math_version: gameMath.MATH_VERSION,
    target_rtp: gameMath.TARGET_RTP,
    demo_mode: true,
    games: {
      keno: {
        pool: gameMath.KENO_TOTAL,
        draw_count: gameMath.KENO_DRAWN,
        paytables: Object.fromEntries(
          Object.values(gameMath.KENO_TABLES).map((t) => [t.picks, { multipliers: t.multipliers, rtp: t.achievedRtp }])
        )
      },
      higher_lower: {
        ranks: gameMath.HL_RANKS,
        tie_rule: 'equal rank is a push — stake fully refunded',
        target_rtp_conditional_on_decisive_outcome: gameMath.TARGET_RTP
      },
      aviator: {
        target_rtp: gameMath.TARGET_RTP,
        max_multiplier: gameMath.AVIATOR_MAX_MULTIPLIER,
        min_multiplier: gameMath.AVIATOR_MIN_MULTIPLIER
      }
    }
  });
});

// ===== TRANSACTION HISTORY =====
app.get('/api/transactions', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: 'Failed to fetch transactions' });
    return res.json({ ok: true, transactions: data || [], total: count || 0, page });
  } catch (err) {
    return next(err);
  }
});

// ===== BALANCE =====
app.get('/api/balance', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true, balance: user.balance });
  } catch (err) {
    return next(err);
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

// The app shell carries all client-side auth JavaScript inline, so it must never
// be served from a stale browser/proxy cache after a deploy.
function sendAppShell(res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.sendFile(path.join(__dirname, 'Index.html'));
}

app.get('/', (_req, res) => sendAppShell(res));
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return next();
  }
  return sendAppShell(res);
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
