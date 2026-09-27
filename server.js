const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const store = require('./lib/store');
const manager = require('./lib/manager');

const PORT = Number(process.env.PORT) || 3780;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

manager.attach(io);
app.use(express.json({ limit: '1mb' }));

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(handler => (
    typeof handler === 'function'
      ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
      : handler
  )));
}

function send(res, body) {
  res.json(body);
}

function setSession(res, token) {
  const maxAge = store.SESSION_SECONDS;
  res.setHeader(
    'Set-Cookie',
    `${store.COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

function clearSession(res) {
  res.setHeader(
    'Set-Cookie',
    `${store.COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function owned(req) {
  return store.assertOwned(req.userId, req.params.id);
}

app.get('/api/health', (_req, res) => {
  send(res, { ok: true });
});

app.get('/api/auth/me', (req, res) => {
  send(res, {
    user: store.userFromCookie(req.headers.cookie),
    accountCount: store.accountCount(),
    claim: store.hasLegacy(),
  });
});

app.post('/api/auth/register', (req, res) => {
  const user = store.register(req.body || {});
  setSession(res, store.createSession(user.id));
  manager.resumeUser(user.id);
  send(res, { user });
});

app.post('/api/auth/login', (req, res) => {
  const user = store.login(req.body || {});
  setSession(res, store.createSession(user.id));
  send(res, { user });
});

app.post('/api/auth/logout', (req, res) => {
  const token = String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${store.COOKIE_NAME}=`));
  if (token) {
    try {
      store.destroySession(decodeURIComponent(token.slice(store.COOKIE_NAME.length + 1)));
    } catch {
      store.destroySession('');
    }
  }
  clearSession(res);
  send(res, { ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  const user = store.userFromCookie(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Sign in first' });
  req.userId = user.id;
  next();
});

app.get('/api/state', (req, res) => {
  send(res, manager.state(req.userId));
});

app.put('/api/settings', (req, res) => {
  const api = store.setApi(req.userId, {
    apiKey: req.body?.apiKey,
    baseUrl: req.body?.baseUrl,
    clearKey: Boolean(req.body?.clearKey),
  });
  send(res, { api });
});

app.post('/api/settings/test', async (req, res, next) => {
  try {
    const creds = store.resolveCredentials(req.userId, {
      apiKey: req.body?.apiKey,
      baseUrl: req.body?.baseUrl,
    });
    if (!creds.apiKey) throw store.httpError('Paste an API key first');
    const models = await manager.listModels(creds.apiKey, creds.baseUrl);
    send(res, { ok: true, count: models.length, models });
  } catch (err) {
    if (err.statusCode) return next(err);
    next(store.httpError(manager.safeError(err)));
  }
});

app.get('/api/models', async (req, res, next) => {
  try {
    const { apiKey, baseUrl } = store.getApi(req.userId);
    if (!apiKey) throw store.httpError('Add an API key first');
    const models = await manager.listModels(apiKey, baseUrl);
    send(res, { models });
  } catch (err) {
    if (err.statusCode) return next(err);
    next(store.httpError(manager.safeError(err)));
  }
});

app.post('/api/bots', (req, res) => {
  const bot = store.createBot(req.userId, {
    name: req.body?.name,
    ownerName: req.body?.ownerName,
  });
  io.to(`user:${req.userId}`).emit('bots:changed');
  send(res, { bot: manager.publicBot(bot) });
});

app.patch('/api/bots/:id', (req, res) => {
  owned(req);
  const bot = store.updateBot(req.params.id, {
    name: req.body?.name,
    settings: req.body?.settings,
  });
  if (!bot) throw store.httpError('Bot not found', 404);
  io.to(`user:${req.userId}`).emit('bots:changed');
  send(res, { bot: manager.publicBot(bot) });
});

app.delete('/api/bots/:id', async (req, res, next) => {
  try {
    owned(req);
    send(res, await manager.remove(req.params.id));
  } catch (err) {
    next(err);
  }
});

app.post('/api/bots/:id/start', (req, res, next) => {
  try {
    owned(req);
    send(res, { bot: manager.start(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/bots/:id/stop', async (req, res, next) => {
  try {
    owned(req);
    send(res, { bot: await manager.stop(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/bots/:id/unlink', async (req, res, next) => {
  try {
    owned(req);
    send(res, { bot: await manager.unlink(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bots/:id/chats', async (req, res, next) => {
  try {
    owned(req);
    send(res, { chats: await manager.listChats(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bots/:id/groups', async (req, res, next) => {
  try {
    owned(req);
    send(res, { groups: await manager.groups(req.params.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bots/:id/chats/:chatId/messages', async (req, res, next) => {
  try {
    owned(req);
    send(res, { messages: await manager.history(req.params.id, req.params.chatId) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/bots/:id/chats/:chatId/messages', async (req, res, next) => {
  try {
    owned(req);
    send(res, { message: await manager.send(req.params.id, req.params.chatId, req.body?.body) });
  } catch (err) {
    next(err);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  },
}));

app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  if (!err.statusCode) console.error(err);
  res.status(status).json({
    error: err.statusCode ? err.message : 'Something went wrong',
  });
});

io.use((socket, next) => {
  const user = store.userFromCookie(socket.handshake.headers.cookie);
  if (!user) return next(new Error('Sign in first'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', socket => {
  socket.join(`user:${socket.data.userId}`);
  socket.emit('desk:ready');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Booth desk  http://127.0.0.1:${PORT}`);
  manager.resume();
});
