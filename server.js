require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const root = path.join(__dirname, 'www');
const port = Number(process.env.PORT) || 3000;
const sessionCookie = 'gsquad_session';
const sessionLifetime = 30 * 24 * 60 * 60;
const authSecret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only-change-before-deploy');
const allowedOrigins = new Set((process.env.APP_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,https://localhost,capacitor://localhost,ionic://localhost')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));
const currencies = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  TRX: 'TRON',
  USDT_TRX: 'Tether (TRON)',
  USDT_BSC: 'Tether (BSC)',
  USDC: 'USD Coin'
};
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

if (!authSecret) throw new Error('AUTH_SECRET must be set before starting in production.');
if (process.env.NODE_ENV !== 'production' && !process.env.AUTH_SECRET) {
  console.warn('Using a development-only authentication secret. Set AUTH_SECRET before deployment.');
}

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '.data', 'gsquad.sqlite');
if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_salt TEXT NOT NULL,
    pin_hash BLOB NOT NULL,
    pin_fingerprint TEXT NOT NULL UNIQUE,
    balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invoices (
    txn_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    order_number TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    crypto_amount TEXT NOT NULL,
    payment_address TEXT NOT NULL,
    source_rate TEXT,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL,
    payout_txn_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS invoices_user_id_idx ON invoices(user_id);
  CREATE INDEX IF NOT EXISTS withdrawals_user_id_idx ON withdrawals(user_id);
`);

const queries = {
  userById: database.prepare('SELECT id, username, email, balance_cents FROM users WHERE id = ?'),
  userByEmail: database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  userByFingerprint: database.prepare('SELECT * FROM users WHERE pin_fingerprint = ?'),
  insertUser: database.prepare('INSERT INTO users (id, username, email, pin_salt, pin_hash, pin_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insertSession: database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: database.prepare('SELECT users.id, users.username, users.email, users.balance_cents FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?'),
  deleteSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  invoiceForUser: database.prepare('SELECT * FROM invoices WHERE txn_id = ? AND user_id = ?'),
  withdrawalForUser: database.prepare('SELECT * FROM withdrawals WHERE id = ? AND user_id = ?')
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function addCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (origin && originAllowed(request)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
}

function readJson(request, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maximumBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(request, response, token) {
  const crossOriginApp = request.headers.origin && !originIsSameSite(request.headers.origin, request.headers.host);
  const secure = process.env.NODE_ENV === 'production' || request.headers['x-forwarded-proto'] === 'https';
  const sameSite = crossOriginApp ? 'None' : 'Lax';
  response.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=${sessionLifetime}${secure ? '; Secure' : ''}`);
}

function originIsSameSite(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', `${sessionCookie}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function authenticate(request) {
  const token = cookieValue(request, sessionCookie);
  if (!token) return null;
  return queries.sessionUser.get(hashSessionToken(token), Math.floor(Date.now() / 1000)) || null;
}

function fingerprintPin(pin) {
  return crypto.createHmac('sha256', authSecret).update(pin).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  queries.insertSession.run(hashSessionToken(token), userId, Math.floor(Date.now() / 1000) + sessionLifetime);
  return token;
}

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, balanceCents: user.balance_cents };
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

function validAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 1 && amount <= 10000;
}

function verifyPlisioCallback(data) {
  if (!data || typeof data !== 'object' || typeof data.verify_hash !== 'string' || !process.env.PLISIO_API_KEY) return false;
  const ordered = { ...data };
  delete ordered.verify_hash;
  const expected = crypto.createHmac('sha1', process.env.PLISIO_API_KEY).update(JSON.stringify(ordered)).digest();
  let actual;
  try {
    actual = Buffer.from(data.verify_hash, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function callbackUrl() {
  const configuredUrl = process.env.PLISIO_CALLBACK_URL;
  if (!configuredUrl) return undefined;
  const url = new URL(configuredUrl);
  if (url.protocol !== 'https:') throw new Error('PLISIO_CALLBACK_URL must use HTTPS.');
  url.searchParams.set('json', 'true');
  return url.toString();
}

async function createPlisioInvoice(user, amountCents, currency, orderNumber) {
  if (!process.env.PLISIO_API_KEY) throw Object.assign(new Error('Crypto deposits are not configured yet.'), { statusCode: 503 });
  const callback = callbackUrl();
  const parameters = new URLSearchParams({
    api_key: process.env.PLISIO_API_KEY,
    source_currency: 'USD',
    source_amount: (amountCents / 100).toFixed(2),
    currency,
    allowed_psys_cids: currency,
    order_number: orderNumber,
    email: user.email,
    expire_min: '60',
    redirect_to_invoice: 'false'
  });
  if (callback) parameters.set('callback_url', callback);
  const response = await fetch(`https://api.plisio.net/api/v1/invoices/new?${parameters}`, {
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'success' || !result.data) {
    throw Object.assign(new Error(result?.data?.message || 'Plisio could not create the payment request.'), { statusCode: 502 });
  }
  const data = result.data;
  if (!data.txn_id || !data.wallet_hash || !data.amount || !data.expire_utc) {
    throw Object.assign(new Error('Plisio returned incomplete invoice details. Confirm white-label is enabled for this store.'), { statusCode: 502 });
  }
  return data;
}

function invoiceResponse(invoice) {
  return {
    transactionId: invoice.txn_id,
    amountUsd: invoice.amount_cents / 100,
    currency: invoice.currency,
    cryptoAmount: invoice.crypto_amount,
    address: invoice.payment_address,
    rate: invoice.source_rate,
    expiresAt: invoice.expires_at,
    status: invoice.status
  };
}

function userTransactions(userId) {
  const deposits = database.prepare(`SELECT txn_id AS id, 'deposit' AS type, amount_cents, currency, status, created_at
    FROM invoices WHERE user_id = ? AND status = 'completed'`).all(userId);
  const withdrawals = database.prepare(`SELECT id, 'withdrawal' AS type, amount_cents, currency, status, created_at
    FROM withdrawals WHERE user_id = ?`).all(userId);
  return [...deposits, ...withdrawals]
    .map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount_cents / 100,
      currency: transaction.currency,
      status: transaction.status,
      date: transaction.created_at
    }))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 30);
}

async function handleApi(request, response, url) {
  if (!originAllowed(request)) return sendError(response, 403, 'This app origin is not allowed.');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    return response.end();
  }

  const { pathname } = url;
  if (pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, 200, { status: 'ok', paymentsConfigured: Boolean(process.env.PLISIO_API_KEY) });
  }

  if (pathname === '/api/plisio/callback' && request.method === 'POST') {
    const data = await readJson(request);
    if (!verifyPlisioCallback(data)) return sendError(response, 422, 'Invalid Plisio callback signature.');
    const invoice = database.prepare('SELECT * FROM invoices WHERE txn_id = ? AND order_number = ?').get(String(data.txn_id || ''), String(data.order_number || ''));
    if (!invoice) return sendError(response, 404, 'Invoice was not found.');
    const status = ['new', 'pending', 'pending internal', 'completed', 'expired', 'cancelled', 'error', 'mismatch'].includes(data.status) ? data.status : 'error';
    const updateInvoice = database.transaction(() => {
      const current = database.prepare('SELECT status FROM invoices WHERE txn_id = ?').get(invoice.txn_id);
      if (current.status === 'completed') return;
      database.prepare('UPDATE invoices SET status = ? WHERE txn_id = ?').run(status, invoice.txn_id);
      if (status === 'completed') {
        database.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(invoice.amount_cents, invoice.user_id);
      }
    });
    updateInvoice();
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('OK');
  }

  if (pathname === '/api/register' && request.method === 'POST') {
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (username.length < 2 || username.length > 24) return sendError(response, 400, 'Name must be between 2 and 24 characters.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendError(response, 400, 'Enter a valid email address.');
    if (!validPin(body.pin)) return sendError(response, 400, 'Your code must contain exactly six digits.');
    if (queries.userByEmail.get(email)) return sendError(response, 409, 'An account with this email already exists.');
    if (queries.userByFingerprint.get(fingerprintPin(body.pin))) return sendError(response, 409, 'That code is already in use. Choose another.');

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16);
    const pinHash = crypto.scryptSync(body.pin, salt, 64);
    queries.insertUser.run(id, username, email, salt.toString('hex'), pinHash, fingerprintPin(body.pin), new Date().toISOString());
    const user = queries.userById.get(id);
    setSessionCookie(request, response, createSession(id));
    return sendJson(response, 201, { user: publicUser(user) });
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    const body = await readJson(request);
    if (!validPin(body.pin)) return sendError(response, 400, 'Enter your six-digit code.');
    const user = queries.userByFingerprint.get(fingerprintPin(body.pin));
    if (!user) return sendError(response, 401, 'That code did not match.');
    const actualHash = crypto.scryptSync(body.pin, Buffer.from(user.pin_salt, 'hex'), 64);
    if (!crypto.timingSafeEqual(actualHash, user.pin_hash)) return sendError(response, 401, 'That code did not match.');
    setSessionCookie(request, response, createSession(user.id));
    return sendJson(response, 200, { user: publicUser(user) });
  }

  const user = authenticate(request);
  if (pathname === '/api/session' && request.method === 'GET') {
    return user ? sendJson(response, 200, { user }) : sendError(response, 401, 'Sign in to continue.');
  }
  if (pathname === '/api/logout' && request.method === 'POST') {
    const token = cookieValue(request, sessionCookie);
    if (token) queries.deleteSession.run(hashSessionToken(token));
    clearSessionCookie(response);
    return sendJson(response, 200, { status: 'signed_out' });
  }
  if (!user) return sendError(response, 401, 'Sign in to continue.');

  if (pathname === '/api/wallet' && request.method === 'GET') {
    return sendJson(response, 200, { balance: user.balance_cents / 100, transactions: userTransactions(user.id) });
  }

  if (pathname === '/api/deposits' && request.method === 'POST') {
    const body = await readJson(request);
    const amount = Number(body.amount);
    const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : '';
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return sendError(response, 400, 'Deposit amount must be between $1 and $10,000.');
    if (!currencies[currency]) return sendError(response, 400, 'Select a supported cryptocurrency.');
    if (!process.env.PLISIO_API_KEY) return sendError(response, 503, 'Crypto deposits are not configured yet.');
    const amountCents = Math.round(amount * 100);
    const orderNumber = crypto.randomUUID();
    const data = await createPlisioInvoice(user, amountCents, currency, orderNumber);
    const invoice = {
      txn_id: String(data.txn_id),
      user_id: user.id,
      order_number: orderNumber,
      amount_cents: amountCents,
      currency,
      crypto_amount: String(data.amount),
      payment_address: String(data.wallet_hash),
      source_rate: data.source_rate ? String(data.source_rate) : null,
      expires_at: Number(data.expire_utc),
      status: String(data.status || 'new'),
      created_at: new Date().toISOString()
    };
    database.prepare(`INSERT INTO invoices (txn_id, user_id, order_number, amount_cents, currency, crypto_amount, payment_address, source_rate, expires_at, status, created_at)
      VALUES (@txn_id, @user_id, @order_number, @amount_cents, @currency, @crypto_amount, @payment_address, @source_rate, @expires_at, @status, @created_at)`).run(invoice);
    return sendJson(response, 201, { invoice: invoiceResponse(invoice) });
  }

  const invoiceMatch = pathname.match(/^\/api\/deposits\/([a-zA-Z0-9_-]+)$/);
  if (invoiceMatch && request.method === 'GET') {
    const invoice = queries.invoiceForUser.get(invoiceMatch[1], user.id);
    if (!invoice) return sendError(response, 404, 'Payment request was not found.');
    return sendJson(response, 200, { invoice: invoiceResponse(invoice) });
  }

  if (pathname === '/api/withdrawals' && request.method === 'POST') {
    const body = await readJson(request);
    const amount = Number(body.amount);
    const currency = typeof body.currency === 'string' ? body.currency.toUpperCase() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!Number.isFinite(amount) || amount < 5 || amount > 10000) return sendError(response, 400, 'Withdrawal amount must be between $5 and $10,000.');
    if (!currencies[currency]) return sendError(response, 400, 'Select a supported cryptocurrency.');
    if (address.length < 20 || address.length > 150 || /\s/.test(address)) return sendError(response, 400, 'Enter a valid wallet address for the selected cryptocurrency.');
    const amountCents = Math.round(amount * 100);
    const id = crypto.randomUUID();
    const requestWithdrawal = database.transaction(() => {
      const result = database.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?').run(amountCents, user.id, amountCents);
      if (result.changes !== 1) return false;
      database.prepare(`INSERT INTO withdrawals (id, user_id, amount_cents, currency, address, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, user.id, amountCents, currency, address, new Date().toISOString());
      return true;
    });
    if (!requestWithdrawal()) return sendError(response, 409, 'Insufficient confirmed balance for this withdrawal.');
    return sendJson(response, 201, { withdrawal: { id, amount, currency, status: 'pending' } });
  }

  if (pathname === '/api/admin/withdrawals' && request.method === 'GET') {
    if (!process.env.ADMIN_API_KEY || request.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return sendError(response, 403, 'Not authorized.');
    const withdrawals = database.prepare(`SELECT withdrawals.*, users.email FROM withdrawals JOIN users ON users.id = withdrawals.user_id
      WHERE withdrawals.status = 'pending' ORDER BY withdrawals.created_at`).all();
    return sendJson(response, 200, { withdrawals });
  }

  const adminWithdrawal = pathname.match(/^\/api\/admin\/withdrawals\/([a-f0-9-]+)$/i);
  if (adminWithdrawal && request.method === 'POST') {
    if (!process.env.ADMIN_API_KEY || request.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return sendError(response, 403, 'Not authorized.');
    const body = await readJson(request);
    if (!['paid', 'rejected'].includes(body.status)) return sendError(response, 400, 'Status must be paid or rejected.');
    if (body.status === 'paid' && (typeof body.payoutTxnId !== 'string' || !body.payoutTxnId.trim())) return sendError(response, 400, 'Enter the Plisio payout transaction ID.');
    const updateWithdrawal = database.transaction(() => {
      const withdrawal = database.prepare('SELECT * FROM withdrawals WHERE id = ? AND status = \'pending\'').get(adminWithdrawal[1]);
      if (!withdrawal) return false;
      database.prepare('UPDATE withdrawals SET status = ?, payout_txn_id = ?, resolved_at = ? WHERE id = ?')
        .run(body.status, body.status === 'paid' ? body.payoutTxnId.trim() : null, new Date().toISOString(), withdrawal.id);
      if (body.status === 'rejected') database.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(withdrawal.amount_cents, withdrawal.user_id);
      return true;
    });
    if (!updateWithdrawal()) return sendError(response, 404, 'Pending withdrawal was not found.');
    return sendJson(response, 200, { status: body.status });
  }

  return sendError(response, 404, 'API route was not found.');
}

async function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);

  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return sendError(response, 403, 'Forbidden.');
  }

  return new Promise((resolve) => fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Cache-Control': 'no-cache' }).end('Not found');
      resolve();
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    response.end(content);
    resolve();
  }));
}

const server = http.createServer(async (request, response) => {
  addCorsHeaders(request, response);
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendError(response, 405, 'Method not allowed.');
    await serveStatic(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!response.headersSent) sendError(response, error.statusCode || 500, error.statusCode ? error.message : 'The request could not be completed.');
    else response.end();
  }
});

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`G-squad is running at http://localhost:${port}`);
  });
}

module.exports = { server, database, verifyPlisioCallback };