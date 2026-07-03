const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR, VERIFIED_USERS_FILE } = require("./config");

const EMPTY_STORE = { users: {} };

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VERIFIED_USERS_FILE)) {
    fs.writeFileSync(VERIFIED_USERS_FILE, JSON.stringify(EMPTY_STORE, null, 2));
  }
}

function readStore() {
  ensureStoreFile();
  try {
    const data = JSON.parse(fs.readFileSync(VERIFIED_USERS_FILE, "utf8"));
    if (!data || typeof data !== "object" || !data.users) return { ...EMPTY_STORE };
    return { users: data.users || {} };
  } catch {
    return { ...EMPTY_STORE };
  }
}

function writeStore(store) {
  ensureStoreFile();
  const tmpFile = `${VERIFIED_USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
  fs.renameSync(tmpFile, VERIFIED_USERS_FILE);
}

function upsertVerifiedUser(user) {
  const store = readStore();
  const discordId = String(user.discord_id || user.id || "").trim();
  if (!discordId) throw new Error("discord_id ausente.");
  store.users[discordId] = {
    ...(store.users[discordId] || {}),
    discord_id: discordId,
    username: String(user.username || store.users[discordId]?.username || "usuario"),
    access_token: String(user.access_token || store.users[discordId]?.access_token || ""),
    refresh_token: String(user.refresh_token || store.users[discordId]?.refresh_token || ""),
    expires_at: String(user.expires_at || store.users[discordId]?.expires_at || ""),
    verified_at: String(user.verified_at || store.users[discordId]?.verified_at || new Date().toISOString()),
    updated_at: new Date().toISOString()
  };
  writeStore(store);
  return store.users[discordId];
}

function listVerifiedUsers() {
  return Object.values(readStore().users || {});
}

function countVerifiedUsers() {
  return listVerifiedUsers().length;
}

module.exports = {
  countVerifiedUsers,
  ensureStoreFile,
  listVerifiedUsers,
  upsertVerifiedUser,
  writeStore,
  readStore
};
