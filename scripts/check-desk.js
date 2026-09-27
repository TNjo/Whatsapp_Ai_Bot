const base = 'http://127.0.0.1:3780';

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

let createdId = null;

(async () => {
  const health = await api('/api/health');
  const existing = await api('/api/state');
  for (const bot of existing.data.bots || []) {
    if (bot.name === 'Shop line') await api(`/api/bots/${bot.id}`, { method: 'DELETE' });
  }
  assert(health.data.ok, 'health');

  const before = await api('/api/state');
  assert(before.status === 200, 'state');
  assert(!('apiKey' in before.data.api), 'key leaked');

  const badUrl = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ baseUrl: 'not a url' }),
  });
  assert(badUrl.status === 400, `bad url status ${badUrl.status}`);

  const created = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ name: 'Shop line', ownerName: 'Nisal' }),
  });
  assert(created.status === 200, 'create');
  const id = created.data.bot.id;
  createdId = id;
  assert(created.data.bot.settings.ignoreGroups === true, 'groups ignored by default');
  assert(created.data.bot.settings.model === 'openai/gpt-oss-20b', 'default model');

  const saved = await api(`/api/bots/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Shop line',
      settings: {
        ...created.data.bot.settings,
        ownerName: 'Nisal',
        systemPrompt: 'Be brief.',
        maxReplies: 2,
        resetMinutes: 15,
        ignoreGroups: false,
        groupsOnlyWhenMentioned: true,
        excludedNumbers: ['0771234567', '12'],
        excludedGroups: [{ id: '120363000000000000@g.us', name: 'Family' }],
      },
    }),
  });
  assert(saved.status === 200, `save ${saved.status} ${saved.data.error || ''}`);
  assert(saved.data.bot.settings.maxReplies === 2, 'max replies');
  assert(saved.data.bot.settings.excludedNumbers.length === 1, 'short number dropped');
  assert(saved.data.bot.settings.excludedGroups[0].name === 'Family', 'group kept');
  assert(saved.data.bot.settings.ignoreGroups === false, 'groups allowed');

  const again = await api('/api/state');
  const bot = again.data.bots.find(item => item.id === id);
  assert(bot && bot.settings.systemPrompt === 'Be brief.', 'persisted prompt');

  const chats = await api(`/api/bots/${id}/chats`);
  assert(chats.status === 409, `chats while idle ${chats.status}`);

  const started = await api(`/api/bots/${id}/start`, { method: 'POST', body: '{}' });
  assert(started.status === 200, 'start');
  assert(['starting', 'qr', 'authenticated', 'ready', 'error'].includes(started.data.bot.runtime.status), started.data.bot.runtime.status);

  const stopped = await api(`/api/bots/${id}/stop`, { method: 'POST', body: '{}' });
  assert(stopped.status === 200, 'stop');
  assert(stopped.data.bot.runtime.status === 'stopped', `stop status ${stopped.data.bot.runtime.status}`);

  const testKey = await api('/api/settings/test', {
    method: 'POST',
    body: JSON.stringify({ apiKey: 'not-a-real-key', baseUrl: 'https://api.groq.com/openai/v1' }),
  });
  assert(testKey.status === 400, `test key ${testKey.status} ${testKey.data.error}`);
  assert(!String(testKey.data.error || '').includes('not-a-real-key'), 'key echoed in error');

  const afterTest = await api('/api/state');
  assert(afterTest.data.api.configured === before.data.api.configured, 'test saved a key');

  const removed = await api(`/api/bots/${id}`, { method: 'DELETE' });
  assert(removed.status === 200, 'delete');
  const end = await api('/api/state');
  assert(!end.data.bots.some(item => item.id === id), 'bot removed');
  console.log('desk checks passed');
})().catch(async err => {
  console.error(err);
  if (createdId) {
    await fetch(`${base}/api/bots/${createdId}`, { method: 'DELETE' }).catch(() => {});
  }
  process.exit(1);
});
