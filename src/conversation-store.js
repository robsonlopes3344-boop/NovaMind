const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_MESSAGES = 1000;
const MAX_MESSAGE_CHARS = 100000;
const MAX_TOTAL_MESSAGE_CHARS = 12_000_000;

function assertId(id) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) throw new Error('Invalid conversation id.');
  return id;
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  const selected = [];
  let total = 0;
  for (let index = value.length - 1; index >= 0 && selected.length < MAX_MESSAGES; index--) {
    const item = value[index];
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
    const content = item.content.slice(0, MAX_MESSAGE_CHARS);
    if (total + content.length > MAX_TOTAL_MESSAGE_CHARS) break;
    total += content.length;
    const images = [];
    if(item.role==='user' && Array.isArray(item.images)) for(const image of item.images.slice(0,4)) {
      if(typeof image==='string' && image.length<=2_000_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) && total+image.length<=MAX_TOTAL_MESSAGE_CHARS){images.push(image);total+=image.length;}
    }
    selected.push({
      role: item.role,
      content,
      ...(images.length ? {images} : {}),
      ...(Number.isFinite(item.createdAt) ? { createdAt: item.createdAt } : {})
    });
  }
  return selected.reverse();
}

function normalizeActivity(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-300).filter(item => item && typeof item === 'object').map(item => ({
    action: String(item.action || '').slice(0, 100),
    target: String(item.target || '').slice(0, 1000),
    at: Number(item.at) || Date.now()
  }));
}

function createConversationStore(rootDir) {
  const writes = new Map();
  const fileFor = id => path.join(rootDir, `${assertId(id)}.json`);

  return {
    async get(id) {
      const file = fileFor(id);
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        return {
          id: assertId(raw.id),
          title: String(raw.title || 'Nova conversa').slice(0, 120),
          createdAt: Number(raw.createdAt) || Date.now(),
          updatedAt: Number(raw.updatedAt) || Date.now(),
          messages: normalizeMessages(raw.messages),
          memory: String(raw.memory || '').slice(0, 24000),
          activity: normalizeActivity(raw.activity),
          archived: raw.archived === true,
          pinned: raw.pinned === true
        };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async save(conversation) {
      if (!conversation || typeof conversation !== 'object') throw new Error('Invalid conversation.');
      const id = assertId(conversation.id);
      const file = fileFor(id);
      const previous = writes.get(id) || Promise.resolve();
      const write = previous.catch(() => {}).then(async () => {
        const safe = {
          id,
          title: String(conversation.title || 'Nova conversa').slice(0, 120),
          createdAt: Number(conversation.createdAt) || Date.now(),
          updatedAt: Number(conversation.updatedAt) || Date.now(),
          messages: normalizeMessages(conversation.messages),
          memory: String(conversation.memory || '').slice(0, 24000),
          activity: normalizeActivity(conversation.activity),
          archived: conversation.archived === true,
          pinned: conversation.pinned === true
        };
        await fs.mkdir(rootDir, { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(temp, JSON.stringify(safe), 'utf8');
        await fs.rename(temp, file);
        return safe;
      });
      writes.set(id, write);
      try {
        return await write;
      } finally {
        if (writes.get(id) === write) writes.delete(id);
      }
    },

    async list() {
      await fs.mkdir(rootDir, { recursive: true });
      const names = await fs.readdir(rootDir);
      const conversations = [];
      for (const name of names.filter(name => /^[a-zA-Z0-9_-]{1,80}\.json$/.test(name))) {
        try {
          const item = JSON.parse(await fs.readFile(path.join(rootDir, name), 'utf8'));
          if (typeof item.id !== 'string' || !VALID_ID.test(item.id)) continue;
          conversations.push({ id: item.id, title: String(item.title || 'Nova conversa').slice(0, 120), createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0, archived: item.archived === true, pinned: item.pinned === true });
        } catch {}
      }
      return conversations.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(a.archived) - Number(b.archived) || (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async updateFlags(id, flags = {}) {
      const current = await this.get(id);
      if (!current) return null;
      return this.save({ ...current, pinned: typeof flags.pinned === 'boolean' ? flags.pinned : current.pinned,
        archived: typeof flags.archived === 'boolean' ? flags.archived : current.archived, updatedAt: Date.now() });
    },

    async remove(id) {
      try {
        await fs.unlink(fileFor(id));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
  };
}

module.exports = { createConversationStore, normalizeMessages };