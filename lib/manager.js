const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const SESSIONS = path.join(ROOT, 'sessions');
const BOT_MARK = '\u2060';
const NOISE = new Set([
  'e2e_notification',
  'notification_template',
  'gp2',
  'protocol',
  'ciphertext',
  'revoked',
]);

const clients = new Map();
const runtimes = new Map();
const transcripts = new Map();
const seen = new Map();
const names = new Map();
const trackers = new Map();
const keyNotes = new Map();

let io = null;

function attach(socketIo) {
  io = socketIo;
}

function runtimeOf(id) {
  if (!runtimes.has(id)) {
    runtimes.set(id, {
      status: 'stopped',
      error: null,
      qr: null,
      logs: [],
      preview: null,
      info: null,
      readyAt: 0,
    });
  }
  return runtimes.get(id);
}

function bucket(map, id, factory) {
  if (!map.has(id)) map.set(id, factory());
  return map.get(id);
}

function publicRuntime(id) {
  const rt = runtimeOf(id);
  return {
    status: rt.status,
    error: rt.error,
    qr: rt.qr,
    logs: rt.logs,
    preview: rt.preview,
    info: rt.info,
  };
}

function publicBot(bot) {
  const rt = runtimeOf(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    createdAt: bot.createdAt,
    desiredRunning: Boolean(bot.desiredRunning),
    linked: bot.linked,
    settings: bot.settings,
    runtime: {
      ...publicRuntime(bot.id),
      info: rt.info || bot.linked,
    },
  };
}

function state(userId) {
  return {
    user: store.publicUser(userId),
    api: store.publicApi(userId),
    bots: store.list(userId).map(publicBot),
  };
}

function emitToOwner(botId, event, payload) {
  if (!io) return;
  const owner = store.ownerOfBot(botId);
  if (!owner) return;
  io.to(`user:${owner.id}`).emit(event, payload);
}

function emitRuntime(id) {
  const bot = store.getBot(id);
  emitToOwner(id, 'bot:runtime', {
    botId: id,
    desiredRunning: Boolean(bot?.desiredRunning),
    linked: bot?.linked || null,
    runtime: publicRuntime(id),
  });
}

function pushLog(id, message) {
  const rt = runtimeOf(id);
  rt.logs.push({ at: Date.now(), message: String(message).slice(0, 240) });
  if (rt.logs.length > 40) rt.logs.shift();
  emitRuntime(id);
}

function safeError(err) {
  const message = err?.response?.data?.error?.message || err?.message || 'Request failed';
  return String(message).replace(/\s+/g, ' ').slice(0, 300);
}

function sessionPath(id) {
  return path.join(SESSIONS, `session-${id}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rmDir(dir) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      await sleep(400);
    }
  }
  throw last;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error('Timed out');
    }),
  ]);
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function numberBlocked(settings, raw) {
  const value = digits(raw);
  if (value.length < 8) return false;
  return settings.excludedNumbers.some(n => value === n || value.endsWith(n) || n.endsWith(value));
}

function senderKey(raw) {
  return digits(raw) || String(raw || '');
}

function isMentioned(msg, client) {
  const myUser = client.info?.wid?.user;
  const myId = client.info?.wid?._serialized;
  const ids = []
    .concat(msg.mentionedIds || [])
    .map(item => (typeof item === 'string' ? item : item?._serialized || item?.user || ''))
    .filter(Boolean);
  if (myId && ids.includes(myId)) return true;
  if (myUser && ids.some(value => String(value).includes(myUser))) return true;
  if (myUser && msg.body && msg.body.includes(`@${myUser}`)) return true;
  return false;
}

function placeholder(type) {
  const labels = {
    image: 'Photo',
    video: 'Video',
    audio: 'Audio',
    ptt: 'Voice message',
    sticker: 'Sticker',
    document: 'Document',
    location: 'Location',
    vcard: 'Contact card',
  };
  return labels[type] ? `[${labels[type]}]` : '';
}

function replyText(data) {
  const message = data?.choices?.[0]?.message;
  let text = '';
  if (typeof message?.content === 'string') text = message.content;
  else if (Array.isArray(message?.content)) {
    text = message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n');
  }
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 4000);
}

function systemPrompt(settings) {
  const custom = String(settings.systemPrompt || '').trim();
  if (custom) return custom;
  const name = settings.ownerName || 'the owner';
  return `You are ${name}'s personal WhatsApp assistant. ${name} is busy right now. Be brief and warm. If the person leaves a message, confirm you will pass it on.`;
}

function helpText(settings) {
  const name = String(settings.ownerName || 'Me').replace(/[*_~`]/g, '').slice(0, 60);
  return `*${name}'s assistant*\n\n*Commands*\n• --help\n• --reset\n• !ai <question>\n\nI auto-reply up to ${settings.maxReplies} times, then pause for ${settings.resetMinutes} minutes.`;
}

async function askModel(botId, model, question, system) {
  const { apiKey, baseUrl } = store.getApiForBot(botId);
  if (!apiKey) throw new Error('Add a model API key in the desk before the bot can reply');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    {
      role: 'system',
      content: `${system}\n\nWrite for WhatsApp: plain text, short, no headings, same language as the person.`,
    },
    { role: 'user', content: question },
  ];
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const post = body => axios.post(url, body, { headers, timeout: 45000 });
  const payload = { model, messages, temperature: 0.5, max_tokens: 1500 };
  if (String(model).includes('gpt-oss')) payload.reasoning_effort = 'low';
  let data;
  try {
    data = (await post(payload)).data;
  } catch (err) {
    const message = safeError(err);
    if (/temperature|max_tokens|max_completion|reasoning_effort/i.test(message)) {
      data = (await post({ model, messages })).data;
    } else {
      throw err;
    }
  }
  const text = replyText(data);
  if (!text) throw new Error('The model returned an empty reply');
  return text;
}

async function chatMeta(botId, msg, chatId) {
  const cache = bucket(names, botId, () => new Map());
  if (cache.has(chatId)) return cache.get(chatId);
  try {
    const chat = await msg.getChat();
    const meta = {
      name: chat.name || chatId,
      isGroup: Boolean(chat.isGroup),
    };
    cache.set(chat.id?._serialized || chatId, meta);
    return meta;
  } catch {
    const meta = { name: chatId, isGroup: String(chatId).endsWith('@g.us') };
    cache.set(chatId, meta);
    return meta;
  }
}

async function record(botId, msg, opts = {}) {
  if (!msg) return null;
  const id = msg.id?._serialized || msg.id?.id;
  if (!id) return null;
  if (NOISE.has(msg.type)) return null;

  const list = bucket(transcripts, botId, () => []);
  const known = bucket(seen, botId, () => new Set());
  const existing = list.find(item => item.id === id);
  if (existing) return existing;

  let body = typeof msg.body === 'string' ? msg.body : '';
  let via = 'them';
  if (body.endsWith(BOT_MARK)) {
    body = body.slice(0, -BOT_MARK.length).trimEnd();
    via = 'bot';
  } else if (msg.fromMe) {
    via = 'you';
  }
  if (!body) body = placeholder(msg.type);
  if (!body) return null;

  const chatId = opts.chatId || (msg.fromMe ? msg.to : msg.from);
  if (!chatId || String(chatId).includes('broadcast')) return null;

  let chatName = opts.chatName;
  let isGroup = opts.isGroup;
  if (chatName == null) {
    const meta = await chatMeta(botId, msg, chatId);
    chatName = meta.name;
    isGroup = meta.isGroup;
  }

  known.add(id);
  const entry = {
    id,
    chatId,
    chatName: chatName || chatId,
    isGroup: Boolean(isGroup),
    body,
    fromMe: Boolean(msg.fromMe),
    via,
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    type: msg.type || 'chat',
  };
  list.push(entry);
  while (list.length > 400) {
    const old = list.shift();
    known.delete(old.id);
  }

  runtimeOf(botId).preview = {
    chatId: entry.chatId,
    chatName: entry.chatName,
    body: entry.body.slice(0, 140),
    fromMe: entry.fromMe,
    via: entry.via,
    timestamp: entry.timestamp,
    isGroup: entry.isGroup,
  };

  if (opts.emit !== false) {
    emitToOwner(botId, 'bot:message', { botId, message: entry, preview: runtimeOf(botId).preview });
  }
  return entry;
}

function transcriptFor(botId, chatId) {
  return bucket(transcripts, botId, () => [])
    .filter(item => item.chatId === chatId)
    .slice(-80);
}

async function replyMarked(msg, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  await msg.reply(`${clean}${BOT_MARK}`);
}

async function isSavedContact(client, chatId) {
  if (!client.pupPage || !chatId) return false;
  try {
    return await client.pupPage.evaluate(async id => {
      try {
        const wid = window.require('WAWebWidFactory').createWid(id);
        const book = window.require('WAWebCollections').Contact;
        let contact = book.get(wid);
        if (!contact && book.find) contact = await book.find(wid);
        if (!contact) return false;
        try {
          const { getIsMyContact } = window.require('WAWebFrontendContactGetters');
          if (typeof getIsMyContact === 'function') return Boolean(getIsMyContact(contact));
        } catch {
          // older builds expose the flag on the contact
        }
        return Boolean(contact.isAddressBookContact || contact.isMyContact);
      } catch {
        return false;
      }
    }, chatId);
  } catch {
    return false;
  }
}

async function chatFlags(client, chatId) {
  const fallback = { isGroup: String(chatId).endsWith('@g.us'), isBusiness: false };
  if (!client.pupPage) return fallback;
  try {
    return await client.pupPage.evaluate(id => {
      const isGroup = String(id).endsWith('@g.us');
      try {
        const wid = window.require('WAWebWidFactory').createWid(id);
        const chat = window.require('WAWebCollections').Chat.get(wid);
        if (!chat) return { isGroup, isBusiness: false };
        let isBusiness = false;
        try {
          const getters = window.require('WAWebChatGetters');
          if (typeof getters.getIsBusiness === 'function') isBusiness = Boolean(getters.getIsBusiness(chat));
          else isBusiness = Boolean(chat.contact?.isBusiness);
        } catch {
          isBusiness = false;
        }
        return { isGroup, isBusiness };
      } catch {
        return { isGroup, isBusiness: false };
      }
    }, chatId);
  } catch {
    return fallback;
  }
}

function noteMissingKey(id) {
  const now = Date.now();
  if (now - (keyNotes.get(id) || 0) < 60000) return;
  keyNotes.set(id, now);
  pushLog(id, 'Message skipped. Add a model API key so this bot can reply.');
}

const repliedIds = new Map();
const ownNoteAt = new Map();
const savedNoteAt = new Map();

async function handleIncoming(id, client, msg) {
  if (!msg) return;
  const messageId = msg.id?._serialized || msg.id?.id;
  if (messageId) {
    const seenReplies = bucket(repliedIds, id, () => new Set());
    if (seenReplies.has(messageId)) return;
    seenReplies.add(messageId);
    if (seenReplies.size > 2000) seenReplies.clear();
  }
  if (msg.fromMe) {
    const now = Date.now();
    if (now - (ownNoteAt.get(id) || 0) > 60000) {
      ownNoteAt.set(id, now);
      pushLog(id, 'Skipped your own message. The bot replies only when someone else writes to this WhatsApp.');
    }
    return;
  }
  const rt = runtimeOf(id);
  if (rt.readyAt && msg.timestamp * 1000 < rt.readyAt - 2000) return;
  if (msg.isStatus || msg.broadcast) return;
  if (String(msg.from || '').includes('broadcast') || String(msg.from || '').endsWith('@newsletter')) return;
  if (NOISE.has(msg.type)) return;

  const bot = store.getBot(id);
  if (!bot) return;
  const settings = bot.settings;
  const chatId = String(msg.from || '');
  const flags = await chatFlags(client, chatId);

  const sender = msg.author || msg.from || '';
  if (numberBlocked(settings, sender) || numberBlocked(settings, msg.from)) {
    pushLog(id, 'Skipped a number on the exclude list.');
    return;
  }

  if (flags.isGroup) {
    if (settings.ignoreGroups) return;
    if (settings.excludedGroups.some(group => group.id === chatId)) return;
    if (settings.groupsOnlyWhenMentioned && !isMentioned(msg, client)) return;
  } else if (settings.ignoreBusiness && flags.isBusiness) {
    pushLog(id, 'Skipped a business chat.');
    return;
  }

  const text = String(msg.body || '').trim();
  if (!text) return;
  const lower = text.toLowerCase();

  if (settings.commandsEnabled) {
    if (lower === '--help' || lower === 'help' || lower === '-help') {
      await replyMarked(msg, helpText(settings));
      return;
    }
    if (lower === '--reset' || lower === 'reset' || lower === '-reset') {
      bucket(trackers, id, () => new Map()).delete(senderKey(sender));
      await replyMarked(msg, 'Conversation reset. I can reply again.');
      return;
    }
    if (lower.startsWith('!ai ') || lower === '!ai') {
      const question = text.replace(/^!ai\s+/i, '').trim();
      if (!question) {
        await replyMarked(msg, 'Add a question after !ai.');
        return;
      }
      if (!store.getApiForBot(id).apiKey) {
        noteMissingKey(id);
        return;
      }
      const answer = await askModel(
        id,
        settings.model,
        question,
        'You are a helpful assistant. Answer clearly and briefly in plain text.'
      );
      await replyMarked(msg, answer);
      return;
    }
  }

  if (!settings.autoReply) return;
  if (!flags.isGroup && settings.ignoreSavedContacts && await isSavedContact(client, chatId)) {
    const noted = Date.now();
    if (noted - (savedNoteAt.get(id) || 0) > 20000) {
      savedNoteAt.set(id, noted);
      pushLog(id, 'Skipped a saved contact. Unsaved numbers still get a reply.');
    }
    return;
  }
  if (!store.getApiForBot(id).apiKey) {
    noteMissingKey(id);
    return;
  }

  const tracker = bucket(trackers, id, () => new Map());
  const key = senderKey(sender);
  const now = Date.now();
  const windowMs = settings.resetMinutes * 60 * 1000;
  let user = tracker.get(key);
  if (!user || now - user.firstReplyTime > windowMs) {
    user = { count: 0, firstReplyTime: now };
  }
  if (user.count >= settings.maxReplies) return;

  try {
    const answer = await askModel(id, settings.model, text, systemPrompt(settings));
    await replyMarked(msg, answer);
  } catch (err) {
    pushLog(id, safeError(err));
    await replyMarked(msg, 'Sorry, I could not answer that just now.');
  }
  user.count += 1;
  tracker.set(key, user);
}

function failStart(id, err) {
  const rt = runtimeOf(id);
  rt.status = 'error';
  rt.error = safeError(err);
  rt.qr = null;
  store.updateBot(id, { desiredRunning: false });
  const client = clients.get(id);
  clients.delete(id);
  pushLog(id, rt.error);
  if (client) client.destroy().catch(() => {});
}

function wire(id, client) {
  let sawQr = false;
  let sawLoading = false;
  let sawLoaded = false;

  client.on('qr', async qr => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, {
        width: 360,
        margin: 1,
        color: { dark: '#17352a', light: '#ffffff' },
      });
      const rt = runtimeOf(id);
      rt.status = 'qr';
      rt.qr = dataUrl;
      rt.error = null;
      if (!sawQr) {
        sawQr = true;
        pushLog(id, 'QR code is ready to scan');
      } else {
        emitRuntime(id);
      }
    } catch {
      pushLog(id, 'Could not draw the QR code');
    }
  });

  client.on('authenticated', () => {
    const rt = runtimeOf(id);
    rt.status = 'authenticated';
    rt.qr = null;
    pushLog(id, 'Phone accepted the link');
  });

  client.on('auth_failure', message => {
    const rt = runtimeOf(id);
    rt.status = 'error';
    rt.error = String(message || 'Authentication failed');
    rt.qr = null;
    store.updateBot(id, { desiredRunning: false });
    clients.delete(id);
    pushLog(id, rt.error);
    client.destroy().catch(() => {});
  });

  client.on('ready', () => {
    const info = client.info || {};
    const linked = {
      pushname: info.pushname || '',
      wid: info.wid?.user || String(info.wid?._serialized || '').split('@')[0].replace(/\D/g, ''),
      platform: info.platform || '',
    };
    const rt = runtimeOf(id);
    rt.status = 'ready';
    rt.qr = null;
    rt.error = null;
    rt.info = linked;
    rt.readyAt = Date.now();
    store.updateBot(id, { linked, desiredRunning: true });
    pushLog(id, linked.wid ? `Connected as +${linked.wid}` : 'Connected');
  });

  client.on('disconnected', reason => {
    const rt = runtimeOf(id);
    rt.status = 'disconnected';
    rt.qr = null;
    rt.error = reason ? String(reason) : 'Disconnected';
    clients.delete(id);
    pushLog(id, rt.error === 'Disconnected' ? 'Disconnected' : `Disconnected: ${rt.error}`);
    client.destroy().catch(() => {});
  });

  client.on('loading_screen', percent => {
    if (!sawLoading) {
      sawLoading = true;
      pushLog(id, 'WhatsApp is loading');
    } else if (percent >= 100 && !sawLoaded) {
      sawLoaded = true;
      pushLog(id, 'WhatsApp finished loading');
    }
  });

  client.on('message', msg => {
    record(id, msg).catch(() => {});
    handleIncoming(id, client, msg).catch(err => pushLog(id, safeError(err)));
  });

  client.on('message_create', msg => {
    record(id, msg).catch(() => {});
    handleIncoming(id, client, msg).catch(err => pushLog(id, safeError(err)));
  });
}

function start(id) {
  const bot = store.getBot(id);
  if (!bot) throw store.httpError('Bot not found', 404);
  const active = ['starting', 'qr', 'authenticated', 'ready'].includes(runtimeOf(id).status);
  const existing = clients.get(id);
  if (existing && active) return publicBot(store.getBot(id));
  if (existing) {
    clients.delete(id);
    existing.destroy().catch(() => {});
  }

  store.updateBot(id, { desiredRunning: true });
  const rt = runtimeOf(id);
  rt.status = 'starting';
  rt.error = null;
  rt.qr = null;
  pushLog(id, 'Starting the browser');

  let Client;
  let LocalAuth;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
  } catch (err) {
    failStart(id, err);
    return publicBot(store.getBot(id));
  }

  fsSync.mkdirSync(SESSIONS, { recursive: true });
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: SESSIONS }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  });
  clients.set(id, client);
  wire(id, client);
  client.initialize().catch(err => {
    if (!clients.has(id)) return;
    failStart(id, err);
  });
  return publicBot(store.getBot(id));
}

async function stop(id, { intentional = true } = {}) {
  const bot = store.getBot(id);
  if (!bot) throw store.httpError('Bot not found', 404);
  if (intentional) store.updateBot(id, { desiredRunning: false });
  const client = clients.get(id);
  clients.delete(id);
  if (client) {
    try {
      await withTimeout(client.destroy(), 15000);
    } catch {
      // the browser can already be gone
    }
  }
  const rt = runtimeOf(id);
  rt.status = 'stopped';
  rt.qr = null;
  if (intentional) rt.error = null;
  pushLog(id, intentional ? 'Stopped' : 'Paused for shutdown');
  return publicBot(store.getBot(id));
}

async function unlink(id) {
  const bot = store.getBot(id);
  if (!bot) throw store.httpError('Bot not found', 404);
  const client = clients.get(id);
  if (client) {
    try {
      await withTimeout(client.logout(), 15000);
    } catch {
      // logout still clears the local session below
    }
  }
  if (clients.has(id) || store.getBot(id)) {
    try {
      await stop(id, { intentional: true });
    } catch {
      // already stopped by logout
    }
  }
  store.updateBot(id, { linked: null, desiredRunning: false });
  const rt = runtimeOf(id);
  rt.info = null;
  rt.status = 'stopped';
  rt.qr = null;
  try {
    await rmDir(sessionPath(id));
    pushLog(id, 'Unlinked this WhatsApp. The next connect will show a QR code.');
  } catch {
    pushLog(id, 'Stopped, but the saved login is still locked. Try unlink again in a few seconds.');
  }
  return publicBot(store.getBot(id));
}

async function remove(id) {
  const owner = store.ownerOfBot(id);
  if (!store.getBot(id)) throw store.httpError('Bot not found', 404);
  if (clients.has(id)) await stop(id, { intentional: true });
  store.removeBot(id);
  runtimes.delete(id);
  transcripts.delete(id);
  seen.delete(id);
  names.delete(id);
  trackers.delete(id);
  let warning = null;
  try {
    await rmDir(sessionPath(id));
  } catch (err) {
    warning = safeError(err);
  }
  if (io && owner) io.to(`user:${owner.id}`).emit('bots:changed');
  return { ok: true, warning };
}

function resumeUser(userId) {
  for (const bot of store.list(userId)) {
    if (!bot.desiredRunning) continue;
    try {
      start(bot.id);
    } catch (err) {
      console.error(`Could not resume ${bot.name}:`, safeError(err));
    }
  }
}

function resume() {
  for (const userId of store.userIds()) resumeUser(userId);
}

async function stopAll() {
  for (const id of [...clients.keys()]) {
    try {
      await stop(id, { intentional: false });
    } catch (err) {
      console.error(safeError(err));
    }
  }
}

function assertReady(id) {
  const bot = store.getBot(id);
  if (!bot) throw store.httpError('Bot not found', 404);
  if (!clients.has(id) || runtimeOf(id).status !== 'ready') {
    throw store.httpError('Connect this bot before loading chats', 409);
  }
  return clients.get(id);
}

function assertChatId(chatId) {
  if (!/^[\w:.-]{1,120}@[\w.]{1,40}$/.test(String(chatId || ''))) {
    throw store.httpError('Unknown chat');
  }
}

function chatsFromTranscript(botId) {
  const map = new Map();
  for (const msg of bucket(transcripts, botId, () => [])) {
    const prev = map.get(msg.chatId);
    if (prev && (msg.timestamp || 0) < prev.timestamp) continue;
    map.set(msg.chatId, {
      id: msg.chatId,
      name: msg.chatName || 'Chat',
      isGroup: Boolean(msg.isGroup),
      unread: 0,
      timestamp: msg.timestamp || 0,
      lastMessage: String(msg.body || '').replace(/\u2060/g, ''),
    });
  }
  return [...map.values()];
}

async function readChatSummaries(client) {
  return client.pupPage.evaluate(async () => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const summaries = [];
    for (const chat of chats) {
      try {
        const id = chat?.id?._serialized;
        if (!id || String(id).includes('broadcast')) continue;
        let name = '';
        try { name = chat.name || ''; } catch { /* title getters can throw */ }
        if (!name) {
          try { name = chat.formattedTitle || ''; } catch { /* ignore */ }
        }
        if (!name) name = chat.id?.user || 'Chat';
        let lastMessage = '';
        try {
          const models = chat.msgs?.getModelsArray?.() || [];
          const last = models.length ? models[models.length - 1] : null;
          lastMessage = last?.body || last?.caption || '';
        } catch { /* a broken message should not hide the chat */ }
        summaries.push({
          id: String(id),
          name: String(name).slice(0, 120) || 'Chat',
          isGroup: String(id).endsWith('@g.us'),
          unread: Number(chat.unreadCount) || 0,
          timestamp: Number(chat.t) || 0,
          lastMessage: String(lastMessage || '').replace(/\u2060/g, '').slice(0, 500),
        });
      } catch {
        // one chat WhatsApp cannot read should not hide the rest
      }
    }
    return summaries;
  });
}

async function listChats(id) {
  assertReady(id);
  const client = clients.get(id);
  let chats = [];
  let failed = null;
  try {
    chats = await readChatSummaries(client);
  } catch (err) {
    failed = safeError(err);
    console.error('Chat list failed:', failed);
    chats = [];
  }
  const seen = new Set(chats.map(chat => chat.id));
  for (const extra of chatsFromTranscript(id)) {
    if (!seen.has(extra.id)) chats.push(extra);
  }
  if (!chats.length && failed) {
    throw store.httpError('WhatsApp did not return the chat list. Open Chats again in a few seconds.', 502);
  }
  return chats
    .filter(chat => chat.id && !String(chat.id).includes('broadcast'))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 80);
}

async function groups(id) {
  assertReady(id);
  const client = clients.get(id);
  let chats = [];
  try {
    chats = await readChatSummaries(client);
  } catch (err) {
    throw store.httpError('WhatsApp did not return the group list. Try again in a few seconds.', 502);
  }
  return chats
    .filter(chat => chat.isGroup)
    .map(chat => ({ id: chat.id, name: chat.name || 'Group' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readChatMessages(client, chatId, limit) {
  return client.pupPage.evaluate(async (targetId, max) => {
    const wid = window.require('WAWebWidFactory').createWid(targetId);
    const chat = window.require('WAWebCollections').Chat.get(wid);
    if (!chat) {
      return { name: targetId, isGroup: String(targetId).endsWith('@g.us'), messages: [] };
    }
    let name = targetId;
    try { name = chat.formattedTitle || chat.name || chat.id?.user || targetId; } catch { name = chat.id?.user || targetId; }
    try {
      const loader = window.require('WAWebChatLoadMessages');
      const have = chat.msgs?.getModelsArray?.().length || 0;
      if (have < max && loader?.loadEarlierMsgs) await loader.loadEarlierMsgs(chat, chat.msgs);
    } catch { /* cached messages are enough */ }
    const models = (chat.msgs?.getModelsArray?.() || []).slice(-max);
    const messages = [];
    for (const msg of models) {
      try {
        if (!msg || msg.isNotification) continue;
        const mid = msg.id?._serialized;
        if (!mid) continue;
        messages.push({
          id: String(mid),
          body: String(msg.body || msg.caption || ''),
          type: String(msg.type || 'chat'),
          fromMe: Boolean(msg.id?.fromMe),
          timestamp: Number(msg.t) || 0,
          author: msg.author?._serialized || null,
        });
      } catch { /* skip one broken message */ }
    }
    return {
      name: String(name || targetId),
      isGroup: String(targetId).endsWith('@g.us'),
      messages,
    };
  }, chatId, limit);
}

async function history(id, chatId) {
  assertChatId(chatId);
  const client = assertReady(id);
  let payload;
  try {
    payload = await readChatMessages(client, chatId, 50);
  } catch (err) {
    console.error('Chat history failed:', safeError(err));
    throw store.httpError('Could not open that chat. Try Refresh.', 502);
  }
  for (const msg of payload.messages) {
    await record(id, {
      id: { _serialized: msg.id },
      body: msg.body,
      type: msg.type,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      author: msg.author,
      from: msg.fromMe ? undefined : chatId,
      to: msg.fromMe ? chatId : undefined,
    }, {
      emit: false,
      chatId,
      chatName: payload.name,
      isGroup: payload.isGroup,
    });
  }
  return transcriptFor(id, chatId);
}

async function send(id, chatId, body) {
  assertChatId(chatId);
  const text = String(body || '').trim();
  if (!text) throw store.httpError('Write a message first');
  if (text.length > 4000) throw store.httpError('That message is too long');
  const client = assertReady(id);
  const sent = await client.sendMessage(chatId, text);
  return record(id, sent, { chatId });
}

async function listModels(apiKey, baseUrl) {
  const res = await axios.get(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
  });
  return (res.data?.data || []).map(model => model.id).filter(Boolean);
}

module.exports = {
  attach,
  state,
  publicBot,
  start,
  stop,
  unlink,
  remove,
  resume,
  resumeUser,
  stopAll,
  listChats,
  groups,
  history,
  send,
  listModels,
  safeError,
};
