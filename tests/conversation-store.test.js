const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createConversationStore } = require('../src/conversation-store');

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novamind-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return createConversationStore(root);
}

test('saves and restores conversation history independently per chat', async t => {
  const store = await makeStore(t);
  const first = { id: 'chat-a', title: 'Projeto', createdAt: 1, updatedAt: 10, messages: [{ role: 'user', content: 'Contexto A' }], memory: '', activity: [] };
  const second = { id: 'chat-b', title: 'Outra conversa', createdAt: 2, updatedAt: 20, messages: [{ role: 'user', content: 'Contexto B' }], memory: '', activity: [] };
  await store.save(first);
  await store.save(second);

  assert.deepEqual(await store.get('chat-a'), { ...first, archived: false, pinned: false });
  assert.deepEqual(await store.get('chat-b'), { ...second, archived: false, pinned: false });
  assert.deepEqual((await store.list()).map(chat => chat.id), ['chat-b', 'chat-a']);
});

test('returns null for missing chats and rejects unsafe ids', async t => {
  const store = await makeStore(t);
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.get('../settings'), /invalid conversation id/i);
  await assert.rejects(store.save({ id: '../settings', title: 'bad', messages: [] }), /invalid conversation id/i);
});

test('supports simultaneous saves without corrupting the conversation file', async t => {
  const store = await makeStore(t);
  const writes = Array.from({ length: 8 }, (_, index) => store.save({
    id: 'parallel', title: 'Concurrente', createdAt: 1, updatedAt: index + 1,
    messages: [{ role: 'user', content: String(index) }]
  }));
  await assert.doesNotReject(Promise.all(writes));
  const saved = await store.get('parallel');
  assert.ok(Number(saved.messages[0].content) >= 0 && Number(saved.messages[0].content) < 8);
});

test('supports pinning and archiving without losing chat content', async t => {
  const store = await makeStore(t);
  await store.save({ id: 'chat-a', title: 'A', messages: [{ role: 'user', content: 'preservar' }] });
  await store.save({ id: 'chat-b', title: 'B', messages: [] });
  await store.updateFlags('chat-a', { pinned: true });
  await store.updateFlags('chat-b', { archived: true });
  const listed = await store.list();
  assert.equal(listed[0].id, 'chat-a');
  assert.equal(listed[0].pinned, true);
  assert.equal(listed[1].archived, true);
  assert.equal((await store.get('chat-a')).messages[0].content, 'preservar');
});