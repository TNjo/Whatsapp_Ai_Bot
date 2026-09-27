const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-http-'));
const port = 3791;
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  apiKey: 'legacy-key-value',
  baseUrl: 'https://api.groq.com/openai/v1',
  bots: [{
    id: 'bot_legacy0001',
    name: 'Old line',
    createdAt: '2026-01-01T00:00:00.000Z',
    desiredRunning: false,
    linked: null,
    settings: { ownerName: 'Ada' },
  }],
}));

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), BOOTH_DATA: dir },
  stdio: 'ignore',
});

function request(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        const setCookie = res.headers['set-cookie'] || [];
        const booth = setCookie.map(item => String(item).split(';')[0]).find(item => item.startsWith('booth='));
        resolve({ status: res.statusCode, data, cookie: booth || cookie || '' });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/health');
      if (res.status === 200) return;
    } catch {
      // server still starting
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('temp desk did not start');
}

(async () => {
  try {
    await waitForHealth();
    const ada = await request('POST', '/api/auth/register', { body: { username: 'ada', password: 'password1' } });
    assert(ada.status === 200, 'first account registers');
    const adaState = await request('GET', '/api/state', { cookie: ada.cookie });
    assert(adaState.status === 200, 'first account can open the desk');
    assert(adaState.data.bots.length === 1, 'first account sees the existing bot');
    assert(adaState.data.api.configured === true, 'first account keeps the saved key');
    assert(adaState.data.api.hint === 'alue', 'key stays masked');
    assert(!JSON.stringify(adaState.data).includes('legacy-key-value'), 'full key is not returned');

    const bea = await request('POST', '/api/auth/register', { body: { username: 'bea', password: 'password2' } });
    const beaState = await request('GET', '/api/state', { cookie: bea.cookie });
    assert(beaState.data.bots.length === 0, 'second account sees no bots');
    assert(beaState.data.api.configured === false, 'second account has no key');

    const stolen = await request('GET', '/api/bots/bot_legacy0001/chats', { cookie: bea.cookie });
    assert(stolen.status === 404, 'second account cannot open the first bot chats');
    const patched = await request('PATCH', '/api/bots/bot_legacy0001', {
      cookie: bea.cookie,
      body: { settings: { ignoreGroups: false, maxReplies: 1 } },
    });
    assert(patched.status === 404, 'second account cannot change the first bot behavior');

    const saved = await request('PATCH', '/api/bots/bot_legacy0001', {
      cookie: ada.cookie,
      body: { settings: { ownerName: 'Ada', ignoreGroups: false, maxReplies: 8 } },
    });
    assert(saved.status === 200 && saved.data.bot.settings.ignoreGroups === false, 'owner can change behavior');
    assert(saved.data.bot.settings.maxReplies === 8, 'owner reply limit is saved');

    const created = await request('POST', '/api/bots', { cookie: bea.cookie, body: { name: 'Bea line', ownerName: 'Bea' } });
    assert(created.status === 200, 'second account can create a bot');
    const adaAgain = await request('GET', '/api/state', { cookie: ada.cookie });
    assert(adaAgain.data.bots.length === 1, 'the new bot stays off the first account');
    assert(adaAgain.data.bots[0].settings.maxReplies === 8, 'first account behavior is unchanged');

    await request('POST', '/api/auth/logout', { cookie: ada.cookie });
    const after = await request('GET', '/api/state', { cookie: ada.cookie });
    assert(after.status === 401, 'logout closes the desk');
    console.log('http auth checks passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err.message);
  child.kill('SIGTERM');
  process.exit(1);
});
