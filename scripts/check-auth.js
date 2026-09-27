const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-auth-'));
process.env.BOOTH_DATA = dir;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  apiKey: 'legacy-key-value',
  baseUrl: 'https://api.groq.com/openai/v1',
  bots: [{
    id: 'bot_legacy0001',
    name: 'Old line',
    createdAt: '2026-01-01T00:00:00.000Z',
    desiredRunning: false,
    linked: { pushname: 'Ada', wid: '94770000000', platform: 'android' },
    settings: { ownerName: 'Ada', ignoreGroups: true, maxReplies: 3 },
  }],
}));

const store = require('../lib/store');

function assert(cond, message) {
  if (!cond) {
    console.error(message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

try {
  assert(store.accountCount() === 0, 'starts with no accounts');
  assert(store.hasLegacy(), 'existing desk data is waiting for the first account');

  const ada = store.register({ username: 'Ada', password: 'password1' });
  assert(ada.username === 'ada', 'username is stored in lowercase');
  assert(store.list(ada.id).length === 1, 'first account claims the existing bot');
  assert(store.getApi(ada.id).apiKey === 'legacy-key-value', 'first account claims the existing key');
  assert(!store.hasLegacy(), 'legacy data is claimed once');

  const bea = store.register({ username: 'bea', password: 'password2' });
  assert(store.list(bea.id).length === 0, 'second account starts with no bots');
  assert(store.getApi(bea.id).apiKey === '', 'second account starts with no key');

  let blocked = false;
  try {
    store.assertOwned(bea.id, 'bot_legacy0001');
  } catch (err) {
    blocked = err.statusCode === 404;
  }
  assert(blocked, 'another account cannot open the first bot');

  store.setApi(bea.id, { apiKey: 'second-user-key-ok' });
  assert(store.getApi(ada.id).apiKey === 'legacy-key-value', 'saving one key leaves the other account alone');
  assert(store.getApiForBot('bot_legacy0001').apiKey === 'legacy-key-value', 'a bot replies with its owner key');

  const bot = store.createBot(bea.id, { name: 'Bea line', ownerName: 'Bea' });
  store.updateBot(bot.id, { settings: { ignoreGroups: false, maxReplies: 9, ownerName: 'Bea' } });
  assert(store.getBot(bot.id).settings.ignoreGroups === false, 'behavior saves on that bot');
  assert(store.getBot(bot.id).settings.maxReplies === 9, 'reply limit saves on that bot');
  assert(store.getBot('bot_legacy0001').settings.ignoreGroups === true, 'the other account bot keeps its behavior');
  assert(store.list(ada.id).length === 1, 'creating a bot does not show it on the other account');

  let rejected = false;
  try {
    store.login({ username: 'ada', password: 'wrong-pass' });
  } catch (err) {
    rejected = err.statusCode === 401;
  }
  assert(rejected, 'wrong password is rejected');
  assert(store.login({ username: 'ADA', password: 'password1' }).id === ada.id, 'login finds the account');

  const token = store.createSession(ada.id);
  const who = store.userFromCookie(`other=1; ${store.COOKIE_NAME}=${encodeURIComponent(token)}`);
  assert(who && who.id === ada.id, 'session cookie finds the account');
  store.destroySession(token);
  assert(store.userFromCookie(`${store.COOKIE_NAME}=${token}`) === null, 'logout ends the session');

  console.log('auth checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
