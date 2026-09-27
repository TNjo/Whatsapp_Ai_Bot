const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BOOTH_DATA
  ? path.resolve(process.env.BOOTH_DATA)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const COOKIE_NAME = 'booth';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';

function defaultSettings() {
  return {
    ownerName: 'Me',
    systemPrompt: '',
    model: DEFAULT_MODEL,
    maxReplies: 3,
    resetMinutes: 60,
    autoReply: true,
    commandsEnabled: true,
    ignoreGroups: true,
    groupsOnlyWhenMentioned: true,
    ignoreBusiness: true,
    ignoreSavedContacts: true,
    ignoreStatus: true,
    excludedNumbers: [],
    excludedGroups: [],
  };
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function clip(value, max) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function flag(value, fallback) {
  if (typeof value === 'boolean') return value;
  return Boolean(fallback);
}

function cleanModel(value) {
  const model = String(value || '').trim();
  if (/^[\w./:-]{1,80}$/.test(model)) return model;
  return DEFAULT_MODEL;
}

function sanitizeNumbers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const n = String(item).replace(/\D/g, '');
    if (n.length < 8 || n.length > 16) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= 100) break;
  }
  return out;
}

function sanitizeGroups(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '');
    const name = String(item.name || 'Group').trim().slice(0, 80) || 'Group';
    if (!/^[\w:.-]{1,120}@[\w.]{1,40}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= 200) break;
  }
  return out;
}

function sanitizeSettings(input = {}, prev = {}) {
  const base = { ...defaultSettings(), ...prev };
  const src = input || {};
  return {
    ownerName: clip(src.ownerName ?? base.ownerName, 60) || 'Me',
    systemPrompt: String(src.systemPrompt ?? base.systemPrompt ?? '').slice(0, 4000),
    model: cleanModel(src.model ?? base.model),
    maxReplies: clamp(src.maxReplies ?? base.maxReplies, 1, 30),
    resetMinutes: clamp(src.resetMinutes ?? base.resetMinutes, 1, 10080),
    autoReply: flag(src.autoReply, base.autoReply),
    commandsEnabled: flag(src.commandsEnabled, base.commandsEnabled),
    ignoreGroups: flag(src.ignoreGroups, base.ignoreGroups),
    groupsOnlyWhenMentioned: flag(src.groupsOnlyWhenMentioned, base.groupsOnlyWhenMentioned),
    ignoreBusiness: flag(src.ignoreBusiness, base.ignoreBusiness),
    ignoreSavedContacts: flag(src.ignoreSavedContacts, base.ignoreSavedContacts),
    ignoreStatus: flag(src.ignoreStatus, base.ignoreStatus),
    excludedNumbers: sanitizeNumbers(src.excludedNumbers ?? base.excludedNumbers),
    excludedGroups: sanitizeGroups(src.excludedGroups ?? base.excludedGroups),
  };
}

function cleanName(value) {
  const name = clip(value, 40);
  if (!name) throw httpError('Give the bot a name up to 40 characters');
  return name;
}

function cleanBaseUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) raw = DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError('Enter a full model API URL, including https://');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw httpError('Use https. http is only allowed for localhost.');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
  return url.origin + pathname;
}

function cleanKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length > 400 || /\s/.test(key)) throw httpError('That API key does not look valid');
  return key;
}

function mask(key) {
  if (!key) return '';
  return key.slice(-4);
}

function seedFromEnv() {
  const key = String(process.env.GROQ_API_KEY || '').trim();
  if (!key || key === 'your_groq_api_key_here') return '';
  return key;
}

function freshConfig() {
  return {
    users: [],
    legacy: {
      apiKey: seedFromEnv(),
      baseUrl: DEFAULT_BASE,
      bots: [],
    },
  };
}

function normalizeBot(bot) {
  return {
    id: String(bot.id),
    name: clip(bot.name, 40) || 'WhatsApp',
    createdAt: bot.createdAt || new Date().toISOString(),
    desiredRunning: Boolean(bot.desiredRunning),
    linked: bot.linked && bot.linked.wid
      ? {
          pushname: clip(bot.linked.pushname, 80),
          wid: String(bot.linked.wid).replace(/\D/g, ''),
          platform: clip(bot.linked.platform, 40),
        }
      : null,
    settings: sanitizeSettings(bot.settings, defaultSettings()),
  };
}

function load() {
  if (!fs.existsSync(FILE)) return freshConfig();
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (err) {
    const backup = `${FILE}.bak`;
    try {
      fs.renameSync(FILE, backup);
    } catch {
      // keep going with a new file
    }
    console.error('Config was unreadable and was moved aside:', err.message);
    return freshConfig();
  }
}

function normalizeUser(user) {
  return {
    id: String(user.id),
    username: String(user.username || '').trim().toLowerCase(),
    passwordHash: String(user.passwordHash || ''),
    createdAt: user.createdAt || new Date().toISOString(),
    apiKey: typeof user.apiKey === 'string' ? user.apiKey : '',
    baseUrl: typeof user.baseUrl === 'string' && user.baseUrl ? user.baseUrl : DEFAULT_BASE,
    bots: Array.isArray(user.bots) ? user.bots.filter(bot => bot && bot.id).map(normalizeBot) : [],
  };
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(source.users)) {
    return {
      users: source.users
        .filter(user => user && user.id && user.username && user.passwordHash)
        .map(normalizeUser),
      legacy: null,
    };
  }
  return {
    users: [],
    legacy: {
      apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
      baseUrl: typeof source.baseUrl === 'string' && source.baseUrl ? source.baseUrl : DEFAULT_BASE,
      bots: Array.isArray(source.bots) ? source.bots.filter(bot => bot && bot.id).map(normalizeBot) : [],
    },
  };
}

let config = load();
const sessions = new Map();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, FILE);
}

function loadSessions() {
  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(raw)) return;
  const now = Date.now();
  for (const item of raw) {
    if (!item || !item.hash || !item.userId || !(item.expires > now)) continue;
    if (!config.users.some(user => user.id === item.userId)) continue;
    sessions.set(item.hash, { userId: item.userId, expires: item.expires });
  }
}

function saveSessions() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const list = [...sessions.entries()].map(([hash, value]) => ({ hash, userId: value.userId, expires: value.expires }));
  const tmp = `${SESSION_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, SESSION_FILE);
}

loadSessions();
if (!fs.existsSync(FILE)) save();

function findUser(userId) {
  return config.users.find(user => user.id === userId) || null;
}

function requireUser(userId) {
  const user = findUser(userId);
  if (!user) throw httpError('Sign in first', 401);
  return user;
}

function publicUser(userId) {
  const user = findUser(userId);
  if (!user) return null;
  return { id: user.id, username: user.username };
}

function userIds() {
  return config.users.map(user => user.id);
}

function accountCount() {
  return config.users.length;
}

function hasLegacy() {
  return Boolean(config.legacy && (config.legacy.apiKey || config.legacy.bots.length));
}

function cleanUsername(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) {
    throw httpError('Username must be 3 to 32 letters, numbers, dots, or dashes');
  }
  return name;
}

function cleanPassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 200) throw httpError('Password must be at least 8 characters');
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash || hash.length % 2 !== 0) return false;
  const next = crypto.scryptSync(String(password || ''), salt, 64);
  const prev = Buffer.from(hash, 'hex');
  if (next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

function register({ username, password } = {}) {
  const name = cleanUsername(username);
  const secret = cleanPassword(password);
  if (config.users.some(user => user.username === name)) throw httpError('That username is already taken');
  const first = config.users.length === 0;
  const legacy = first ? config.legacy : null;
  const user = normalizeUser({
    id: `user_${crypto.randomBytes(6).toString('hex')}`,
    username: name,
    passwordHash: hashPassword(secret),
    createdAt: new Date().toISOString(),
    apiKey: legacy ? legacy.apiKey : '',
    baseUrl: legacy ? legacy.baseUrl : DEFAULT_BASE,
    bots: legacy ? legacy.bots : [],
  });
  config.users.push(user);
  if (first) config.legacy = null;
  save();
  return publicUser(user.id);
}

function login({ username, password } = {}) {
  const name = String(username || '').trim().toLowerCase();
  const user = config.users.find(item => item.username === name);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw httpError('Username or password is wrong', 401);
  }
  return publicUser(user.id);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(userId) {
  requireUser(userId);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(tokenHash(token), { userId, expires: Date.now() + SESSION_SECONDS * 1000 });
  saveSessions();
  return token;
}

function destroySession(token) {
  if (!token) return;
  sessions.delete(tokenHash(token));
  saveSessions();
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function userFromCookie(header) {
  const token = readCookie(header, COOKIE_NAME);
  if (!token) return null;
  const hash = tokenHash(token);
  const session = sessions.get(hash);
  if (!session || session.expires <= Date.now()) {
    if (session) {
      sessions.delete(hash);
      saveSessions();
    }
    return null;
  }
  return publicUser(session.userId);
}

function publicApi(userId) {
  const user = requireUser(userId);
  return {
    configured: Boolean(user.apiKey),
    hint: mask(user.apiKey),
    baseUrl: user.baseUrl,
  };
}

function getApi(userId) {
  const user = requireUser(userId);
  return { apiKey: user.apiKey, baseUrl: user.baseUrl };
}

function ownerOfBot(botId) {
  return config.users.find(user => user.bots.some(bot => bot.id === botId)) || null;
}

function getApiForBot(botId) {
  const user = ownerOfBot(botId);
  return {
    apiKey: user?.apiKey || '',
    baseUrl: user?.baseUrl || DEFAULT_BASE,
  };
}

function resolveCredentials(userId, { apiKey, baseUrl, clearKey } = {}) {
  const user = requireUser(userId);
  const nextUrl = baseUrl == null ? user.baseUrl : cleanBaseUrl(baseUrl);
  let nextKey = user.apiKey;
  if (clearKey) nextKey = '';
  else if (typeof apiKey === 'string' && apiKey.trim()) nextKey = cleanKey(apiKey);
  return { apiKey: nextKey, baseUrl: nextUrl };
}

function setApi(userId, input) {
  const user = requireUser(userId);
  const next = resolveCredentials(userId, input);
  user.apiKey = next.apiKey;
  user.baseUrl = next.baseUrl;
  save();
  return publicApi(userId);
}

function list(userId) {
  if (!userId) return config.users.flatMap(user => user.bots);
  return findUser(userId)?.bots || [];
}

function getBot(id) {
  for (const user of config.users) {
    const bot = user.bots.find(item => item.id === id);
    if (bot) return bot;
  }
  return null;
}

function assertOwned(userId, botId) {
  const user = requireUser(userId);
  const bot = user.bots.find(item => item.id === botId);
  if (!bot) throw httpError('Bot not found', 404);
  return bot;
}

function createBot(userId, { name, ownerName }) {
  const user = requireUser(userId);
  const bot = normalizeBot({
    id: `bot_${crypto.randomBytes(6).toString('hex')}`,
    name: cleanName(name),
    createdAt: new Date().toISOString(),
    desiredRunning: false,
    linked: null,
    settings: sanitizeSettings({ ownerName: ownerName || 'Me' }, defaultSettings()),
  });
  user.bots.push(bot);
  save();
  return bot;
}

function updateBot(id, patch) {
  const bot = getBot(id);
  if (!bot) return null;
  if (patch.name != null) bot.name = cleanName(patch.name);
  if (patch.desiredRunning != null) bot.desiredRunning = Boolean(patch.desiredRunning);
  if (patch.linked !== undefined) {
    bot.linked = patch.linked;
    bot.linked = normalizeBot({ ...bot, linked: patch.linked }).linked;
  }
  if (patch.settings) bot.settings = sanitizeSettings(patch.settings, bot.settings);
  save();
  return bot;
}

function removeBot(id) {
  let removed = false;
  for (const user of config.users) {
    const before = user.bots.length;
    user.bots = user.bots.filter(bot => bot.id !== id);
    if (user.bots.length !== before) removed = true;
  }
  if (!removed) return false;
  save();
  return true;
}

module.exports = {
  DEFAULT_MODEL,
  COOKIE_NAME,
  SESSION_SECONDS,
  publicApi,
  getApi,
  getApiForBot,
  resolveCredentials,
  setApi,
  list,
  getBot,
  assertOwned,
  ownerOfBot,
  createBot,
  updateBot,
  removeBot,
  cleanName,
  httpError,
  register,
  login,
  createSession,
  destroySession,
  userFromCookie,
  publicUser,
  userIds,
  accountCount,
  hasLegacy,
};
