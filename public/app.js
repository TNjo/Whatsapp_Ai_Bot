const PRESET_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const STATUS = {
  stopped: 'Idle',
  starting: 'Starting',
  qr: 'Scan QR',
  authenticated: 'Linking',
  ready: 'Connected',
  disconnected: 'Disconnected',
  error: 'Needs attention',
};

let socket = null;
let signedIn = false;
let authMode = 'login';
let authInfo = { accountCount: 0, claim: false };
let state = { user: null, api: { configured: false, hint: '', baseUrl: '' }, bots: [] };
let appliedHash = '#/';
let routeLock = false;
let dirty = false;
let silent = false;
let behaviorBotId = null;
let draftNumbers = [];
let draftGroups = [];
let liveGroups = null;
let groupError = '';
let groupQuery = '';
let groupToken = 0;
let chatToken = 0;
let historyToken = 0;
let chatsLoaded = null;
let chatRetryAt = 0;
let toastTimer = 0;
let socketSeen = false;

const chatsByBot = new Map();
const selected = new Map();
const messagesByChat = new Map();

function routeFrom(hash) {
  const parts = String(hash || '#/').replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] === 'api') return { name: 'api', id: null, tab: null };
  if (parts[0] === 'bots' && parts[1]) {
    const tab = ['link', 'chats', 'behavior'].includes(parts[2]) ? parts[2] : 'link';
    return { name: 'bot', id: decodeURIComponent(parts[1]), tab };
  }
  return { name: 'fleet', id: null, tab: null };
}

function parseRoute() {
  return routeFrom(location.hash);
}

function currentBot() {
  const route = parseRoute();
  if (route.name !== 'bot') return null;
  return state.bots.find(bot => bot.id === route.id) || null;
}

function sameBot(a, b) {
  return a.name === 'bot' && b.name === 'bot' && a.id === b.id;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    showAuth({ accountCount: 1, claim: false });
    throw new Error(data.error || 'Sign in first');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] || '';
  const second = words.length > 1 ? ([...words[words.length - 1]][0] || '') : ([...words[0]][1] || '');
  return (first + second).toUpperCase();
}

function paintAvatar(el, name, { group = false } = {}) {
  el.style.setProperty('--h', String(Math.abs(Number(hashText(name))) % 360));
  el.replaceChildren(group ? icon('users') : document.createTextNode(initials(name)));
  return el;
}

function avatar(name, opts = {}) {
  const el = document.createElement('span');
  el.className = `avatar ${opts.className || ''}`.trim();
  el.setAttribute('aria-hidden', 'true');
  return paintAvatar(el, name, opts);
}

function toast(message, kind = 'ok') {
  const el = document.getElementById('toast');
  el.hidden = false;
  el.dataset.kind = kind === 'error' ? 'error' : 'ok';
  const badge = document.createElement('span');
  badge.className = 'toast-icon';
  badge.append(icon(kind === 'error' ? 'x' : 'check'));
  const text = document.createElement('span');
  text.textContent = message;
  el.replaceChildren(badge, text);
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function setCurrent(el, on) {
  if (!el) return;
  if (on) el.setAttribute('aria-current', 'page');
  else el.removeAttribute('aria-current');
}

function upsertBot(bot) {
  const index = state.bots.findIndex(item => item.id === bot.id);
  if (index === -1) state.bots.push(bot);
  else state.bots[index] = bot;
}

function phoneLine(bot) {
  const wid = bot.linked?.wid || bot.runtime?.info?.wid;
  return wid ? `+${wid}` : 'Not linked yet';
}

function previewLine(bot) {
  const preview = bot.runtime?.preview;
  if (!preview?.body) return 'No messages yet';
  const who = preview.via === 'bot' ? 'Assistant' : preview.fromMe ? 'You' : (preview.chatName || 'Chat');
  return `${who}: ${preview.body}`;
}

function statusPill(bot) {
  const span = document.createElement('span');
  span.className = 'pill';
  span.dataset.status = bot.runtime?.status || 'stopped';
  span.textContent = STATUS[span.dataset.status] || 'Idle';
  return span;
}

function hashText(value) {
  let h = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return String(h);
}

function logTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function clock(ts) {
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function shortWhen(ts) {
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return clock(ts);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayLabel(ts) {
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function chatModels(ids) {
  const filtered = (ids || []).filter(id => !/whisper|orpheus|guard|embed|tts/i.test(id));
  return filtered.length ? filtered : (ids || []);
}

function setModels(ids) {
  const list = document.getElementById('model-options');
  const merged = [...new Set([...PRESET_MODELS, ...ids])];
  list.replaceChildren();
  for (const id of merged) {
    const option = document.createElement('option');
    option.value = id;
    list.append(option);
  }
}

function renderRail() {
  const el = document.getElementById('key-status');
  el.textContent = state.api.configured ? `Key ending ${state.api.hint}` : 'No model API key';
  el.dataset.state = state.api.configured ? 'on' : 'off';
  document.getElementById('key-banner').hidden = Boolean(state.api.configured);
  document.getElementById('nav-count').textContent = state.bots.length ? String(state.bots.length) : '';
  document.getElementById('stat-key').textContent = state.api.configured ? `…${state.api.hint}` : 'Missing';
  document.getElementById('stat-key-icon').dataset.tone = state.api.configured ? 'good' : 'bad';
}

function setDirty(value) {
  dirty = value;
  const note = document.getElementById('dirty-note');
  document.getElementById('savebar').classList.toggle('is-dirty', value);
  note.textContent = value
    ? 'You have unsaved changes'
    : 'Changes apply to the next message. You do not need to reconnect.';
}

function ask({ title, body, confirm, danger }) {
  const dlg = document.getElementById('dlg-confirm');
  dlg.querySelector('h2').textContent = title;
  dlg.querySelector('p').textContent = body;
  const yes = dlg.querySelector('[data-yes]');
  yes.textContent = confirm;
  yes.classList.toggle('danger', Boolean(danger));
  dlg.classList.toggle('is-danger', Boolean(danger));
  return new Promise(resolve => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'yes');
    };
    dlg.addEventListener('close', onClose);
    if (!dlg.open) dlg.showModal();
  });
}

function renderFleet() {
  const bots = state.bots;
  const linked = bots.filter(bot => bot.runtime.status === 'ready').length;
  const waiting = bots.filter(bot => bot.runtime.status === 'qr').length;
  const lede = document.getElementById('fleet-lede');
  if (!bots.length) {
    lede.textContent = 'One bot is one WhatsApp number. Connect it, then decide who it answers.';
  } else {
    const bits = [`${bots.length} bot${bots.length === 1 ? '' : 's'}`];
    if (linked) bits.push(`${linked} connected`);
    if (waiting) bits.push(`${waiting} waiting for a scan`);
    lede.textContent = bits.join(', ');
  }
  document.getElementById('stat-total').textContent = String(bots.length);
  document.getElementById('stat-live').textContent = String(linked);
  document.getElementById('stat-qr').textContent = String(waiting);
  document.getElementById('fleet-stats').hidden = bots.length === 0;
  document.getElementById('btn-new').hidden = bots.length === 0;
  document.getElementById('fleet-empty').hidden = bots.length > 0;
  const grid = document.getElementById('fleet-grid');
  grid.hidden = bots.length === 0;
  grid.replaceChildren();
  for (const bot of bots) grid.append(botCard(bot));
  renderRail();
}

function botCard(bot) {
  const card = document.createElement('article');
  card.className = 'bot-card';
  card.dataset.id = bot.id;
  const link = document.createElement('a');
  link.className = 'card-link';
  link.href = `#/bots/${bot.id}/link`;
  const top = document.createElement('div');
  top.className = 'card-top';
  const heading = document.createElement('div');
  heading.className = 'card-title';
  const title = document.createElement('h2');
  title.textContent = bot.name;
  const phone = document.createElement('p');
  phone.className = 'phone';
  phone.append(icon('phone'), document.createTextNode(phoneLine(bot)));
  heading.append(title, phone);
  top.append(avatar(bot.name, { className: 'avatar-sq' }), heading, statusPill(bot));

  const box = document.createElement('div');
  box.className = 'preview-box';
  const preview = document.createElement('p');
  preview.className = 'preview';
  const last = bot.runtime?.preview;
  if (last?.body) {
    const who = last.via === 'bot' ? 'Assistant' : last.fromMe ? 'You' : (last.chatName || 'Chat');
    const strong = document.createElement('b');
    strong.textContent = `${who}: `;
    preview.append(strong, document.createTextNode(last.body));
  } else {
    preview.classList.add('is-empty');
    preview.textContent = previewLine(bot);
  }
  box.append(icon(last?.via === 'bot' ? 'sparkles' : 'chat'), preview);
  link.append(top, box);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const open = document.createElement('a');
  open.className = 'card-open';
  open.href = `#/bots/${bot.id}/${bot.runtime.status === 'ready' ? 'chats' : 'link'}`;
  open.append(document.createTextNode(bot.runtime.status === 'ready' ? 'Open chats' : 'Manage'), icon('arrow-right'));
  const live = ['starting', 'qr', 'authenticated', 'ready'].includes(bot.runtime.status);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = live ? 'btn secondary btn-sm' : 'btn btn-sm';
  button.dataset.action = live ? 'stop' : 'connect';
  button.append(
    icon(live ? 'stop' : 'play'),
    document.createTextNode(live ? 'Stop' : (bot.runtime.status === 'stopped' ? 'Connect' : 'Reconnect')),
  );
  actions.append(open, button);
  card.append(link, actions);
  return card;
}

function paintBotChrome(bot) {
  document.getElementById('bot-title').textContent = bot.name;
  document.getElementById('crumb-name').textContent = bot.name;
  paintAvatar(document.getElementById('bot-avatar'), bot.name);
  const bits = [];
  const phone = phoneLine(bot);
  if (phone !== 'Not linked yet') bits.push(phone);
  if (bot.linked?.pushname) bits.push(bot.linked.pushname);
  if (bot.runtime.error && bot.runtime.status !== 'ready') bits.push(bot.runtime.error);
  document.getElementById('bot-sub').textContent = bits.join(' · ') || 'Not linked yet';
  const pill = document.getElementById('bot-pill');
  pill.dataset.status = bot.runtime.status || 'stopped';
  pill.textContent = STATUS[pill.dataset.status] || 'Idle';
  const live = ['starting', 'qr', 'authenticated', 'ready'].includes(bot.runtime.status);
  const connect = document.getElementById('btn-connect');
  const stop = document.getElementById('btn-stop');
  connect.hidden = live;
  stop.hidden = !live;
  connect.querySelector('span').textContent = bot.runtime.status === 'stopped' ? 'Connect' : 'Reconnect';
  const route = parseRoute();
  for (const tab of ['link', 'chats', 'behavior']) {
    const el = document.querySelector(`[data-tab="${tab}"]`);
    el.href = `#/bots/${bot.id}/${tab}`;
    setCurrent(el, route.name === 'bot' && route.id === bot.id && route.tab === tab);
  }
}

function showPanel(tab) {
  for (const name of ['link', 'chats', 'behavior']) {
    document.getElementById(`panel-${name}`).hidden = name !== tab;
  }
}

function renderLogs(bot) {
  const list = document.getElementById('log-list');
  const sig = `${bot.id}:${(bot.runtime.logs || []).map(line => line.at).join(',')}`;
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.replaceChildren();
  const lines = bot.runtime.logs || [];
  if (!lines.length) {
    const item = document.createElement('li');
    item.className = 'log-empty';
    item.textContent = 'Nothing yet. Connect this bot to begin.';
    list.append(item);
    return;
  }
  for (const line of lines) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = new Date(line.at).toISOString();
    time.textContent = logTime(line.at);
    const message = document.createElement('span');
    message.textContent = line.message;
    item.append(time, message);
    list.append(item);
  }
  list.scrollTop = list.scrollHeight;
}

function renderLink(bot) {
  const stage = document.getElementById('link-stage');
  const qr = bot.runtime.qr || '';
  const key = [bot.id, bot.runtime.status, hashText(qr), bot.runtime.error || '', bot.linked?.wid || ''].join('|');
  if (stage.dataset.key !== key) {
    stage.dataset.key = key;
    stage.replaceChildren();
    const status = bot.runtime.status;
    const title = document.createElement('h2');
    const copy = document.createElement('p');
    const badge = (name, tone, spin) => {
      const el = document.createElement('span');
      el.className = spin ? 'ticket-icon is-spinning' : 'ticket-icon';
      if (tone) el.dataset.tone = tone;
      el.append(icon(name));
      return el;
    };
    if (status === 'qr' && qr.startsWith('data:image/')) {
      const frame = document.createElement('div');
      frame.className = 'qr-frame';
      const img = document.createElement('img');
      img.alt = 'WhatsApp QR code';
      img.src = qr;
      frame.append(img);
      title.textContent = 'Scan to link';
      const steps = document.createElement('ol');
      steps.className = 'qr-steps';
      for (const parts of [
        ['Open ', 'WhatsApp', ' on your phone'],
        ['Go to ', 'Settings → Linked devices', ''],
        ['Tap ', 'Link a device', ' and point at this code'],
      ]) {
        const li = document.createElement('li');
        const span = document.createElement('span');
        const strong = document.createElement('b');
        strong.textContent = parts[1];
        span.append(document.createTextNode(parts[0]), strong, document.createTextNode(parts[2]));
        li.append(span);
        steps.append(li);
      }
      const note = document.createElement('p');
      note.className = 'fine';
      note.textContent = 'The code refreshes by itself.';
      stage.append(frame, title, steps, note);
    } else if (status === 'starting') {
      title.textContent = 'Opening WhatsApp';
      copy.textContent = 'Chrome is starting in the background. A QR code shows here if this number is not saved yet.';
      stage.append(badge('loader', 'warn', true), title, copy);
    } else if (status === 'authenticated') {
      title.textContent = 'Phone linked';
      copy.textContent = 'WhatsApp is loading this account. Chats appear when it finishes.';
      stage.append(badge('loader', 'warn', true), title, copy);
    } else if (status === 'ready') {
      title.textContent = bot.linked?.pushname || bot.name;
      copy.textContent = `${phoneLine(bot)} is connected. Messages in the Chats tab update live.`;
      const chats = document.createElement('a');
      chats.className = 'btn';
      chats.href = `#/bots/${bot.id}/chats`;
      chats.append(icon('chat'), document.createTextNode('Open chats'));
      const row = document.createElement('div');
      row.className = 'row-actions';
      row.append(chats, unlinkButton());
      stage.append(badge('check-circle', 'good'), title, copy, row);
    } else if (status === 'error' || status === 'disconnected') {
      title.textContent = status === 'error' ? 'Could not stay connected' : 'Disconnected';
      copy.textContent = bot.runtime.error || 'Press Reconnect to try again.';
      stage.append(badge('alert', 'bad'), title, copy);
      if (bot.linked) stage.append(unlinkButton());
    } else if (bot.linked?.wid) {
      title.textContent = 'Saved login';
      copy.textContent = `${phoneLine(bot)} is saved on this computer. Connect to bring it back without a new scan.`;
      stage.append(badge('phone'), title, copy, unlinkButton());
    } else {
      title.textContent = 'Waiting to link';
      copy.textContent = 'Connect this bot. If the number is new here, a QR code appears in this card.';
      stage.append(badge('qr'), title, copy);
    }
  }
  renderLogs(bot);
}

function unlinkButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn secondary';
  button.dataset.unlink = '1';
  button.append(icon('unlink'), document.createTextNode('Unlink device'));
  return button;
}

function paintApi() {
  const url = document.getElementById('api-url');
  if (document.activeElement !== url) {
    url.value = state.api.baseUrl || 'https://api.groq.com/openai/v1';
  }
  document.getElementById('api-hint').textContent = state.api.configured
    ? `A key ending in ${state.api.hint} is saved. Paste a new one only if you want to replace it.`
    : 'Nothing saved yet.';
  document.getElementById('btn-clear-key').hidden = !state.api.configured;
}

function applyRoute() {
  const route = parseRoute();
  document.getElementById('view-fleet').hidden = route.name !== 'fleet';
  document.getElementById('view-api').hidden = route.name !== 'api';
  document.getElementById('view-bot').hidden = route.name !== 'bot';
  setCurrent(document.querySelector('[data-nav="fleet"]'), route.name !== 'api');
  setCurrent(document.querySelector('[data-nav="api"]'), route.name === 'api');

  if (route.name === 'fleet') {
    document.title = 'Bots · Booth';
    renderFleet();
    return;
  }
  if (route.name === 'api') {
    document.title = 'Model API · Booth';
    paintApi();
    renderRail();
    return;
  }

  const bot = state.bots.find(item => item.id === route.id);
  if (!bot) {
    if ((location.hash || '#/') !== '#/') location.hash = '#/';
    toast('That bot is gone', 'error');
    return;
  }
  document.title = `${bot.name} · Booth`;
  paintBotChrome(bot);
  showPanel(route.tab);
  if (route.tab === 'link') renderLink(bot);
  if (route.tab === 'chats') ensureChats(bot);
  if (route.tab === 'behavior' && behaviorBotId !== bot.id) fillBehavior(bot);
}

async function onHash() {
  if (!signedIn || routeLock) return;
  const nextHash = location.hash || '#/';
  const next = routeFrom(nextHash);
  const previous = routeFrom(appliedHash);
  if (dirty && !sameBot(previous, next)) {
    const ok = await ask({
      title: 'Leave without saving?',
      body: 'Behavior changes on this bot have not been saved.',
      confirm: 'Leave',
      danger: true,
    });
    if (!ok) {
      routeLock = true;
      location.hash = appliedHash || '#/';
      routeLock = false;
      return;
    }
    dirty = false;
    behaviorBotId = null;
    setDirty(false);
  }
  appliedHash = location.hash || '#/';
  applyRoute();
}

function syncGroupDim() {
  document.getElementById('group-block').classList.toggle('is-dim', document.getElementById('set-ignore-groups').checked);
}

function fillBehavior(bot) {
  behaviorBotId = bot.id;
  groupToken += 1;
  liveGroups = null;
  groupError = '';
  groupQuery = '';
  document.getElementById('group-search').value = '';
  draftNumbers = [...(bot.settings.excludedNumbers || [])];
  draftGroups = (bot.settings.excludedGroups || []).map(group => ({ ...group }));
  silent = true;
  document.getElementById('set-name').value = bot.name;
  document.getElementById('set-owner').value = bot.settings.ownerName || '';
  document.getElementById('set-prompt').value = bot.settings.systemPrompt || '';
  document.getElementById('set-model').value = bot.settings.model || PRESET_MODELS[0];
  document.getElementById('set-max').value = bot.settings.maxReplies;
  document.getElementById('set-reset').value = bot.settings.resetMinutes;
  document.getElementById('set-auto').checked = Boolean(bot.settings.autoReply);
  document.getElementById('set-commands').checked = bot.settings.commandsEnabled !== false;
  document.getElementById('set-ignore-groups').checked = Boolean(bot.settings.ignoreGroups);
  document.getElementById('set-mention').checked = Boolean(bot.settings.groupsOnlyWhenMentioned);
  document.getElementById('set-saved').checked = bot.settings.ignoreSavedContacts !== false;
  document.getElementById('set-business').checked = Boolean(bot.settings.ignoreBusiness);
  document.getElementById('set-status').checked = bot.settings.ignoreStatus !== false;
  silent = false;
  setDirty(false);
  renderNumbers();
  renderGroups();
  syncGroupDim();
  if (bot.runtime.status === 'ready') loadGroups(bot.id);
}

function renderNumbers() {
  const root = document.getElementById('num-chips');
  root.replaceChildren();
  if (!draftNumbers.length) {
    const empty = document.createElement('p');
    empty.className = 'fine';
    empty.textContent = 'No numbers excluded.';
    root.append(empty);
    return;
  }
  for (const number of draftNumbers) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(document.createTextNode(`+${number}`));
    const button = document.createElement('button');
    button.type = 'button';
    button.append(icon('x'));
    button.setAttribute('aria-label', `Remove +${number}`);
    button.addEventListener('click', () => {
      draftNumbers = draftNumbers.filter(item => item !== number);
      renderNumbers();
      setDirty(true);
    });
    chip.append(button);
    root.append(chip);
  }
}

function renderGroups() {
  const root = document.getElementById('group-list');
  const note = document.getElementById('group-note');
  root.replaceChildren();
  if (groupError) note.textContent = groupError;
  else if (!liveGroups) note.textContent = 'Connect this bot to load its groups. Saved exclusions still apply.';
  else if (!liveGroups.length) note.textContent = 'This WhatsApp has no groups, or they have not loaded yet.';
  else note.textContent = `${draftGroups.length} group${draftGroups.length === 1 ? '' : 's'} excluded.`;

  const query = groupQuery.trim().toLowerCase();
  for (const group of (liveGroups || []).filter(item => item.name.toLowerCase().includes(query))) {
    const excluded = draftGroups.some(item => item.id === group.id);
    const label = document.createElement('label');
    label.className = 'group-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !excluded;
    input.setAttribute('aria-label', `Reply in ${group.name}`);
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.name;
    const flag = document.createElement('span');
    flag.className = 'group-flag';
    const paintFlag = () => {
      flag.textContent = input.checked ? 'Replies' : 'Skipped';
      flag.dataset.on = String(input.checked);
    };
    paintFlag();
    input.addEventListener('change', () => {
      if (input.checked) draftGroups = draftGroups.filter(item => item.id !== group.id);
      else if (!draftGroups.some(item => item.id === group.id)) draftGroups.push({ id: group.id, name: group.name });
      paintFlag();
      note.textContent = `${draftGroups.length} group${draftGroups.length === 1 ? '' : 's'} excluded.`;
      setDirty(true);
    });
    const toggle = document.createElement('span');
    toggle.className = 'switch';
    const ui = document.createElement('span');
    ui.className = 'switch-ui';
    toggle.append(input, ui);
    label.append(avatar(group.name, { group: true }), name, flag, toggle);
    root.append(label);
  }

  const known = new Set((liveGroups || []).map(group => group.id));
  const extras = document.getElementById('group-extras');
  extras.replaceChildren();
  for (const group of draftGroups.filter(item => !known.has(item.id))) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(document.createTextNode(group.name || group.id));
    const button = document.createElement('button');
    button.type = 'button';
    button.append(icon('x'));
    button.setAttribute('aria-label', `Remove ${group.name || 'group'}`);
    button.addEventListener('click', () => {
      draftGroups = draftGroups.filter(item => item.id !== group.id);
      renderGroups();
      setDirty(true);
    });
    chip.append(button);
    extras.append(chip);
  }
}

async function loadGroups(botId) {
  const token = ++groupToken;
  groupError = '';
  document.getElementById('group-note').textContent = 'Loading groups…';
  try {
    const data = await api(`/api/bots/${botId}/groups`);
    if (token !== groupToken) return;
    liveGroups = data.groups;
    groupError = '';
    renderGroups();
  } catch (err) {
    if (token !== groupToken) return;
    liveGroups = null;
    groupError = err.message;
    renderGroups();
  }
}

function messageKey(botId, chatId) {
  return `${botId}|${chatId}`;
}

function mergeMessages(botId, chatId, incoming) {
  const key = messageKey(botId, chatId);
  const map = new Map((messagesByChat.get(key) || []).map(item => [item.id, item]));
  for (const item of incoming || []) {
    if (item?.id) map.set(item.id, item);
  }
  const merged = [...map.values()].sort((a, b) => (a.timestamp - b.timestamp) || String(a.id).localeCompare(String(b.id)));
  messagesByChat.set(key, merged);
  return merged;
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}

function whoLabel(msg) {
  if (msg.via === 'bot') return 'Assistant';
  if (msg.via === 'you' || msg.fromMe) return 'You';
  return '';
}

function bubble(msg) {
  const kind = msg.via === 'bot' ? 'bot' : (msg.fromMe ? 'you' : 'them');
  const el = document.createElement('div');
  el.className = `bubble bubble-${kind}`;
  el.dataset.mid = msg.id;
  const who = whoLabel(msg);
  if (who) {
    const label = document.createElement('span');
    label.className = 'who';
    if (kind === 'bot') label.append(icon('sparkles'));
    label.append(document.createTextNode(who));
    el.append(label);
  }
  const text = document.createElement('p');
  text.textContent = msg.body;
  const time = document.createElement('time');
  time.textContent = clock(msg.timestamp);
  el.append(text, time);
  return el;
}

function renderThread(botId, chatId, { stick } = {}) {
  const thread = document.getElementById('thread');
  const follow = stick || nearBottom(thread);
  const messages = messagesByChat.get(messageKey(botId, chatId)) || [];
  thread.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-thread fine';
    empty.textContent = 'No messages in this chat yet.';
    thread.append(empty);
    return;
  }
  let lastDay = '';
  for (const msg of messages) {
    const day = dayLabel(msg.timestamp);
    if (day && day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'day';
      sep.textContent = day;
      thread.append(sep);
    }
    thread.append(bubble(msg));
  }
  if (follow) thread.scrollTop = thread.scrollHeight;
}

function renderChatList() {
  const bot = currentBot();
  if (!bot) return;
  const list = document.getElementById('chat-list');
  const scroll = list.scrollTop;
  const query = document.getElementById('chat-search').value.trim().toLowerCase();
  const chats = (chatsByBot.get(bot.id) || []).filter(chat => {
    if (!query) return true;
    return `${chat.name} ${chat.lastMessage || ''}`.toLowerCase().includes(query);
  });
  list.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement('p');
    empty.className = 'fine pad';
    empty.textContent = query ? 'No chats match that search.' : 'No chats yet.';
    list.append(empty);
    return;
  }
  const current = selected.get(bot.id);
  for (const chat of chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-row';
    button.dataset.chat = chat.id;
    if (chat.id === current) button.setAttribute('aria-current', 'true');
    const main = document.createElement('span');
    main.className = 'chat-row-main';
    const top = document.createElement('span');
    top.className = 'chat-row-top';
    const title = document.createElement('strong');
    title.textContent = chat.name || 'Chat';
    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = chat.timestamp ? shortWhen(chat.timestamp) : '';
    top.append(title, time);
    const bottom = document.createElement('span');
    bottom.className = 'chat-row-bottom';
    const preview = document.createElement('span');
    preview.className = 'chat-snippet';
    preview.textContent = (chat.lastMessage || 'No text yet').replace(/\u2060/g, '');
    bottom.append(preview);
    if (chat.isGroup) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Group';
      bottom.append(tag);
    }
    if (chat.unread) {
      const badge = document.createElement('span');
      badge.className = 'unread';
      badge.textContent = String(chat.unread);
      bottom.append(badge);
    }
    main.append(top, bottom);
    button.append(avatar(chat.name || 'Chat', { group: chat.isGroup }), main);
    list.append(button);
  }
  list.scrollTop = scroll;
}

function paintThreadHead(chat) {
  document.getElementById('thread-title').textContent = chat ? (chat.name || 'Chat') : 'Select a chat';
  document.getElementById('thread-meta').textContent = chat ? (chat.isGroup ? 'Group' : 'Personal chat') : '';
  const face = document.getElementById('thread-avatar');
  if (chat) paintAvatar(face, chat.name || 'Chat', { group: chat.isGroup });
  else face.replaceChildren();
  const ready = currentBot()?.runtime.status === 'ready' && Boolean(chat);
  document.getElementById('composer-text').disabled = !ready;
  document.getElementById('composer-send').disabled = !ready;
}

function touchChatList(botId, message) {
  if (!message?.chatId) return;
  const list = chatsByBot.get(botId) || [];
  let row = list.find(chat => chat.id === message.chatId);
  if (!row) {
    row = {
      id: message.chatId,
      name: message.chatName || 'Chat',
      isGroup: Boolean(message.isGroup),
      unread: 0,
      timestamp: message.timestamp || 0,
      lastMessage: message.body,
    };
    list.unshift(row);
    chatsByBot.set(botId, list);
  }
  row.lastMessage = message.body;
  row.timestamp = message.timestamp || row.timestamp;
  row.name = message.chatName || row.name;
  if (selected.get(botId) !== message.chatId && !message.fromMe) row.unread = (row.unread || 0) + 1;
  list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

async function openChat(botId, chatId) {
  selected.set(botId, chatId);
  const chat = (chatsByBot.get(botId) || []).find(item => item.id === chatId);
  if (chat) chat.unread = 0;
  renderChatList();
  paintThreadHead(chat);
  const thread = document.getElementById('thread');
  thread.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'fine empty-thread';
  loading.textContent = 'Loading messages…';
  thread.append(loading);
  const token = ++historyToken;
  try {
    const data = await api(`/api/bots/${botId}/chats/${encodeURIComponent(chatId)}/messages`);
    if (token !== historyToken) return;
    mergeMessages(botId, chatId, data.messages);
    renderThread(botId, chatId, { stick: true });
  } catch (err) {
    if (token !== historyToken) return;
    thread.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'fine empty-thread';
    failed.textContent = err.message;
    thread.append(failed);
  }
}

async function loadChats(botId) {
  if (Date.now() < chatRetryAt) return;
  const token = ++chatToken;
  const list = document.getElementById('chat-list');
  list.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'fine pad';
  loading.textContent = 'Loading chats…';
  list.append(loading);
  try {
    const data = await api(`/api/bots/${botId}/chats`);
    if (token !== chatToken || currentBot()?.id !== botId) return;
    chatsByBot.set(botId, data.chats || []);
    chatsLoaded = botId;
    renderChatList();
    const pick = (data.chats || []).find(chat => chat.id === selected.get(botId)) || (data.chats || [])[0];
    if (pick) await openChat(botId, pick.id);
    else paintThreadHead(null);
  } catch (err) {
    if (token !== chatToken) return;
    chatsLoaded = null;
    chatRetryAt = Date.now() + 4000;
    document.getElementById('chat-locked').hidden = false;
    document.getElementById('chat-shell').hidden = true;
    document.getElementById('chat-locked-text').textContent = err.message;
  }
}

function ensureChats(bot) {
  const locked = document.getElementById('chat-locked');
  const shell = document.getElementById('chat-shell');
  if (bot.runtime.status !== 'ready') {
    locked.hidden = false;
    shell.hidden = true;
    document.getElementById('chat-locked-text').textContent = 'Connect this WhatsApp to load chats.';
    if (chatsLoaded === bot.id) chatsLoaded = null;
    return;
  }
  locked.hidden = true;
  shell.hidden = false;
  if (chatsLoaded === bot.id) {
    renderChatList();
    const chat = (chatsByBot.get(bot.id) || []).find(item => item.id === selected.get(bot.id));
    paintThreadHead(chat || null);
    if (chat) renderThread(bot.id, chat.id, { stick: false });
    return;
  }
  loadChats(bot.id);
}

function showBot(bot) {
  const route = parseRoute();
  if (route.name === 'fleet') renderFleet();
  if (route.name === 'bot' && route.id === bot.id) {
    paintBotChrome(bot);
    if (route.tab === 'link') renderLink(bot);
    if (route.tab === 'chats') ensureChats(bot);
  }
}

async function startBot(id) {
  const data = await api(`/api/bots/${id}/start`, { method: 'POST', body: '{}' });
  upsertBot(data.bot);
  showBot(data.bot);
}

async function stopBot(id) {
  const data = await api(`/api/bots/${id}/stop`, { method: 'POST', body: '{}' });
  upsertBot(data.bot);
  showBot(data.bot);
}

async function unlinkBot() {
  const bot = currentBot();
  if (!bot) return;
  const ok = await ask({
    title: 'Unlink this WhatsApp?',
    body: 'The phone forgets this linked device. The next connect shows a new QR code.',
    confirm: 'Unlink',
    danger: true,
  });
  if (!ok) return;
  try {
    const data = await api(`/api/bots/${bot.id}/unlink`, { method: 'POST', body: '{}' });
    upsertBot(data.bot);
    document.getElementById('link-stage').dataset.key = '';
    showBot(data.bot);
    toast('WhatsApp unlinked');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openCreate() {
  document.getElementById('create-name').value = '';
  document.getElementById('create-owner').value = '';
  document.getElementById('dlg-create').showModal();
  document.getElementById('create-name').focus();
}

async function refreshModels() {
  if (!state.api.configured) {
    setModels(PRESET_MODELS);
    return;
  }
  try {
    const data = await api('/api/models');
    setModels(chatModels(data.models));
  } catch {
    setModels(PRESET_MODELS);
  }
}

async function refresh() {
  state = await api('/api/state');
  renderRail();
  applyRoute();
}

function patchRuntime(payload) {
  const bot = state.bots.find(item => item.id === payload.botId);
  if (!bot) {
    refresh().catch(err => toast(err.message, 'error'));
    return;
  }
  bot.runtime = payload.runtime;
  bot.linked = payload.linked;
  bot.desiredRunning = payload.desiredRunning;
  if (bot.runtime.status !== 'ready' && chatsLoaded === bot.id) chatsLoaded = null;
  showBot(bot);
}

function onLiveMessage({ botId, message, preview }) {
  const bot = state.bots.find(item => item.id === botId);
  if (bot && preview) bot.runtime.preview = preview;
  if (message?.chatId) {
    mergeMessages(botId, message.chatId, [message]);
    touchChatList(botId, message);
  }
  const route = parseRoute();
  if (route.name === 'fleet') renderFleet();
  if (route.name === 'bot' && route.id === botId && route.tab === 'chats' && bot?.runtime.status === 'ready') {
    renderChatList();
    if (message && selected.get(botId) === message.chatId) renderThread(botId, message.chatId, { stick: false });
  }
}

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function bind() {
  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('booth-theme', next);
    } catch {
      // theme still applies for this visit
    }
  });
  const composerText = document.getElementById('composer-text');
  composerText.addEventListener('input', () => {
    composerText.style.height = 'auto';
    composerText.style.height = `${Math.min(composerText.scrollHeight + 2, 160)}px`;
  });
  document.getElementById('btn-new').addEventListener('click', openCreate);
  document.getElementById('empty-create').addEventListener('click', openCreate);
  document.getElementById('create-cancel').addEventListener('click', () => {
    document.getElementById('dlg-create').close();
  });
  document.getElementById('create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = document.getElementById('create-name').value.trim();
    const ownerName = document.getElementById('create-owner').value.trim();
    if (!name) {
      toast('Give the bot a name', 'error');
      return;
    }
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      const data = await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify({ name, ownerName }),
      });
      upsertBot(data.bot);
      document.getElementById('dlg-create').close();
      location.hash = `#/bots/${data.bot.id}/link`;
      toast('Bot created');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });

  document.getElementById('fleet-grid').addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    event.preventDefault();
    const id = button.closest('[data-id]')?.dataset.id;
    if (!id) return;
    button.disabled = true;
    try {
      if (button.dataset.action === 'stop') await stopBot(id);
      else await startBot(id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('btn-connect').addEventListener('click', async () => {
    const bot = currentBot();
    if (!bot) return;
    document.getElementById('btn-connect').disabled = true;
    try {
      await startBot(bot.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      document.getElementById('btn-connect').disabled = false;
    }
  });
  document.getElementById('btn-stop').addEventListener('click', async () => {
    const bot = currentBot();
    if (!bot) return;
    document.getElementById('btn-stop').disabled = true;
    try {
      await stopBot(bot.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      document.getElementById('btn-stop').disabled = false;
    }
  });
  document.getElementById('link-stage').addEventListener('click', event => {
    if (event.target.closest('[data-unlink]')) unlinkBot();
  });

  document.getElementById('api-form').addEventListener('submit', async event => {
    event.preventDefault();
    const baseUrl = document.getElementById('api-url').value.trim();
    const apiKey = document.getElementById('api-key').value.trim();
    const body = { baseUrl };
    if (apiKey) body.apiKey = apiKey;
    try {
      const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      state.api = data.api;
      document.getElementById('api-key').value = '';
      paintApi();
      renderRail();
      toast(state.api.configured ? 'Model API saved' : 'URL saved');
      refreshModels();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.getElementById('btn-show-key').addEventListener('click', () => {
    const input = document.getElementById('api-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    document.querySelector('#btn-show-key span').textContent = show ? 'Hide' : 'Show';
  });
  document.getElementById('btn-test-key').addEventListener('click', async () => {
    const result = document.getElementById('api-result');
    const button = document.getElementById('btn-test-key');
    result.hidden = false;
    result.dataset.kind = '';
    result.textContent = 'Checking the key…';
    button.disabled = true;
    try {
      const apiKey = document.getElementById('api-key').value.trim();
      const data = await api('/api/settings/test', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: document.getElementById('api-url').value.trim(),
          apiKey: apiKey || undefined,
        }),
      });
      setModels(chatModels(data.models));
      result.dataset.kind = 'ok';
      result.textContent = `Key works. ${data.count} models are available.`;
    } catch (err) {
      result.dataset.kind = 'bad';
      result.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('btn-clear-key').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Remove the API key?',
      body: 'Connected bots stay linked, but they will not write replies until you add a key again.',
      confirm: 'Remove key',
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          clearKey: true,
          baseUrl: document.getElementById('api-url').value.trim(),
        }),
      });
      state.api = data.api;
      document.getElementById('api-key').value = '';
      paintApi();
      renderRail();
      toast('API key removed');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const form = document.getElementById('behavior-form');
  form.addEventListener('input', event => {
    if (silent || event.target.hasAttribute('data-quiet')) return;
    setDirty(true);
  });
  form.addEventListener('change', event => {
    if (silent || event.target.hasAttribute('data-quiet')) return;
    setDirty(true);
    if (event.target.id === 'set-ignore-groups') syncGroupDim();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const bot = currentBot();
    if (!bot) return;
    const button = document.getElementById('btn-save');
    button.disabled = true;
    try {
      const data = await api(`/api/bots/${bot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('set-name').value,
          settings: {
            ownerName: document.getElementById('set-owner').value,
            systemPrompt: document.getElementById('set-prompt').value,
            model: document.getElementById('set-model').value.trim(),
            maxReplies: Number(document.getElementById('set-max').value),
            resetMinutes: Number(document.getElementById('set-reset').value),
            autoReply: document.getElementById('set-auto').checked,
            commandsEnabled: document.getElementById('set-commands').checked,
            ignoreGroups: document.getElementById('set-ignore-groups').checked,
            groupsOnlyWhenMentioned: document.getElementById('set-mention').checked,
            ignoreSavedContacts: document.getElementById('set-saved').checked,
            ignoreBusiness: document.getElementById('set-business').checked,
            ignoreStatus: document.getElementById('set-status').checked,
            excludedNumbers: draftNumbers,
            excludedGroups: draftGroups,
          },
        }),
      });
      upsertBot(data.bot);
      draftNumbers = [...data.bot.settings.excludedNumbers];
      draftGroups = data.bot.settings.excludedGroups.map(group => ({ ...group }));
      behaviorBotId = data.bot.id;
      silent = true;
      document.getElementById('set-name').value = data.bot.name;
      document.getElementById('set-model').value = data.bot.settings.model;
      silent = false;
      setDirty(false);
      paintBotChrome(data.bot);
      renderNumbers();
      renderGroups();
      toast('Behavior saved');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('num-add').addEventListener('click', addNumber);
  document.getElementById('num-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addNumber();
    }
  });
  document.getElementById('group-search').addEventListener('input', event => {
    groupQuery = event.target.value;
    renderGroups();
  });
  document.getElementById('group-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });
  document.getElementById('group-refresh').addEventListener('click', () => {
    const bot = currentBot();
    if (!bot) return;
    if (bot.runtime.status !== 'ready') {
      toast('Connect the bot before loading groups', 'error');
      return;
    }
    loadGroups(bot.id);
  });
  document.getElementById('btn-delete').addEventListener('click', async () => {
    const bot = currentBot();
    if (!bot) return;
    const ok = await ask({
      title: `Delete ${bot.name}?`,
      body: 'This stops the bot and removes its saved WhatsApp login from this computer.',
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api(`/api/bots/${bot.id}`, { method: 'DELETE' });
      state.bots = state.bots.filter(item => item.id !== bot.id);
      dirty = false;
      behaviorBotId = null;
      location.hash = '#/';
      toast(result.warning ? 'Bot deleted. Its login folder was still locked.' : 'Bot deleted', result.warning ? 'error' : 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('chat-search').addEventListener('input', () => renderChatList());
  document.getElementById('chat-refresh').addEventListener('click', () => {
    const bot = currentBot();
    if (!bot || bot.runtime.status !== 'ready') return;
    chatsLoaded = null;
    chatRetryAt = 0;
    loadChats(bot.id);
  });
  document.getElementById('chat-list').addEventListener('click', event => {
    const row = event.target.closest('[data-chat]');
    const bot = currentBot();
    if (!row || !bot) return;
    openChat(bot.id, row.dataset.chat);
  });
  document.getElementById('composer-text').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      document.getElementById('composer').requestSubmit();
    }
  });
  document.getElementById('composer').addEventListener('submit', async event => {
    event.preventDefault();
    const bot = currentBot();
    const chatId = bot ? selected.get(bot.id) : null;
    const input = document.getElementById('composer-text');
    const text = input.value.trim();
    if (!bot || !chatId || !text) return;
    const button = document.getElementById('composer-send');
    button.disabled = true;
    try {
      const data = await api(`/api/bots/${bot.id}/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      input.value = '';
      input.style.height = '';
      if (data.message) {
        mergeMessages(bot.id, chatId, [data.message]);
        touchChatList(bot.id, data.message);
      }
      renderChatList();
      renderThread(bot.id, chatId, { stick: true });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener('hashchange', () => {
    onHash().catch(err => toast(err.message, 'error'));
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.getElementById('auth-switch').addEventListener('click', () => {
    authMode = authMode === 'register' ? 'login' : 'register';
    paintAuth();
  });
  document.getElementById('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('auth-submit');
    const note = document.getElementById('auth-error');
    button.disabled = true;
    note.hidden = true;
    try {
      const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      await api(path, {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('auth-user').value.trim(),
          password: document.getElementById('auth-pass').value,
        }),
      });
      document.getElementById('auth-pass').value = '';
      await enterDesk();
    } catch (err) {
      note.hidden = false;
      note.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (dirty) {
      const ok = await ask({
        title: 'Log out without saving?',
        body: 'Behavior changes on this bot have not been saved.',
        confirm: 'Log out',
        danger: true,
      });
      if (!ok) return;
      dirty = false;
    }
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // still leave the desk
    }
    if ((location.hash || '#/') !== '#/') location.hash = '#/';
    showAuth({ accountCount: 1, claim: false });
  });
}

function paintAuth() {
  const register = authMode === 'register';
  document.getElementById('auth-title').textContent = register ? 'Create account' : 'Sign in';
  document.getElementById('auth-submit').textContent = register ? 'Create account' : 'Sign in';
  document.getElementById('auth-switch').textContent = register ? 'I already have an account' : 'Create an account';
  document.getElementById('auth-pass').autocomplete = register ? 'new-password' : 'current-password';
  const lede = document.getElementById('auth-lede');
  if (register && authInfo.claim) {
    lede.textContent = 'The WhatsApp bots already on this computer will belong to this account. Later accounts start empty, with their own key and behavior.';
  } else if (register) {
    lede.textContent = 'This account gets its own bots, chats, API key, and behavior.';
  } else {
    lede.textContent = 'Sign in to see only your bots and chats.';
  }
  document.getElementById('auth-error').hidden = true;
}

function showAuth(info = authInfo) {
  signedIn = false;
  dirty = false;
  authInfo = {
    accountCount: info.accountCount || 0,
    claim: Boolean(info.claim),
  };
  if (!authInfo.accountCount) authMode = 'register';
  disconnectSocket();
  document.getElementById('boot').hidden = true;
  document.getElementById('shell').hidden = true;
  document.getElementById('view-auth').hidden = false;
  paintAuth();
}

function disconnectSocket() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.close();
  socket = null;
  socketSeen = false;
}

function connectSocket() {
  disconnectSocket();
  socket = io();
  socket.on('connect', () => {
    const el = document.getElementById('desk-status');
    el.dataset.state = 'on';
    el.textContent = 'Desk online';
    if (socketSeen) refresh().catch(() => {});
    socketSeen = true;
  });
  socket.on('disconnect', () => {
    const el = document.getElementById('desk-status');
    if (!el) return;
    el.dataset.state = 'off';
    el.textContent = 'Desk reconnecting';
  });
  socket.on('bot:runtime', patchRuntime);
  socket.on('bot:message', onLiveMessage);
  socket.on('bots:changed', () => {
    refresh().catch(err => toast(err.message, 'error'));
  });
}

async function enterDesk() {
  state = await api('/api/state');
  signedIn = true;
  document.getElementById('view-auth').hidden = true;
  document.getElementById('boot').hidden = true;
  document.getElementById('shell').hidden = false;
  document.getElementById('who').textContent = state.user?.username || '';
  if (state.user?.username) paintAvatar(document.getElementById('who-avatar'), state.user.username);
  setModels(PRESET_MODELS);
  renderRail();
  connectSocket();
  appliedHash = location.hash || '#/';
  applyRoute();
  refreshModels();
}

function addNumber() {
  const input = document.getElementById('num-input');
  const digits = input.value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 16) {
    toast('Enter a phone number with 8 to 16 digits', 'error');
    return;
  }
  if (!draftNumbers.includes(digits)) draftNumbers.push(digits);
  input.value = '';
  renderNumbers();
  setDirty(true);
}

async function boot() {
  bind();
  try {
    const me = await api('/api/auth/me');
    if (!me.user) {
      showAuth(me);
      return;
    }
    await enterDesk();
  } catch {
    document.getElementById('boot').classList.add('is-failed');
    document.getElementById('boot-text').textContent = 'The desk did not start. Run npm start, then open this page again.';
  }
}

boot();
