import { SplashScreen } from './vendor/capacitor-splash-screen/index.js';

const ACCOUNT_STORAGE_KEY = 'gsquad_accounts';
const SESSION_STORAGE_KEY = 'gsquad_session';
const HASH_ITERATIONS = 150000;
const API_BASE_URL = document.querySelector('meta[name="api-base-url"]')?.content || '';
const screens = [...document.querySelectorAll('.screen')];
const loginPinDisplay = document.querySelector('#login-pin-display');
const loginMessage = document.querySelector('#login-message');
const registerMessage = document.querySelector('#register-message');
const dashboardMain = document.querySelector('.dashboard-main');
const dashboardPanels = [...document.querySelectorAll('[data-tab-panel]')];
const dashboardTabs = [...document.querySelectorAll('[data-tab]')];
const appToast = document.querySelector('#app-toast');
const toastMark = document.querySelector('#toast-mark');
const toastMessage = document.querySelector('#toast-message');
const loadingOverlay = document.querySelector('#loading-overlay');
let enteredPin = '';
let toastTimeout;
let activeAccount = null;
let activeWallet = { balance: 0, transactions: [] };
let isSaving = false;
let activeInvoice = null;
let invoicePollTimer = null;
let invoiceExpiryTimer = null;
let sessionRestoreStarted = false;

function getAccounts() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function getSavedAccount() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSessionAccount(account) {
  if (account) {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(account));
  }
}

function clearSessionAccount() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

async function apiRequest(path, options = {}) {
  const baseUrl = API_BASE_URL || window.location.origin;
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function notify(message, type = 'success') {
  window.clearTimeout(toastTimeout);
  toastMessage.textContent = message;
  toastMark.textContent = type === 'error' ? '!' : '\u2713';
  appToast.classList.toggle('is-error', type === 'error');
  appToast.setAttribute('aria-hidden', 'false');
  appToast.classList.add('is-visible');
  toastTimeout = window.setTimeout(dismissNotification, 3800);
}

function dismissNotification() {
  appToast.classList.remove('is-visible');
  appToast.setAttribute('aria-hidden', 'true');
}

async function withSavingOverlay(saveAction) {
  if (isSaving) return;
  isSaving = true;
  const startedAt = performance.now();
  loadingOverlay.classList.remove('d-none');
  loadingOverlay.setAttribute('aria-hidden', 'false');
  document.querySelector('#app').setAttribute('aria-busy', 'true');

  try {
    await saveAction();
  } catch {
    notify('Your changes could not be saved. Please try again.', 'error');
  } finally {
    const remainingTime = Math.max(0, 350 - (performance.now() - startedAt));
    if (remainingTime > 0) await new Promise((resolve) => window.setTimeout(resolve, remainingTime));
    loadingOverlay.classList.add('d-none');
    loadingOverlay.setAttribute('aria-hidden', 'true');
    document.querySelector('#app').removeAttribute('aria-busy');
    isSaving = false;
  }
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function renderWallet() {
  document.querySelector('#balance-amount').textContent = formatCurrency(activeWallet.balance);
  document.querySelector('#withdraw-balance').textContent = formatCurrency(activeWallet.balance);
  const activityList = document.querySelector('#activity-list');
  const activityCount = document.querySelector('#activity-count');
  activityList.replaceChildren();
  activityCount.textContent = `${activeWallet.transactions.length} ${activeWallet.transactions.length === 1 ? 'transaction' : 'transactions'}`;

  if (activeWallet.transactions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.innerHTML = '<strong>No activity yet</strong><span>Your deposits and withdrawals will show here.</span>';
    activityList.append(empty);
    return;
  }

  for (const transaction of activeWallet.transactions.slice(0, 8)) {
    const isDeposit = transaction.type === 'deposit';
    const row = document.createElement('div');
    row.className = `activity-row${isDeposit ? '' : ' is-withdraw'}`;
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = isDeposit
      ? '<svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"></path></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M12 5v14m6-6-6 6-6-6"></path></svg>';
    const info = document.createElement('span');
    info.className = 'activity-info';
    const title = document.createElement('strong');
    title.textContent = isDeposit ? 'Deposit' : 'Withdrawal';
    const date = document.createElement('span');
    date.textContent = new Date(transaction.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    info.append(title, date);
    const amount = document.createElement('span');
    amount.className = `activity-amount${isDeposit ? ' is-deposit' : ''}`;
    amount.textContent = `${isDeposit ? '+' : '-'}${formatCurrency(transaction.amount)}`;
    row.append(icon, info, amount);
    activityList.append(row);
  }
}

function setDashboardTab(tabName) {
  for (const panel of dashboardPanels) panel.classList.toggle('d-none', panel.dataset.tabPanel !== tabName);
  for (const button of dashboardTabs) {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle('is-active', isActive);
    if (button.classList.contains('nav-item')) {
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }
  dashboardMain.scrollTop = 0;
}

function showDashboard(account) {
  activeAccount = account;
  activeWallet = { balance: account.balance, transactions: account.transactions || [] };
  const initial = account.username.trim().charAt(0).toUpperCase() || 'G';
  document.querySelector('#dashboard-name').textContent = account.username;
  document.querySelector('#dashboard-avatar').textContent = initial;
  document.querySelector('#settings-avatar').textContent = initial;
  document.querySelector('#settings-name').textContent = account.username;
  document.querySelector('#settings-email').textContent = account.email;
  renderWallet();
  setDashboardTab('home');
  showScreen('dashboard-screen');
}

async function handleWalletTransaction(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = Number(form.elements.amount.value);
  const message = document.querySelector(`#${type}-message`);
  message.textContent = '';

  try {
    if (type === 'deposit') {
      const result = await apiRequest('/api/deposits', {
        method: 'POST',
        body: JSON.stringify({ amount, currency: form.elements.currency.value })
      });
      form.reset();
      showInvoice(result.invoice);
      return;
    }

    const result = await apiRequest('/api/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount, currency: form.elements.currency.value, address: form.elements.address.value })
    });
    const wallet = await apiRequest('/api/wallet');
    activeWallet = wallet;
    renderWallet();
    form.reset();
    setDashboardTab('home');
    notify(`Withdrawal request ${result.withdrawal.id.slice(0, 8)} is pending review.`);
  } catch (error) {
    message.textContent = error.message;
    notify(error.message, 'error');
  }
}

function showInvoice(invoice) {
  activeInvoice = invoice;
  document.querySelector('#invoice-crypto-amount').textContent = invoice.cryptoAmount;
  document.querySelector('#invoice-currency').textContent = invoice.currency;
  document.querySelector('#invoice-fiat-amount').textContent = `${formatCurrency(invoice.amountUsd)} USD`;
  document.querySelector('#invoice-address').textContent = invoice.address;
  document.querySelector('#invoice-rate').textContent = invoice.rate
    ? `1 USD = ${invoice.rate} ${invoice.currency}`
    : 'Rate locked into invoice';
  document.querySelector('#invoice-transaction-id').textContent = invoice.transactionId;
  document.querySelector('#invoice-warning-currency').textContent = invoice.currency;
  setInvoiceStatus(invoice.status);
  setDashboardTab('deposit-details');
  updateInvoiceExpiry();
  window.clearInterval(invoicePollTimer);
  window.clearInterval(invoiceExpiryTimer);
  invoicePollTimer = window.setInterval(() => void refreshInvoiceStatus(), 10000);
  invoiceExpiryTimer = window.setInterval(updateInvoiceExpiry, 1000);
}

function setInvoiceStatus(status) {
  const statusLabels = {
    new: 'Waiting for payment',
    pending: 'Payment received, confirming',
    'pending internal': 'Payment received, confirming',
    completed: 'Payment confirmed',
    expired: 'Invoice expired',
    cancelled: 'Invoice cancelled',
    error: 'Payment error',
    mismatch: 'Payment amount needs review'
  };
  const statusElement = document.querySelector('#invoice-status');
  statusElement.dataset.status = status;
  document.querySelector('#invoice-status-label').textContent = statusLabels[status] || 'Payment status updated';
  if (status === 'completed') {
    window.clearInterval(invoicePollTimer);
    void refreshWallet();
    notify('Your crypto deposit is confirmed.');
  } else if (['expired', 'cancelled', 'error', 'mismatch'].includes(status)) {
    window.clearInterval(invoicePollTimer);
  }
}

function updateInvoiceExpiry() {
  if (!activeInvoice) return;
  const remaining = Math.max(0, activeInvoice.expiresAt * 1000 - Date.now());
  const minutes = Math.floor(remaining / 60000).toString().padStart(2, '0');
  const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
  document.querySelector('#invoice-expiry').textContent = remaining > 0 ? `${minutes}:${seconds}` : 'Expired';
  if (remaining <= 0) window.clearInterval(invoiceExpiryTimer);
}

async function refreshInvoiceStatus() {
  if (!activeInvoice) return;
  try {
    const result = await apiRequest(`/api/deposits/${encodeURIComponent(activeInvoice.transactionId)}`);
    const oldStatus = activeInvoice.status;
    activeInvoice = result.invoice;
    setInvoiceStatus(activeInvoice.status);
    updateInvoiceExpiry();
    if (activeInvoice.status !== oldStatus && activeInvoice.status !== 'completed') {
      notify(`Payment status: ${activeInvoice.status.replaceAll('_', ' ')}.`);
    }
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function refreshWallet() {
  try {
    activeWallet = await apiRequest('/api/wallet');
    renderWallet();
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function restoreSession() {
  try {
    const session = await apiRequest('/api/session');
    const wallet = await apiRequest('/api/wallet');
    const account = { ...session.user, balance: wallet.balance, transactions: wallet.transactions || [] };
    saveSessionAccount(account);
    showDashboard(account);
    return true;
  } catch {
    clearSessionAccount();
    return false;
  }
}

function showScreen(screenId) {
  for (const screen of screens) screen.classList.toggle('d-none', screen.id !== screenId);
  if (screenId === 'login-screen') {
    enteredPin = '';
    updatePinDisplay();
    loginMessage.textContent = '';
  }
  if (screenId === 'register-screen') registerMessage.textContent = '';
}

function updatePinDisplay() {
  const dots = loginPinDisplay.querySelectorAll('.pin-dot');
  dots.forEach((dot, index) => dot.classList.toggle('filled', index < enteredPin.length));
  loginPinDisplay.setAttribute('aria-label', `${enteredPin.length} of 6 digits entered`);
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: HASH_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(derivedBits);
}

function setFormMessage(message) {
  registerMessage.textContent = message;
  if (message) notify(message, 'error');
}

function setLoginMessage(message) {
  loginMessage.textContent = message;
  if (message) notify(message, 'error');
}

async function registerAccount(event) {
  event.preventDefault();
  setFormMessage('');

  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const email = form.elements.email.value.trim().toLowerCase();
  const pin = form.elements.pin.value;
  const confirmPin = form.elements.confirmPin.value;

  if (username.length < 2) return setFormMessage('Please enter a name with at least 2 characters.');
  if (!form.elements.email.validity.valid) return setFormMessage('Please enter a valid email address.');
  if (!/^\d{6}$/.test(pin)) return setFormMessage('Your code must contain exactly 6 digits.');
  if (pin !== confirmPin) return setFormMessage('Those codes do not match. Try again.');

  try {
    const result = await apiRequest('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, pin })
    });
    const user = { ...result.user, balance: 0, transactions: [] };
    saveSessionAccount(user);
    form.reset();
    showDashboard(user);
    notify(`Welcome to G-squad, ${user.username}!`);
    return;
  } catch (error) {
    const accounts = getAccounts();
    if (accounts.some((account) => account.email === email)) {
      return setFormMessage('An account with this email already exists on this device.');
    }
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const pinHash = await hashPin(pin, salt);
    const duplicatePin = await Promise.all(accounts.map(async (account) => (await hashPin(pin, account.salt)) === account.pinHash));
    if (duplicatePin.includes(true)) return setFormMessage('That code is already in use on this device. Choose another.');
    accounts.push({ username, email, salt, pinHash });
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
    form.reset();
    showDashboard({ username, email, balance: 0, transactions: [] });
    notify(`Welcome to G-squad, ${username}!`);
  }
}

async function signIn() {
  loginMessage.textContent = '';
  try {
    const result = await apiRequest('/api/login', {
      method: 'POST',
      body: JSON.stringify({ pin: enteredPin })
    });
    const wallet = await apiRequest('/api/wallet');
    const account = { ...result.user, balance: wallet.balance, transactions: wallet.transactions || [] };
    saveSessionAccount(account);
    showDashboard(account);
    notify(`Welcome back, ${account.username}!`);
    return;
  } catch (error) {
    const accounts = getAccounts();
    if (accounts.length === 0) {
      setLoginMessage('Create an account first to get started.');
      return;
    }

    const accountHashes = await Promise.all(accounts.map(async (account) => ({
      account,
      hash: await hashPin(enteredPin, account.salt)
    })));
    const match = accountHashes.find(({ account, hash }) => hash === account.pinHash);
    if (!match) {
      enteredPin = '';
      updatePinDisplay();
      setLoginMessage('That code did not match. Give it another try.');
      return;
    }

    saveSessionAccount(match.account);
    showDashboard({ ...match.account, balance: 0, transactions: [] });
    notify(`Welcome back, ${match.account.username}!`);
  }
}

function handleDigit(digit) {
  if (enteredPin.length >= 6) return;
  enteredPin += digit;
  updatePinDisplay();
  loginMessage.textContent = '';
  if (enteredPin.length === 6) void signIn();
}

document.querySelectorAll('[data-screen]').forEach((button) => {
  button.addEventListener('click', () => showScreen(button.dataset.screen === 'login' ? 'login-screen' : 'register-screen'));
});

document.querySelector('.keypad').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.action === 'delete') {
    enteredPin = enteredPin.slice(0, -1);
    loginMessage.textContent = '';
    updatePinDisplay();
    return;
  }
  if (button.dataset.digit) handleDigit(button.dataset.digit);
});

document.addEventListener('keydown', (event) => {
  if (document.querySelector('#login-screen').classList.contains('d-none')) return;
  if (/^\d$/.test(event.key)) handleDigit(event.key);
  if (event.key === 'Backspace') {
    enteredPin = enteredPin.slice(0, -1);
    updatePinDisplay();
  }
});

document.querySelector('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void withSavingOverlay(() => registerAccount(event));
});
document.querySelector('#deposit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void withSavingOverlay(() => handleWalletTransaction(event, 'deposit'));
});
document.querySelector('#withdraw-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void withSavingOverlay(() => handleWalletTransaction(event, 'withdraw'));
});
document.querySelectorAll('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => setDashboardTab(button.dataset.tab));
});
document.querySelectorAll('[data-amount]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('#deposit-amount').value = button.dataset.amount;
  });
});
document.querySelector('#sign-out').addEventListener('click', async () => {
  try {
    await apiRequest('/api/logout', { method: 'POST' });
  } catch {
    // Keep the sign-out flow working locally even if the session is already stale.
  }
  clearSessionAccount();
  activeAccount = null;
  activeWallet = { balance: 0, transactions: [] };
  showScreen('login-screen');
  notify('You have been signed out.');
});
document.querySelector('#toast-close').addEventListener('click', () => {
  window.clearTimeout(toastTimeout);
  dismissNotification();
});

showScreen('splash-screen');
document.body.classList.remove('splash-pending');

async function handOffNativeSplash() {
  const logo = document.querySelector('.splash-logo');
  if (logo && typeof logo.decode === 'function') await logo.decode().catch(() => {});
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  await SplashScreen.hide().catch(() => {});
}

void handOffNativeSplash();

const splashDuration = 10000;
const splashStartedAt = Date.now();
const progressBar = document.querySelector('#loading-progress');
const countdown = document.querySelector('#loading-countdown');

async function finishSplashSequence() {
  const savedAccount = getSavedAccount();
  if (savedAccount) {
    showDashboard(savedAccount);
    return;
  }
  const restored = await restoreSession();
  if (!restored) showScreen('login-screen');
}

function updateSplash() {
  const elapsed = Date.now() - splashStartedAt;
  const progress = Math.min(elapsed / splashDuration, 1);
  progressBar.style.width = `${progress * 100}%`;
  countdown.textContent = String(Math.ceil((splashDuration - elapsed) / 1000));
  if (progress >= 1) {
    void finishSplashSequence();
    return;
  }
  requestAnimationFrame(updateSplash);
}

requestAnimationFrame(updateSplash);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}