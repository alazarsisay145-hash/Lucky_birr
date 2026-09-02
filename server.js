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
const { randomUUID, timingSafeEqual, createHmac } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const rng = require('./lib/rng');
const gameMath = require('./lib/gameMath');
const fastKeno = require('./lib/fastKeno');
const paymentDestinations = require('./lib/paymentDestinations');

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
// The raw body is retained so webhook signatures can be verified against the
// exact bytes the provider signed.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
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
      // Surfaced as a 400 rather than a 500: an unsupported upload is a client
      // error, and the message is safe to show.
      const err = new Error('Only png, jpg, jpeg, and webp images are allowed');
      err.statusCode = 400;
      return cb(err);
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

// ===== CHAPA PAYMENT (legacy, disabled unless explicitly enabled) =====
// The product runs on the manual deposit/withdrawal workflow. The automatic
// gateway stays in the codebase but every route is inert unless an operator
// sets CHAPA_ENABLED=true *and* provides a secret key, so a stray callback or
// browser request can never move money on a manual-only deployment.
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || '';
const CHAPA_API_URL = 'https://api.chapa.co/v1';
const CHAPA_ENABLED = process.env.CHAPA_ENABLED === 'true' && Boolean(CHAPA_SECRET_KEY);

if (process.env.CHAPA_ENABLED === 'true' && !CHAPA_SECRET_KEY) {
  console.warn('CHAPA_ENABLED is true but CHAPA_SECRET_KEY is missing. Automatic deposits stay disabled.');
}

// Wallet limits are deploy-time configuration only — they are never read from
// the request body, so a browser can not widen its own limits.
function envAmount(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const WALLET_LIMITS = {
  depositMin: envAmount('DEPOSIT_MIN_ETB', 10),
  depositMax: envAmount('DEPOSIT_MAX_ETB', 50000),
  withdrawMin: envAmount('WITHDRAW_MIN_ETB', 50),
  withdrawMax: envAmount('WITHDRAW_MAX_ETB', 25000)
};

const PAYMENT_METHODS = ['telebirr', 'dashen', 'cbe'];

// ===== MANUAL PAYMENT DESTINATIONS =====
// Parsed and validated once, at startup, from server-side configuration only.
const manualPaymentConfig = paymentDestinations.loadDestinations();
manualPaymentConfig.warnings.forEach((warning) => console.warn(warning));
const MANUAL_PAYMENT_DESTINATIONS = manualPaymentConfig.destinations;
const MANUAL_DESTINATION_BY_ID = new Map(MANUAL_PAYMENT_DESTINATIONS.map((d) => [d.id, d]));
// Proof screenshots live in their own private bucket so they can never be
// enumerated or read without a short-lived, server-issued signed URL.
const MANUAL_PROOF_BUCKET = process.env.MANUAL_PROOF_BUCKET || 'deposit-proofs';
const PROOF_SIGNED_URL_TTL_SECONDS = 300;
const MANUAL_DEPOSIT_NOTICE =
  'Transfer the money yourself using one of the accounts above, then submit your receipt here. ' +
  'Proof is verified manually by an operator — submitting it does not credit your wallet and does not guarantee approval.';

const proofUploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many proof uploads, please try again later.' }
});

const walletRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wallet requests, please try again later.' }
});

function requestIdempotencyKey(req) {
  const raw = req.headers['idempotency-key'] || (req.body && req.body.idempotency_key) || '';
  const key = String(raw).slice(0, 128).trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(key) ? key : null;
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

/**
 * Verifies a deposit with Chapa and, only when the provider confirms a
 * successful payment for the *stored* amount, credits the wallet exactly once
 * through the `complete_deposit` transaction. Returns the resulting status.
 * Never trusts anything supplied by the browser or the callback body.
 */
async function verifyAndCreditDeposit(txRef) {
  const { data: dep } = await supabase
    .from('deposits')
    .select('id, user_id, amount, tx_ref, status')
    .eq('tx_ref', txRef)
    .maybeSingle();

  if (!dep) return { found: false };
  if (dep.status !== 'pending') return { found: true, status: dep.status, credited: false, deposit: dep };

  const { ok, data: verifyData } = await chapaRequest(`/transaction/verify/${encodeURIComponent(dep.tx_ref)}`, 'GET');
  const providerStatus = verifyData && verifyData.data ? verifyData.data.status : null;
  const verifiedAmount = Number(verifyData && verifyData.data ? verifyData.data.amount : NaN);

  if (!ok || verifyData.status !== 'success' || providerStatus !== 'success') {
    // Only mark failed when the provider is explicit about it; transient
    // errors leave the deposit pending so it can be retried/reconciled.
    if (providerStatus === 'failed' || providerStatus === 'cancelled') {
      await supabase.from('deposits').update({ status: 'failed' }).eq('id', dep.id).eq('status', 'pending');
      return { found: true, status: 'failed', credited: false, deposit: dep };
    }
    return { found: true, status: 'pending', credited: false, deposit: dep };
  }

  // Guard against a provider amount that does not match what we recorded.
  if (Number.isFinite(verifiedAmount) && Math.round(verifiedAmount * 100) !== Math.round(Number(dep.amount) * 100)) {
    console.warn('Deposit amount mismatch for tx_ref', dep.tx_ref);
    await supabase.from('deposits').update({ status: 'failed' }).eq('id', dep.id).eq('status', 'pending');
    return { found: true, status: 'failed', credited: false, deposit: dep };
  }

  const { data: rows, error } = await supabase.rpc('complete_deposit', { p_tx_ref: dep.tx_ref });
  if (error) {
    console.warn('complete_deposit failed:', error.message);
    return { found: true, status: 'pending', credited: false, deposit: dep };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  const credited = Boolean(row && row.credited);
  if (credited) {
    await notifyAdmin(`💰 Deposit confirmed\nUser: ${dep.user_id}\nAmount: ${dep.amount} ETB\nRef: ${dep.tx_ref}`, null);
  }
  return { found: true, status: 'completed', credited, deposit: dep };
}

// ===== DEPOSIT – INITIALIZE =====
app.post('/api/deposits/initialize', verifyJWT, walletRateLimit, async (req, res, next) => {
  try {
    const { amount, currency = 'ETB', return_url } = req.body || {};
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < WALLET_LIMITS.depositMin || amountNum > WALLET_LIMITS.depositMax) {
      return res.status(400).json({
        error: `Deposit must be between ${WALLET_LIMITS.depositMin} and ${WALLET_LIMITS.depositMax} ETB`
      });
    }
    if (currency !== 'ETB') {
      return res.status(400).json({ error: 'Only ETB deposits are supported' });
    }
    if (!CHAPA_ENABLED) {
      return res.status(503).json({ error: 'Automatic deposits are disabled. Please use the manual deposit flow.' });
    }
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('email, full_name, phone')
      .eq('id', req.user.id)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const tx_ref = `LB-DEP-${req.user.id.slice(0, 8)}-${Date.now()}`;
    // Only allow a return URL that points back at this deployment so the
    // endpoint can not be used as an open redirect.
    const siteUrl = process.env.WEBSITE_URL || '';
    const safeReturnUrl = typeof return_url === 'string' && siteUrl && return_url.startsWith(siteUrl)
      ? return_url
      : `${siteUrl}/`;

    // The pending row is written *before* the provider call so a fast callback
    // always finds a record to reconcile against.
    const { error: pendingErr } = await supabase.from('deposits').insert({
      user_id: req.user.id,
      amount: amountNum,
      tx_ref,
      status: 'pending'
    });
    if (pendingErr) {
      console.warn('Deposit record failed:', pendingErr.message);
      return res.status(500).json({ error: 'Could not start the deposit. Please try again.' });
    }

    const chapaBody = {
      amount: amountNum.toString(),
      currency,
      email: user.email,
      first_name: (user.full_name || 'Player').split(' ')[0],
      last_name: (user.full_name || 'Player').split(' ').slice(1).join(' ') || 'User',
      phone_number: user.phone || '',
      tx_ref,
      callback_url: `${siteUrl}/api/deposits/callback`,
      return_url: safeReturnUrl,
      customization: { title: 'Lucky Birr Deposit', description: 'Wallet deposit' }
    };

    const { ok, data: chapaData } = await chapaRequest('/transaction/initialize', 'POST', chapaBody);
    if (!ok || chapaData.status !== 'success') {
      // Never log the full provider payload — it can contain customer data.
      console.warn('Chapa initialize failed with status:', chapaData && chapaData.status);
      await supabase.from('deposits').update({ status: 'cancelled' }).eq('tx_ref', tx_ref).eq('status', 'pending');
      return res.status(502).json({ error: 'Payment initialization failed. Please try again.' });
    }

    await supabase
      .from('deposits')
      .update({ checkout_url: chapaData.data?.checkout_url || null })
      .eq('tx_ref', tx_ref);

    return res.json({ ok: true, checkout_url: chapaData.data?.checkout_url, tx_ref });
  } catch (err) {
    return next(err);
  }
});

// ===== DEPOSIT – CALLBACK (Chapa webhook) =====
// Idempotent by construction: the credit happens inside `complete_deposit`,
// which only transitions a deposit out of `pending` once. Replayed or
// duplicated callbacks therefore return 200 without crediting again.
app.post('/api/deposits/callback', async (req, res) => {
  try {
    // Chapa signs the raw request body with HMAC-SHA256 keyed on the webhook
    // secret and sends the hex digest in the header.
    const webhookSecret = process.env.CHAPA_WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const signature = String(req.headers['chapa-signature'] || req.headers['x-chapa-signature'] || '');
      const expected = createHmac('sha256', webhookSecret)
        .update(req.rawBody || Buffer.alloc(0))
        .digest('hex');
      const received = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (received.length !== expectedBuf.length || !timingSafeEqual(received, expectedBuf)) {
        return res.sendStatus(403);
      }
    }

    const { tx_ref, status } = req.body || {};
    if (!tx_ref || typeof tx_ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tx_ref)) {
      return res.sendStatus(400);
    }
    // A callback can never credit anything while the gateway is switched off.
    if (!CHAPA_ENABLED) return res.sendStatus(503);
    if (!supabase) return res.sendStatus(503);

    if (status === 'failed' || status === 'cancelled') {
      // A negative callback is only a hint — still confirm with the provider
      // before writing a terminal state, and never credit on it.
      await verifyAndCreditDeposit(tx_ref);
      return res.sendStatus(200);
    }

    const outcome = await verifyAndCreditDeposit(tx_ref);
    if (!outcome.found) return res.sendStatus(404);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Deposit callback error:', err.message);
    return res.sendStatus(500);
  }
});

// ===== DEPOSIT – SERVER-VERIFIED STATUS =====
// The browser calls this after returning from the Chapa checkout page. The
// answer always comes from a fresh provider verification plus our own record —
// the client can not assert that a payment succeeded.
app.get('/api/deposits/:txRef/status', verifyJWT, walletRateLimit, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const txRef = String(req.params.txRef || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(txRef)) return res.status(400).json({ error: 'Invalid reference' });

    const { data: dep } = await supabase
      .from('deposits')
      .select('id, user_id, amount, status, tx_ref, created_at')
      .eq('tx_ref', txRef)
      .maybeSingle();
    if (!dep || dep.user_id !== req.user.id) return res.status(404).json({ error: 'Deposit not found' });

    let status = dep.status;
    if (status === 'pending' && CHAPA_ENABLED) {
      const outcome = await verifyAndCreditDeposit(dep.tx_ref);
      status = outcome.status || status;
    }
    return res.json({ ok: true, tx_ref: dep.tx_ref, amount: dep.amount, status });
  } catch (err) {
    return next(err);
  }
});

// ===== MANUAL PAYMENTS – PUBLIC DESTINATION LIST =====
// Read-only. Returns just the details a player needs in order to transfer the
// money; the configuration itself never leaves the server and nothing here can
// be written from a request.
app.get('/api/payment/destinations', verifyJWT, (_req, res) => {
  res.json({
    ok: true,
    destinations: paymentDestinations.publicView(MANUAL_PAYMENT_DESTINATIONS),
    chapa_enabled: CHAPA_ENABLED,
    limits: {
      deposit_min: WALLET_LIMITS.depositMin,
      deposit_max: WALLET_LIMITS.depositMax,
      withdraw_min: WALLET_LIMITS.withdrawMin,
      withdraw_max: WALLET_LIMITS.withdrawMax
    },
    notice: MANUAL_DEPOSIT_NOTICE
  });
});

const PROOF_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const SENDER_REFERENCE_PATTERN = /^[A-Za-z0-9+\-_. ]{4,64}$/;
const EXTERNAL_REFERENCE_PATTERN = /^[A-Za-z0-9\-_.]{4,64}$/;

/**
 * Validates a manual deposit payload. Everything the wallet later relies on
 * (amount, destination, references) is derived here from server-side rules, so
 * the browser can only ever choose between configured destinations.
 */
function validateManualDepositPayload(body) {
  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum < WALLET_LIMITS.depositMin || amountNum > WALLET_LIMITS.depositMax) {
    return { error: `Deposit must be between ${WALLET_LIMITS.depositMin} and ${WALLET_LIMITS.depositMax} ETB` };
  }

  const destinationId = String(body.destination_id || '').trim().toLowerCase();
  const destination = MANUAL_DESTINATION_BY_ID.get(destinationId);
  if (!destination) {
    return { error: 'Choose one of the listed payment destinations' };
  }

  const senderReference = String(body.sender_reference || '').trim();
  if (!SENDER_REFERENCE_PATTERN.test(senderReference)) {
    return { error: 'Enter the phone number or account you sent the money from' };
  }

  const externalRaw = String(body.external_reference || '').trim();
  if (externalRaw && !EXTERNAL_REFERENCE_PATTERN.test(externalRaw)) {
    return { error: 'The transaction reference contains unsupported characters' };
  }

  const note = String(body.note || '').trim().slice(0, 300);

  return {
    value: {
      amount: Math.round(amountNum * 100) / 100,
      destination,
      senderReference,
      externalReference: externalRaw || null,
      note: note || null
    }
  };
}

/** Storage keys are generated entirely server-side – no user input, no traversal. */
function manualProofPath(userId, depositId, mimetype) {
  return `manual-deposits/${userId}/${depositId}.${mimeToExtension(mimetype)}`;
}

// ===== DEPOSIT – MANUAL PROOF SUBMISSION =====
// Creates a *pending* request only. No code path here touches the balance:
// crediting happens exclusively in `review_manual_deposit` after an admin
// approves the request.
app.post('/api/deposits/manual', verifyJWT, proofUploadRateLimit, upload.single('screenshot'), async (req, res, next) => {
  try {
    const parsed = validateManualDepositPayload(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { amount, destination, senderReference, externalReference, note } = parsed.value;

    if (!req.file) return res.status(400).json({ error: 'Attach a screenshot of your transfer' });
    if (!PROOF_MIME_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Only png, jpg, jpeg, and webp images are allowed' });
    }
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const idempotencyKey = requestIdempotencyKey(req) || randomUUID();
    const txRef = `LB-MAN-${req.user.id.slice(0, 8)}-${Date.now()}`;

    // The pending row is created first, atomically with the duplicate and
    // idempotency guards, so a retry or a double tap can never open a second
    // request for the same transfer.
    const { data: rows, error: rpcErr } = await supabase.rpc('create_manual_deposit', {
      p_user_id: req.user.id,
      p_amount: amount,
      p_tx_ref: txRef,
      p_destination_id: destination.id,
      p_payment_method: destination.type === 'telebirr' ? 'telebirr' : 'bank',
      p_sender_reference: senderReference,
      p_external_reference: externalReference,
      p_note: note,
      p_idempotency_key: idempotencyKey
    });
    if (rpcErr) {
      if (/duplicate/i.test(rpcErr.message || '')) {
        return res.status(409).json({ error: 'This transaction reference has already been submitted' });
      }
      console.warn('Manual deposit could not be recorded:', rpcErr.code || 'rpc_error');
      return res.status(500).json({ error: 'Could not record the deposit request. Please try again.' });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(500).json({ error: 'Could not record the deposit request. Please try again.' });

    if (row.replayed) {
      return res.status(200).json({
        ok: true,
        depositId: row.deposit_id,
        tx_ref: row.tx_ref,
        status: 'pending',
        replayed: true,
        message: 'Proof submitted for review'
      });
    }

    const proofPath = manualProofPath(req.user.id, row.deposit_id, req.file.mimetype);
    const { error: upErr } = await supabase.storage.from(MANUAL_PROOF_BUCKET).upload(proofPath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
    if (upErr) {
      // Never leave a reviewable request without its proof.
      await supabase.from('deposits').update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.deposit_id).eq('status', 'pending');
      return res.status(502).json({ error: 'Proof upload failed. Please try again.' });
    }

    const { error: attachErr } = await supabase
      .from('deposits')
      .update({ proof_path: proofPath, proof_mime: req.file.mimetype, updated_at: new Date().toISOString() })
      .eq('id', row.deposit_id);
    if (attachErr) {
      await supabase.storage.from(MANUAL_PROOF_BUCKET).remove([proofPath]);
      await supabase.from('deposits').update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.deposit_id).eq('status', 'pending');
      return res.status(500).json({ error: 'Could not attach the proof. Please try again.' });
    }

    // Identifiers only – no proof URL, no full sender account number.
    await notifyAdmin(
      `🧾 Manual deposit proof submitted\n` +
      `Deposit: ${row.deposit_id}\nUser: ${req.user.id}\nAmount: ${amount} ETB\n` +
      `Destination: ${destination.bank_name}\nSender: ${paymentDestinations.maskAccount(senderReference)}\n` +
      `Review it in the admin panel before crediting.`,
      null
    );

    return res.status(201).json({
      ok: true,
      depositId: row.deposit_id,
      tx_ref: row.tx_ref,
      status: 'pending',
      message: 'Proof submitted for review'
    });
  } catch (err) {
    return next(err);
  }
});

// ===== DEPOSIT – MANUAL HISTORY (player, own records only) =====
app.get('/api/deposits/manual', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const { data, error, count } = await supabase
      .from('deposits')
      .select('id, amount, status, destination_id, external_reference, note, review_reason, created_at, updated_at, reviewed_at', { count: 'exact' })
      .eq('user_id', req.user.id)
      .not('destination_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: 'Failed to fetch deposits' });
    return res.json({ ok: true, deposits: (data || []).map(publicDepositView), total: count || 0, page });
  } catch (err) {
    return next(err);
  }
});

// Internal statuses stay compatible with the existing rows; the API speaks the
// player-facing vocabulary.
function publicDepositStatus(status) {
  if (status === 'completed') return 'approved';
  if (status === 'failed') return 'rejected';
  return status;
}

function publicDepositView(row) {
  return { ...row, status: publicDepositStatus(row.status) };
}

// ===== DEPOSIT – PROOF ACCESS =====
// Proof objects live in a private bucket. Only the owner or an admin can obtain
// a short-lived signed URL, so proofs are never publicly enumerable.
app.get('/api/deposits/:id/proof', verifyJWT, walletRateLimit, async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid deposit id' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const { data: dep } = await supabase
      .from('deposits')
      .select('id, user_id, proof_path')
      .eq('id', id)
      .maybeSingle();

    const isAdmin = ADMIN_EMAILS.includes((req.user.email || '').toLowerCase());
    if (!dep || (!isAdmin && dep.user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Proof not found' });
    }
    if (!dep.proof_path) return res.status(404).json({ error: 'Proof not found' });

    const { data: signed, error } = await supabase.storage
      .from(MANUAL_PROOF_BUCKET)
      .createSignedUrl(dep.proof_path, PROOF_SIGNED_URL_TTL_SECONDS);
    if (error || !signed?.signedUrl) return res.status(502).json({ error: 'Proof is temporarily unavailable' });

    return res.json({ ok: true, url: signed.signedUrl, expires_in: PROOF_SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    return next(err);
  }
});

// ===== ADMIN – MANUAL DEPOSIT REVIEW QUEUE =====
app.get('/api/admin/deposits', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    const statusFilter = String(req.query.status || 'pending');
    const allowed = ['pending', 'approved', 'rejected', 'cancelled', 'all'];
    if (!allowed.includes(statusFilter)) return res.status(400).json({ error: 'Invalid status filter' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('deposits')
      .select(
        'id, user_id, amount, tx_ref, status, destination_id, payment_method, sender_reference, external_reference, note, proof_path, review_reason, reviewed_by, reviewed_at, created_at, updated_at, users(email, full_name, phone)',
        { count: 'exact' }
      )
      .not('destination_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter === 'approved') query = query.eq('status', 'completed');
    else if (statusFilter === 'rejected') query = query.eq('status', 'failed');
    else if (statusFilter !== 'all') query = query.eq('status', statusFilter);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch deposits' });

    const deposits = (data || []).map((row) => {
      const { proof_path, ...rest } = row;
      return { ...publicDepositView(rest), has_proof: Boolean(proof_path) };
    });
    return res.json({ ok: true, deposits, total: count || 0, page });
  } catch (err) {
    return next(err);
  }
});

/** Shared approve/reject handler – the state change and the credit both happen
 * inside one database transaction that only ever fires once per deposit. */
async function reviewManualDeposit(req, res, action) {
  const id = String(req.params.id || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid deposit id' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

  const { data: rows, error } = await supabase.rpc('review_manual_deposit', {
    p_deposit_id: id,
    p_action: action,
    p_reviewer: (req.user.email || req.user.id || '').slice(0, 120),
    p_reason: reason || null
  });
  if (error) {
    if (/not found/i.test(error.message || '')) return res.status(404).json({ error: 'Deposit not found' });
    console.warn('Manual deposit review failed:', error.code || 'rpc_error');
    return res.status(500).json({ error: 'Deposit could not be reviewed' });
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.reviewed) return res.status(409).json({ error: 'Deposit already processed' });

  return res.json({
    ok: true,
    credited: Boolean(row.credited),
    message: action === 'approve' ? 'Deposit approved and balance credited' : 'Deposit rejected'
  });
}

app.post('/api/admin/deposits/:id/approve', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await reviewManualDeposit(req, res, 'approve');
  } catch (err) {
    return next(err);
  }
});

app.post('/api/admin/deposits/:id/reject', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await reviewManualDeposit(req, res, 'reject');
  } catch (err) {
    return next(err);
  }
});

// ===== WITHDRAWAL REQUEST =====
// The funds check, the reservation (debit) and the request record all happen
// inside `request_withdrawal`, a single locking transaction, so concurrent
// requests can not over-withdraw the same balance.
const WITHDRAWAL_DESTINATION_TYPES = ['telebirr', 'bank'];
const BANK_ACCOUNT_PATTERN = /^[0-9][0-9 -]{5,31}$/;

/**
 * Validates a withdrawal payload. Ethiopian mobile formatting is enforced for
 * Telebirr payouts and every field length is bounded, so nothing unbounded or
 * unparsable ever reaches the ledger.
 */
function validateWithdrawalPayload(body) {
  const amountNum = Number(body.amount);
  if (!Number.isFinite(amountNum) || amountNum < WALLET_LIMITS.withdrawMin || amountNum > WALLET_LIMITS.withdrawMax) {
    return { error: `Withdrawal must be between ${WALLET_LIMITS.withdrawMin} and ${WALLET_LIMITS.withdrawMax} ETB` };
  }

  // `payment_method` is the legacy field name; both spellings are accepted.
  const rawType = String(body.destination_type || body.payment_method || '').trim().toLowerCase();
  let destinationType = rawType;
  let bankName = typeof body.bank_name === 'string' ? body.bank_name.trim().slice(0, 60) : '';
  if (!WITHDRAWAL_DESTINATION_TYPES.includes(rawType)) {
    if (!PAYMENT_METHODS.includes(rawType)) {
      return { error: 'Choose Telebirr or a bank transfer' };
    }
    destinationType = 'bank';
    bankName = bankName || rawType.toUpperCase();
  }

  const destinationId = String(body.destination_id || '').trim().toLowerCase();
  if (destinationId) {
    const configured = MANUAL_DESTINATION_BY_ID.get(destinationId);
    if (!configured) return { error: 'Choose one of the listed payment destinations' };
    bankName = configured.bank_name;
  }

  if (destinationType === 'bank' && (bankName.length < 2 || bankName.length > 60)) {
    return { error: 'Enter the bank name' };
  }

  const accountNumber = typeof body.account_number === 'string' ? body.account_number.trim() : '';
  if (destinationType === 'telebirr') {
    if (!paymentDestinations.isEthiopianPhone(accountNumber)) {
      return { error: 'Enter a valid Ethiopian Telebirr number, e.g. 0912345678' };
    }
  } else if (!BANK_ACCOUNT_PATTERN.test(accountNumber)) {
    return { error: 'Enter a valid bank account number' };
  }

  const accountName = typeof body.account_name === 'string' ? body.account_name.trim() : '';
  if (accountName.length < 2 || accountName.length > 80) {
    return { error: 'Enter the account holder name' };
  }

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';

  return {
    value: {
      amount: Math.round(amountNum * 100) / 100,
      destinationType,
      bankName: destinationType === 'bank' ? bankName : 'Telebirr',
      accountNumber,
      accountName,
      note: note || null
    }
  };
}

app.post('/api/withdrawals', verifyJWT, walletRateLimit, async (req, res, next) => {
  try {
    // Payload validation runs before any I/O so malformed requests are cheap
    // to reject and always answered with the same message.
    const parsed = validateWithdrawalPayload(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { amount, destinationType, bankName, accountNumber, accountName, note } = parsed.value;

    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const idempotencyKey = requestIdempotencyKey(req) || randomUUID();
    const { data: rows, error: rpcErr } = await supabase.rpc('request_withdrawal', {
      p_user_id: req.user.id,
      p_amount: amount,
      p_payment_method: destinationType,
      p_account_number: accountNumber,
      p_account_name: accountName,
      p_bank_name: bankName,
      p_note: note,
      p_idempotency_key: idempotencyKey
    });
    if (rpcErr) {
      const msg = /insufficient/i.test(rpcErr.message || '') ? 'Insufficient balance' : 'Withdrawal could not be created';
      return res.status(400).json({ error: msg });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(500).json({ error: 'Withdrawal could not be created' });

    if (!row.replayed) {
      // Identifiers only – the payout account is never sent in full over Telegram.
      await notifyAdmin(
        `💸 Withdrawal request\nWithdrawal: ${row.withdrawal_id}\nUser: ${req.user.id}\n` +
        `Amount: ${amount} ETB\nDestination: ${bankName}\n` +
        `Account: ${paymentDestinations.maskAccount(accountNumber)}\nReview it in the admin panel.`,
        null
      );
    }

    return res.status(201).json({
      ok: true,
      withdrawalId: row.withdrawal_id,
      balance: gameMath.fromCents(row.balance_after_cents),
      replayed: Boolean(row.replayed),
      status: 'pending',
      message: 'Withdrawal request submitted. Funds are reserved until an operator reviews it.'
    });
  } catch (err) {
    return next(err);
  }
});

// ===== WITHDRAWAL – LIST / CANCEL (player) =====
app.get('/api/withdrawals', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    // Scoped to the caller: a player can only ever see their own requests.
    const { data, error, count } = await supabase
      .from('withdrawals')
      .select('id, amount, payment_method, bank_name, status, admin_notes, payment_reference, created_at, updated_at, reviewed_at', { count: 'exact' })
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: 'Failed to fetch withdrawals' });
    return res.json({ ok: true, withdrawals: data || [], total: count || 0, page });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/withdrawals/:id/cancel', verifyJWT, walletRateLimit, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });
    // The RPC also re-checks ownership, so a forged id can not cancel and
    // refund somebody else's withdrawal.
    const { data: rows, error } = await supabase.rpc('resolve_withdrawal', {
      p_withdrawal_id: req.params.id,
      p_status: 'cancelled',
      p_user_id: req.user.id,
      p_admin_notes: 'Cancelled by player',
      p_reviewer: null,
      p_payment_reference: null
    });
    if (error) return res.status(404).json({ error: 'Withdrawal not found' });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.resolved) return res.status(409).json({ error: 'Withdrawal already processed' });
    return res.json({ ok: true, message: 'Withdrawal cancelled and funds returned' });
  } catch (err) {
    return next(err);
  }
});

// ===== ADMIN – PROCESS WITHDRAWAL =====
app.get('/api/admin/withdrawals', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    const statusFilter = String(req.query.status || 'pending');
    const allowed = ['pending', 'processing', 'paid', 'rejected', 'cancelled', 'all'];
    if (!allowed.includes(statusFilter)) return res.status(400).json({ error: 'Invalid status filter' });
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('withdrawals')
      .select('id, user_id, amount, payment_method, bank_name, account_number, account_name, note, status, admin_notes, payment_reference, reviewed_by, reviewed_at, created_at, updated_at, users(email, full_name, phone)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (statusFilter !== 'all') query = query.eq('status', statusFilter);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: 'Failed to fetch withdrawals' });
    return res.json({ ok: true, withdrawals: data || [], total: count || 0, page });
  } catch (err) {
    return next(err);
  }
});

/**
 * Shared admin transition handler. `resolve_withdrawal` validates the source
 * state, so replays, refreshes and two admins clicking at once resolve the
 * request exactly once: the losing call gets `resolved = false`.
 */
async function resolveWithdrawalAs(req, res, status) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const paymentReference = typeof req.body?.payment_reference === 'string'
    ? req.body.payment_reference.trim().slice(0, 120)
    : null;
  if (status === 'paid' && paymentReference && !/^[A-Za-z0-9\-_.]{3,120}$/.test(paymentReference)) {
    return res.status(400).json({ error: 'The payment reference contains unsupported characters' });
  }

  const { data: rows, error } = await supabase.rpc('resolve_withdrawal', {
    p_withdrawal_id: req.params.id,
    p_status: status,
    p_user_id: null,
    p_admin_notes: typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 500)
      : (typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null),
    p_reviewer: (req.user.email || req.user.id || '').slice(0, 120),
    p_payment_reference: paymentReference
  });
  if (error) {
    if (/invalid status|transition/i.test(error.message || '')) {
      return res.status(409).json({ error: 'Invalid withdrawal state transition' });
    }
    return res.status(404).json({ error: 'Withdrawal not found' });
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.resolved) return res.status(409).json({ error: 'Already processed' });
  return res.json({ ok: true, refunded: Boolean(row.refunded), status, message: `Withdrawal marked as ${status}` });
}

app.post('/api/admin/withdrawals/:id/processing', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await resolveWithdrawalAs(req, res, 'processing');
  } catch (err) {
    return next(err);
  }
});

// Marking a request paid never debits again – the amount was already reserved
// when the player created it.
app.post('/api/admin/withdrawals/:id/paid', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await resolveWithdrawalAs(req, res, 'paid');
  } catch (err) {
    return next(err);
  }
});

// Legacy alias kept so existing admin tooling keeps working.
app.post('/api/admin/withdrawals/:id/complete', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await resolveWithdrawalAs(req, res, 'paid');
  } catch (err) {
    return next(err);
  }
});

app.post('/api/admin/withdrawals/:id/reject', verifyJWT, requireAdmin, async (req, res, next) => {
  try {
    return await resolveWithdrawalAs(req, res, 'rejected');
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
  aviator: { minBet: 5, maxBet: 1000 },
  dice: { minBet: 5, maxBet: 500 },
  fast_keno: { minBet: 5, maxBet: 500 }
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

  if (game === 'dice') {
    const direction = body.direction;
    if (direction !== 'under' && direction !== 'over') {
      const err = new Error('direction must be "under" or "over"');
      err.status = 400;
      throw err;
    }
    const target = Number(body.target);
    const multiplier = gameMath.diceMultiplier(target, direction);
    if (multiplier === null) {
      const err = new Error(
        `target must be an integer between ${gameMath.DICE_MIN_TARGET} and ${gameMath.DICE_MAX_TARGET}`
      );
      err.status = 400;
      throw err;
    }
    const roll = rng.secureInt(1, gameMath.DICE_FACES + 1);
    const won = direction === 'under' ? roll < target : roll > target;
    const payoutCents = won ? Math.round(stakeCents * multiplier) : 0;
    const winChance = gameMath.diceWinningFaces(target, direction) / gameMath.DICE_FACES;
    const result = {
      roll,
      target,
      direction,
      won,
      multiplier,
      win_chance: winChance,
      payout: gameMath.fromCents(payoutCents)
    };
    return { payoutCents, result, rngMeta: { roll } };
  }

  const err = new Error('Invalid game');
  err.status = 400;
  throw err;
}

app.post('/api/games/bet', gameBetRateLimit, verifyJWT, async (req, res, next) => {
  try {
    const { game, bet_amount } = req.body || {};
    if (!GAME_CONFIGS[game]) return res.status(400).json({ error: 'Invalid game' });
    if (game === 'fast_keno') {
      return res.status(400).json({ error: 'Fast Keno uses /api/games/fast-keno/bet' });
    }

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

    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

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

// ===== FAST KENO (shared, server-scheduled rapid rounds) =====
// Timings are deploy-time configuration; clients only *render* the countdown
// that the server reports, they never decide when a round closes.
const fastKenoEngine = new fastKeno.FastKenoEngine({
  bettingMs: Number(process.env.FAST_KENO_BETTING_MS) || 20000,
  drawingMs: Number(process.env.FAST_KENO_DRAWING_MS) || 6000,
  resultMs: Number(process.env.FAST_KENO_RESULT_MS) || 6000
});

const fastKenoBetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bets, please slow down.' }
});

/**
 * Returns the drawn numbers for a round, generating them once and persisting
 * them so that settlement, reconnecting clients, and restarts all observe the
 * same draw. The `ignoreDuplicates` upsert makes concurrent generation safe:
 * whoever loses the race simply reads the stored row back.
 */
async function ensureFastKenoDraw(roundIndex) {
  const cached = fastKenoEngine.drawCache.get(roundIndex);
  if (cached) return cached;
  if (!fastKenoEngine.isDrawn(roundIndex)) return null;
  if (!supabase) return fastKenoEngine.getDraw(roundIndex);

  const { data: existing } = await supabase
    .from('fast_keno_rounds')
    .select('drawn')
    .eq('round_index', roundIndex)
    .maybeSingle();
  if (existing && Array.isArray(existing.drawn)) {
    return fastKenoEngine.rememberDraw(roundIndex, existing.drawn);
  }

  const drawn = fastKeno.defaultDraw();
  const { error: upsertErr } = await supabase.from('fast_keno_rounds').upsert(
    {
      round_index: roundIndex,
      round_id: fastKenoEngine.roundId(roundIndex),
      drawn,
      math_version: gameMath.MATH_VERSION
    },
    { onConflict: 'round_index', ignoreDuplicates: true }
  );
  if (upsertErr) {
    // Without a persisted draw two processes could invent different numbers
    // for the same round, so nothing is cached, shown, or settled: the bets
    // stay pending and a later pass retries.
    console.error('Fast Keno draw could not be persisted for round', roundIndex, '-', upsertErr.message);
    return null;
  }

  // Re-read so that whichever process won the insert defines the draw for
  // everyone; our locally generated numbers are discarded if we lost the race.
  const { data: stored, error: readErr } = await supabase
    .from('fast_keno_rounds')
    .select('drawn')
    .eq('round_index', roundIndex)
    .maybeSingle();
  if (readErr || !stored || !Array.isArray(stored.drawn)) {
    console.error('Fast Keno draw could not be read back for round', roundIndex);
    return null;
  }
  return fastKenoEngine.rememberDraw(roundIndex, stored.drawn);
}

let fastKenoSettling = false;

/**
 * Settles every pending bet whose round has already been drawn. Safe to call
 * concurrently and repeatedly: `settle_fast_keno_bet` only pays a bet once.
 */
async function settleDueFastKenoBets() {
  if (!supabase || fastKenoSettling) return;
  fastKenoSettling = true;
  try {
    const currentIndex = fastKenoEngine.roundAt().index;
    const { data: bets, error } = await supabase
      .from('fast_keno_bets')
      .select('id, user_id, round_index, picks, stake_cents')
      .eq('status', 'pending')
      .lte('round_index', currentIndex)
      .order('round_index', { ascending: true })
      .limit(200);
    if (error || !bets || bets.length === 0) return;

    for (const bet of bets) {
      if (!fastKenoEngine.isDrawn(bet.round_index)) continue;
      const drawn = await ensureFastKenoDraw(bet.round_index);
      if (!drawn) continue;
      const evaluation = fastKeno.evaluateBet(bet.picks || [], drawn, Number(bet.stake_cents));
      const { error: settleErr } = await supabase.rpc('settle_fast_keno_bet', {
        p_bet_id: bet.id,
        p_payout_cents: evaluation.payoutCents,
        p_hits: evaluation.hits,
        p_multiplier: evaluation.multiplier,
        p_matched: evaluation.matched
      });
      if (settleErr) console.warn('Fast Keno settlement failed for bet:', settleErr.message);
    }
  } catch (err) {
    console.warn('Fast Keno settlement pass failed:', err.message);
  } finally {
    fastKenoSettling = false;
  }
}

function fastKenoRoundPayload(round, drawn) {
  return {
    id: round.id,
    index: round.index,
    phase: round.phase,
    ms_remaining: round.msRemaining,
    opens_at: round.opensAt,
    closes_at: round.closesAt,
    drawn_at: round.drawnAt,
    ends_at: round.endsAt,
    server_time: Date.now(),
    drawn: drawn || null
  };
}

// Public round state (no wagering, no personal data) so the lobby countdown
// works before sign-in. Personal bet state is only added for a valid token.
app.get('/api/games/fast-keno/state', async (req, res, next) => {
  try {
    const round = fastKenoEngine.roundAt();
    const drawn = round.phase === fastKeno.PHASE_RESULT ? await ensureFastKenoDraw(round.index) : null;
    const previous = await ensureFastKenoDraw(round.index - 1);

    const payload = {
      ok: true,
      config: {
        pool: gameMath.FAST_KENO_TOTAL,
        draw_count: gameMath.FAST_KENO_DRAWN,
        max_picks: gameMath.FAST_KENO_MAX_PICKS,
        min_bet: GAME_CONFIGS.fast_keno.minBet,
        max_bet: GAME_CONFIGS.fast_keno.maxBet,
        betting_ms: fastKenoEngine.bettingMs,
        drawing_ms: fastKenoEngine.drawingMs,
        result_ms: fastKenoEngine.resultMs,
        paytables: Object.fromEntries(
          Object.values(gameMath.FAST_KENO_TABLES).map((t) => [t.picks, t.multipliers])
        )
      },
      round: fastKenoRoundPayload(round, drawn),
      previous_round: previous
        ? { id: fastKenoEngine.roundId(round.index - 1), drawn: previous }
        : null,
      bet: null,
      recent_bets: []
    };

    // Resolve the optional bearer token by hand: an invalid or missing token
    // simply means "no personal data", it must not fail the public state call.
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && JWT_SECRET && supabase) {
      let userId = null;
      try {
        userId = jwt.verify(auth.slice(7), JWT_SECRET).id;
      } catch (_err) {
        userId = null;
      }
      if (userId) {
        await settleDueFastKenoBets();
        const { data: bets } = await supabase
          .from('fast_keno_bets')
          .select('id, round_index, round_id, picks, stake_cents, payout_cents, hits, multiplier, matched, status, created_at')
          .eq('user_id', userId)
          .order('round_index', { ascending: false })
          .limit(10);
        const list = bets || [];
        payload.recent_bets = list;
        // The bet for the round currently on screen, so a refresh or a
        // reconnect restores exactly what the player already staked.
        payload.bet = list.find((b) => b.round_index === round.index)
          || list.find((b) => b.round_index === round.index - 1)
          || null;
      }
    }

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

app.post('/api/games/fast-keno/bet', fastKenoBetRateLimit, verifyJWT, async (req, res, next) => {
  try {
    const cfg = GAME_CONFIGS.fast_keno;
    const betNum = Number(req.body?.bet_amount);
    if (!Number.isFinite(betNum) || betNum < cfg.minBet || betNum > cfg.maxBet) {
      return res.status(400).json({ error: `Bet must be between ${cfg.minBet} and ${cfg.maxBet} ETB` });
    }
    const stakeCents = gameMath.toCents(betNum);
    if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    let picks;
    try {
      picks = fastKeno.normalisePicks(req.body?.picks);
    } catch (validationErr) {
      return res.status(validationErr.status || 400).json({ error: validationErr.message });
    }

    // The round is taken from the server clock. A client-supplied round id is
    // only used to detect that the player was looking at an older round.
    const round = fastKenoEngine.roundAt();
    const requestedRound = req.body?.round_id;
    if (typeof requestedRound === 'string' && requestedRound && requestedRound !== round.id) {
      return res.status(409).json({ error: 'That round has closed. Your bet was not placed.', round: fastKenoRoundPayload(round, null) });
    }
    if (round.phase !== fastKeno.PHASE_BETTING) {
      return res.status(409).json({ error: 'Betting is closed for this round.', round: fastKenoRoundPayload(round, null) });
    }
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const idempotencyKey = requestIdempotencyKey(req) || `${round.id}:${req.user.id}`;
    const { data: rows, error: rpcErr } = await supabase.rpc('place_fast_keno_bet', {
      p_user_id: req.user.id,
      p_round_index: round.index,
      p_round_id: round.id,
      p_idempotency_key: idempotencyKey,
      p_math_version: gameMath.MATH_VERSION,
      p_picks: picks,
      p_stake_cents: stakeCents
    });
    if (rpcErr) {
      const msg = /insufficient/i.test(rpcErr.message || '') ? 'Insufficient balance' : 'Bet could not be placed';
      return res.status(400).json({ error: msg });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(500).json({ error: 'Bet could not be placed' });

    return res.status(201).json({
      ok: true,
      bet_id: row.bet_id,
      replayed: Boolean(row.replayed),
      picks,
      stake: gameMath.fromCents(stakeCents),
      balance: gameMath.fromCents(row.balance_after_cents),
      round: fastKenoRoundPayload(round, null)
    });
  } catch (err) {
    return next(err);
  }
});

if (supabase) {
  // Background settlement so payouts land even when the player closed the tab.
  const settlementTimer = setInterval(() => {
    settleDueFastKenoBets().catch(() => {});
  }, 3000);
  if (typeof settlementTimer.unref === 'function') settlementTimer.unref();
}


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
      },
      fast_keno: {
        pool: gameMath.FAST_KENO_TOTAL,
        draw_count: gameMath.FAST_KENO_DRAWN,
        max_picks: gameMath.FAST_KENO_MAX_PICKS,
        round_seconds: Math.round(fastKenoEngine.cycleMs / 1000),
        paytables: Object.fromEntries(
          Object.values(gameMath.FAST_KENO_TABLES).map((t) => [t.picks, { multipliers: t.multipliers, rtp: t.achievedRtp }])
        )
      },
      dice: {
        faces: gameMath.DICE_FACES,
        min_target: gameMath.DICE_MIN_TARGET,
        max_target: gameMath.DICE_MAX_TARGET,
        target_rtp: gameMath.TARGET_RTP
      }
    },
    limits: Object.fromEntries(
      Object.entries(GAME_CONFIGS).map(([name, cfg]) => [name, { min_bet: cfg.minBet, max_bet: cfg.maxBet }])
    )
  });
});

// ===== TRANSACTION HISTORY =====
const TRANSACTION_TYPES = [
  'deposit', 'withdrawal', 'withdrawal_refund', 'game_win', 'game_loss', 'raffle_bet', 'raffle_win'
];
const TRANSACTION_GROUPS = {
  all: null,
  deposits: ['deposit'],
  withdrawals: ['withdrawal', 'withdrawal_refund'],
  games: ['game_win', 'game_loss', 'raffle_bet', 'raffle_win']
};

app.get('/api/transactions', verifyJWT, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    if (!Object.prototype.hasOwnProperty.call(TRANSACTION_GROUPS, filter)) {
      return res.status(400).json({ error: 'Invalid filter' });
    }
    if (type && !TRANSACTION_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid transaction type' });
    }
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    let query = supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id);
    if (type) query = query.eq('type', type);
    else if (TRANSACTION_GROUPS[filter]) query = query.in('type', TRANSACTION_GROUPS[filter]);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: 'Failed to fetch transactions' });
    const total = count || 0;
    return res.json({
      ok: true,
      transactions: data || [],
      total,
      page,
      limit,
      filter,
      has_more: offset + (data ? data.length : 0) < total
    });
  } catch (err) {
    return next(err);
  }
});

// ===== WALLET SUMMARY =====
// Single source of truth for the wallet screen: available balance, funds that
// are reserved or awaiting confirmation, and the configured limits.
app.get('/api/wallet/summary', verifyJWT, async (req, res, next) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Database not configured' });

    const [userRes, pendingWdRes, pendingDepRes] = await Promise.all([
      supabase.from('users').select('balance').eq('id', req.user.id).maybeSingle(),
      supabase.from('withdrawals').select('amount').eq('user_id', req.user.id).in('status', ['pending', 'processing']),
      supabase.from('deposits').select('amount').eq('user_id', req.user.id).eq('status', 'pending')
    ]);

    if (!userRes.data) return res.status(404).json({ error: 'User not found' });

    const sum = (rows) => (rows || []).reduce((acc, row) => acc + Number(row.amount || 0), 0);
    return res.json({
      ok: true,
      balance: Number(userRes.data.balance) || 0,
      pending_withdrawals: sum(pendingWdRes.data),
      pending_deposits: sum(pendingDepRes.data),
      limits: {
        deposit_min: WALLET_LIMITS.depositMin,
        deposit_max: WALLET_LIMITS.depositMax,
        withdraw_min: WALLET_LIMITS.withdrawMin,
        withdraw_max: WALLET_LIMITS.withdrawMax
      }
    });
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
