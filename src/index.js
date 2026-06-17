require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const config = require("../config.json");
const DEFAULT_CUSTOMER_ROLE_ID = "1515799363149103138";
const DEFAULT_RESELLER_ROLE_ID = "1515835494204706938";
const DEFAULT_COMPLETION_CHANNEL_ID = "1515799364155478138";
const DEFAULT_CANCELLATION_CHANNEL_ID = "1516561891919528037";
const STAFF_BACKUP_MARKER = "DRAGON_STORE_STAFF_BACKUP_V1";
const STAFF_BACKUP_FILE = "dragon-store-staff-backup.json";

const PORT = process.env.PORT || 3000;
http.createServer(handleHttpRequest).listen(PORT, () => console.log(`Health server rodando na porta ${PORT}`));

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, "..", "data");
const PANELS_FILE = path.join(DATA_DIR, "panels.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const STAFF_FILE = path.join(DATA_DIR, "staff.json");
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const BOT_KV_PREFIX = process.env.BOT_KV_PREFIX || "dragon-store:bot";
const KV_FILE_KEYS = {
  [PANELS_FILE]: `${BOT_KV_PREFIX}:panels`,
  [ORDERS_FILE]: `${BOT_KV_PREFIX}:orders`,
  [STAFF_FILE]: `${BOT_KV_PREFIX}:staff`
};
const memoryJsonStore = new Map();

ensureDataDir();
ensureJsonFile(PANELS_FILE, { guilds: {} });
ensureJsonFile(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {} });
ensureJsonFile(STAFF_FILE, { guilds: {} });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const sessions = new Map();
const imageUploads = new Map();
const cartDeleteTimers = new Map();
const publicPanelScanCache = new Map();
const IMAGE_UPLOAD_TTL_MS = 3 * 60 * 1000;
const MAX_SAVED_IMAGE_BYTES = 8 * 1024 * 1024;

function cloneJson(data) {
  return JSON.parse(JSON.stringify(data));
}
function rememberJson(file, data) {
  memoryJsonStore.set(file, cloneJson(data));
}
function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    console.log(`Nao consegui preparar pasta de dados no disco (${error.message}); usando memoria/backup.`);
  }
}
function ensureJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
  } catch (error) {
    rememberJson(file, fallback);
    console.log(`Nao consegui preparar ${path.basename(file)} no disco (${error.message}); usando memoria/backup.`);
  }
}
function readJson(file, fallback) {
  if (memoryJsonStore.has(file)) return cloneJson(memoryJsonStore.get(file));
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    rememberJson(file, data);
    return data;
  } catch {
    return cloneJson(fallback);
  }
}
function writeJsonLocal(file, data) {
  rememberJson(file, data);
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, file);
}
function writeJson(file, data) {
  rememberJson(file, data);
  try {
    writeJsonLocal(file, data);
  } catch (error) {
    console.log(`Nao consegui gravar ${path.basename(file)} no disco (${error.message}); mantendo em memoria e tentando KV.`);
  }
  persistJsonToKv(file, data).catch(error => {
    console.log(`Nao consegui salvar ${path.basename(file)} no KV: ${error.message}`);
  });
}
function kvEnabled() {
  return Boolean(KV_REST_API_URL && KV_REST_API_TOKEN);
}
function kvBaseUrl() {
  return KV_REST_API_URL.replace(/\/$/, "");
}
async function readJsonFromKv(key) {
  if (!kvEnabled()) return null;
  const response = await fetch(`${kvBaseUrl()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`KV GET HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.result) return null;
  return typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
}
async function writeJsonToKv(key, data) {
  if (!kvEnabled()) return false;
  const response = await fetch(`${kvBaseUrl()}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "text/plain"
    },
    body: JSON.stringify(data)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `KV SET HTTP ${response.status}`);
  return true;
}
function hasUsefulPersistedData(file, data) {
  if (!data || typeof data !== "object") return false;
  if (file === PANELS_FILE || file === STAFF_FILE) return Object.keys(data.guilds || {}).length > 0;
  if (file === ORDERS_FILE) {
    return Object.keys(data.orders || {}).length > 0 ||
      Object.keys(data.tickets || {}).length > 0 ||
      Object.keys(data.customers || {}).length > 0 ||
      Object.keys(data.sellers || {}).length > 0;
  }
  return Object.keys(data).length > 0;
}
async function hydrateJsonFromKv(file, fallback) {
  const key = KV_FILE_KEYS[file];
  if (!key || !kvEnabled()) return false;
  const remote = await readJsonFromKv(key).catch(error => {
    console.log(`Nao consegui carregar ${path.basename(file)} do KV: ${error.message}`);
    return null;
  });
  if (!hasUsefulPersistedData(file, remote)) return false;
  const data = remote || fallback;
  try {
    writeJsonLocal(file, data);
    console.log(`${path.basename(file)} carregado do KV.`);
  } catch (error) {
    rememberJson(file, data);
    console.log(`${path.basename(file)} carregado do KV em memoria (${error.message}).`);
  }
  return true;
}
async function persistJsonToKv(file, data) {
  const key = KV_FILE_KEYS[file];
  if (!key || !kvEnabled()) return false;
  return writeJsonToKv(key, data);
}
async function hydratePersistentFiles() {
  if (!kvEnabled()) {
    console.log("KV do bot nao configurado; usando JSON local para paineis, pedidos e Pix.");
    return;
  }

  await Promise.all([
    hydrateJsonFromKv(PANELS_FILE, { guilds: {} }),
    hydrateJsonFromKv(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {} }),
    hydrateJsonFromKv(STAFF_FILE, { guilds: {} })
  ]);
}
async function flushPersistentFile(file) {
  const data = readJson(file, {});
  await persistJsonToKv(file, data);
}
function ensureOrdersStore(db) {
  const store = db && typeof db === "object" ? db : {};
  if (!store.orders) store.orders = {};
  if (!store.tickets) store.tickets = {};
  if (!store.customers) store.customers = {};
  if (!store.sellers) store.sellers = {};
  return store;
}
function readPanels() { return readJson(PANELS_FILE, { guilds: {} }); }
function writePanels(data) { writeJson(PANELS_FILE, data); }
function readOrders() { return ensureOrdersStore(readJson(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {} })); }
function writeOrders(data) { writeJson(ORDERS_FILE, ensureOrdersStore(data)); }
function readStaff() { return readJson(STAFF_FILE, { guilds: {} }); }
function writeStaff(data) { writeJson(STAFF_FILE, data); }
function defaultStaffGuild() {
  return {
    users: {},
    panelChannelId: "",
    panelMessageId: "",
    backupChannelId: "",
    backupMessageId: "",
    successChannelId: "",
    successMessageEnabled: false,
    customerRoleId: ""
  };
}
function getStaffGuild(guildId) {
  const db = readStaff();
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = defaultStaffGuild();
    writeStaff(db);
  }
  db.guilds[guildId] = { ...defaultStaffGuild(), ...db.guilds[guildId], users: db.guilds[guildId].users || {} };
  return db.guilds[guildId];
}
function saveStaffGuild(guildId, staffGuild) {
  const db = readStaff();
  db.guilds[guildId] = staffGuild;
  writeStaff(db);
}
function getStaffProfile(guildId, userId) {
  const staff = getStaffGuild(guildId);
  return staff.users[userId] || null;
}
function saveStaffProfile(guildId, userId, profilePatch) {
  const staff = getStaffGuild(guildId);
  const old = staff.users[userId] || {};
  staff.users[userId] = {
    userId,
    displayName: old.displayName || "",
    pixKey: old.pixKey || "",
    qrCodeUrl: old.qrCodeUrl || "",
    note: old.note || "",
    online: Boolean(old.online),
    updatedAt: old.updatedAt || new Date().toISOString(),
    ...profilePatch,
    updatedAt: new Date().toISOString()
  };
  saveStaffGuild(guildId, staff);
  return staff.users[userId];
}
function configuredStaffProfiles(guildId) {
  const staff = getStaffGuild(guildId);
  return Object.values(staff.users || {}).filter(p => p.pixKey || p.displayName);
}
function onlineStaffProfiles(guildId) {
  return configuredStaffProfiles(guildId).filter(p => p.online && p.pixKey);
}
function staffDisplayName(profile, fallbackUser) {
  return String(profile?.displayName || fallbackUser?.username || "ADM").trim() || "ADM";
}
function staffStatusEmoji(profile) {
  return profile?.online ? "🟢" : "⚫";
}

function random7() { return String(Math.floor(1000000 + Math.random() * 9000000)); }
function sid() { return Math.random().toString(36).slice(2, 9); }
function parseColor(hex, fallback = 0x9b00ff) {
  const clean = String(hex || "").replace("#", "");
  const n = Number.parseInt(clean, 16);
  return Number.isNaN(n) ? fallback : n;
}
function normColor(v) {
  const raw = String(v || "").trim();
  const c = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#9b00ff";
}
function validUrl(v) {
  const raw = String(v || "").trim();
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol);
  } catch { return false; }
}
function imageUploadKey(guildId, channelId, userId) {
  return `${guildId}:${channelId}:${userId}`;
}
function isImageAttachment(attachment) {
  const type = String(attachment.contentType || "");
  const name = String(attachment.name || attachment.url || "");
  return type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}
function savedImageName(attachment) {
  const original = String(attachment.name || "imagem.png");
  const extension = original.match(/\.(png|jpe?g|webp|gif)$/i)?.[0]?.toLowerCase() || ".png";
  return `dragon-store-${random7()}${extension}`;
}
function imageUploadTargetLabel(pending, panel) {
  if (pending.target === "panelImage") return "banner do painel";
  if (pending.target === "panelThumb") return "thumbnail do painel";
  if (pending.target === "product") {
    const p = product(panel, pending.productId);
    return p ? `foto do produto ${p.name}` : "foto do produto";
  }
  return "imagem";
}
function safeName(text) {
  return String(text || "usuario")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 24) || "usuario";
}
function clampText(value, max, fallback = "") {
  const text = String(value || fallback).trim();
  return text.slice(0, max);
}
function parsePrice(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const onlyNumber = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(onlyNumber);
  return Number.isFinite(amount) ? amount : null;
}
function money(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
function plainText(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
function resellerRoleId() {
  return String(process.env.RESELLER_ROLE_ID || config.resellerRoleId || DEFAULT_RESELLER_ROLE_ID || "").trim();
}
function resellerDiscountPercent() {
  const value = Number.parseFloat(String(process.env.RESELLER_DISCOUNT_PERCENT ?? config.resellerDiscountPercent ?? 10).replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(90, value);
}
function memberHasRole(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}
function discountForMember(member) {
  const roleId = resellerRoleId();
  const percent = resellerDiscountPercent();
  if (!roleId || percent <= 0 || !memberHasRole(member, roleId)) return null;
  return {
    type: "role",
    roleId,
    percent,
    label: `Desconto revendedor/premium (${percent}% OFF)`
  };
}
function orderDiscountPercent(order) {
  const percent = Number.parseFloat(String(order?.discount?.percent ?? 0).replace(",", "."));
  return Number.isFinite(percent) && percent > 0 ? Math.min(90, percent) : 0;
}
function applyOrderDiscount(gross, order) {
  const percent = orderDiscountPercent(order);
  if (percent <= 0 || gross <= 0) return { amount: roundCurrency(gross), discountAmount: 0, discountPercent: 0 };
  const discountAmount = roundCurrency(gross * (percent / 100));
  return {
    amount: roundCurrency(Math.max(0, gross - discountAmount)),
    discountAmount,
    discountPercent: percent
  };
}
function pixBoxDefaults() {
  const min = Number.parseFloat(String(process.env.PIX_BOX_MIN ?? config.settings?.pixBoxMin ?? 0).replace(",", "."));
  const max = Number.parseFloat(String(process.env.PIX_BOX_MAX ?? config.settings?.pixBoxMax ?? 1000).replace(",", "."));
  const cleanMin = Number.isFinite(min) ? Math.max(0, min) : 0;
  const cleanMax = Number.isFinite(max) ? Math.max(cleanMin, max) : 1000;
  return { min: cleanMin, max: cleanMax };
}
function parsePixAmount(value) {
  const parsed = parsePrice(value);
  return parsed === null ? null : Math.max(0, parsed);
}
function parsePixRangeFromText(value) {
  const text = String(value || "");
  const match = text.match(/(?:pix|valor|faixa|range)?[^0-9]*(\d+(?:[,.]\d{1,2})?)\s*(?:a|ate|até|e|para|to|-|~|\s+)\s*(\d+(?:[,.]\d{1,2})?)/i);
  if (!match) return null;

  const first = parsePixAmount(match[1]);
  const second = parsePixAmount(match[2]);
  if (first === null || second === null) return null;

  return {
    min: Math.min(first, second),
    max: Math.max(first, second)
  };
}
function parsePixNamedAmount(value) {
  const text = String(value || "");
  const centavos = text.match(/(\d+(?:[,.]\d{1,2})?)\s*centavo/i);
  if (centavos) {
    const amount = parsePixAmount(centavos[1]);
    return amount === null ? null : amount / 100;
  }

  const reais = text.match(/(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)\s*(?:real|reais)/i);
  if (reais) return parsePixAmount(reais[1]);

  const currency = text.match(/r\$\s*(\d+(?:[,.]\d{1,2})?)/i);
  return currency ? parsePixAmount(currency[1]) : null;
}
function normalizePixRange(minValue, maxValue, fallbackText = "") {
  const defaults = pixBoxDefaults();
  const fromColumns = parsePixAmount(minValue) !== null && parsePixAmount(maxValue) !== null
    ? { min: parsePixAmount(minValue), max: parsePixAmount(maxValue) }
    : null;
  const fromText = parsePixRangeFromText(fallbackText);
  const namedAmount = parsePixNamedAmount(fallbackText);
  const fromName = namedAmount === null ? null : { min: namedAmount, max: namedAmount };
  const range = fromColumns || fromText || fromName || defaults;
  return {
    min: Math.min(range.min, range.max),
    max: Math.max(range.min, range.max)
  };
}
function randomPixAmount(min, max) {
  const low = Math.round(Math.min(min, max) * 100);
  const high = Math.round(Math.max(min, max) * 100);
  return (Math.floor(Math.random() * (high - low + 1)) + low) / 100;
}
function publicDiscordInviteUrl(value) {
  const target = "https://discord.gg/ZyxwUekHWh";
  const raw = String(value || "").trim();
  if (!raw) return target;
  if (/5fyPxMXBTC|Y2MqnVwXnq|rapp28qmR4/i.test(raw)) return target;
  return raw;
}
function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator) || member?.roles?.cache?.has(config.adminRoleId));
}
async function requireAdminInteraction(interaction, text = "Você precisa ser ADM para usar esse comando.") {
  if (isAdmin(interaction.member)) return true;
  await interaction.reply({ content: text, ephemeral: true });
  return false;
}

async function sendSafeDM(userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (error) {
    console.log(`Não consegui mandar DM para ${userId}: ${error.message}`);
    return false;
  }
}

function buildStaffPanelEmbed(guildId) {
  const staff = getStaffGuild(guildId);
  const profiles = Object.values(staff.users || {});

  const lines = profiles.length
    ? profiles
        .sort((a, b) => String(a.displayName || a.userId).localeCompare(String(b.displayName || b.userId)))
        .map(profile => {
          const pix = profile.pixKey ? "Pix configurado ✅" : "Pix faltando ⚠️";
          return `${staffStatusEmoji(profile)} **${profile.displayName || "ADM"}** — <@${profile.userId}> | ${pix}`;
        })
        .join("\n")
    : "Nenhum ADM configurou Pix ainda. Clique em **Configurar meu Pix**.";

  return new EmbedBuilder()
    .setTitle("🟢 Atendimento / Recebedores Pix")
    .setDescription(
      `Use esse painel para dizer quem está online para receber vendas.\n\n` +
      `Quando o cliente abrir carrinho:\n` +
      `• se só 1 ADM estiver ON, a compra vai automaticamente para ele;\n` +
      `• se 2 ou mais estiverem ON, fica para quem clicar em **Assumir compra** primeiro;\n` +
      `• só ADM consegue assumir.\n\n` +
      `**Status atual:**\n${lines}`
    )
    .setColor(0x2ecc71)
    .setFooter({ text: "Configure seu Pix antes de ficar online." })
    .setTimestamp();
}
function staffPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("staff:on").setLabel("Ficar ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("staff:off").setLabel("Ficar OFF").setEmoji("⚫").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("staff:config").setLabel("Configurar meu Pix").setEmoji("💸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("staff:refresh").setLabel("Atualizar").setEmoji("♻️").setStyle(ButtonStyle.Secondary)
    )
  ];
}
function pixShortcutRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("staff:config")
        .setLabel("Configurar meu Pix")
        .setEmoji("💸")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}
function isStaffPanelMessage(message) {
  if (!message || message.author?.id !== client.user?.id) return false;
  const title = message.embeds?.[0]?.title || "";
  const hasStaffButtons = message.components?.some(row =>
    row.components?.some(component => String(component.customId || component.data?.custom_id || "").startsWith("staff:"))
  );
  return hasStaffButtons || plainText(title).includes("atendimento") && plainText(title).includes("pix");
}
function isStaffBackupMessage(message) {
  return message?.author?.id === client.user?.id && String(message.content || "").includes(STAFF_BACKUP_MARKER);
}
async function findBotMessage(channel, predicate, limit = 100) {
  if (!channel?.isTextBased()) return null;
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages) return null;
  return messages.find(predicate) || null;
}
async function findBotMessageInGuild(guild, predicate, preferredChannel = null, limit = 50) {
  const preferred = await findBotMessage(preferredChannel, predicate, limit);
  if (preferred) return preferred;

  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  for (const channel of channels.values()) {
    if (!channel?.isTextBased() || channel.id === preferredChannel?.id) continue;
    const found = await findBotMessage(channel, predicate, limit);
    if (found) return found;
  }
  return null;
}
function staffBackupChannelId(staff, fallbackChannelId = "") {
  return String(process.env.STAFF_BACKUP_CHANNEL_ID || config.staffBackup?.channelId || staff.backupChannelId || staff.panelChannelId || fallbackChannelId || "").trim();
}
async function readStaffBackupMessage(message) {
  if (!message) return null;

  const attachment = message.attachments?.find(file => file.name === STAFF_BACKUP_FILE) || message.attachments?.first?.();
  if (attachment?.url) {
    const response = await fetch(attachment.url).catch(() => null);
    if (response?.ok) {
      const json = await response.json().catch(() => null);
      if (json?.staff) return json.staff;
    }
  }

  const encoded = String(message.content || "").split(STAFF_BACKUP_MARKER)[1]?.trim();
  if (!encoded) return null;
  try {
    const json = JSON.parse(Buffer.from(encoded.replace(/^\|\||\|\|$/g, ""), "base64url").toString("utf8"));
    return json.staff || null;
  } catch {
    return null;
  }
}
async function findStaffBackupMessage(guild, staff, fallbackChannel = null) {
  const candidates = [
    { channelId: staff.backupChannelId, messageId: staff.backupMessageId },
    { channelId: staff.panelChannelId, messageId: staff.backupMessageId }
  ];

  for (const candidate of candidates) {
    if (!candidate.channelId || !candidate.messageId) continue;
    const channel = await guild.channels.fetch(candidate.channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;
    const message = await channel.messages.fetch(candidate.messageId).catch(() => null);
    if (isStaffBackupMessage(message)) return message;
  }

  const channelId = staffBackupChannelId(staff, fallbackChannel?.id || "");
  const channel = channelId
    ? await guild.channels.fetch(channelId).catch(() => null)
    : fallbackChannel;
  if (channel?.isTextBased()) {
    const found = await findBotMessage(channel, isStaffBackupMessage);
    if (found) return found;
  }
  return findBotMessageInGuild(guild, isStaffBackupMessage, fallbackChannel);
}
async function recoverStaffBackup(guild, fallbackChannel = null) {
  const db = readStaff();
  const current = db.guilds?.[guild.id] ? { ...defaultStaffGuild(), ...db.guilds[guild.id], users: db.guilds[guild.id].users || {} } : defaultStaffGuild();
  const backupMessage = await findStaffBackupMessage(guild, current, fallbackChannel);
  const backup = await readStaffBackupMessage(backupMessage);
  if (!backup) return current;

  const merged = {
    ...defaultStaffGuild(),
    ...backup,
    users: {
      ...(backup.users || {}),
      ...(current.users || {})
    },
    backupChannelId: backupMessage.channel.id,
    backupMessageId: backupMessage.id
  };
  for (const key of ["panelChannelId", "panelMessageId", "successChannelId", "customerRoleId"]) {
    if (current[key]) merged[key] = current[key];
  }
  if (current.successMessageEnabled) merged.successMessageEnabled = current.successMessageEnabled;
  db.guilds[guild.id] = merged;
  writeStaff(db);
  return merged;
}
async function recoverStaffPanelMessage(guild, channel, staff = getStaffGuild(guild.id)) {
  if (staff.panelChannelId && staff.panelMessageId) {
    const oldChannel = await guild.channels.fetch(staff.panelChannelId).catch(() => null);
    const oldMessage = oldChannel?.isTextBased()
      ? await oldChannel.messages.fetch(staff.panelMessageId).catch(() => null)
      : null;
    if (oldMessage) return oldMessage;
  }

  const found = await findBotMessageInGuild(guild, isStaffPanelMessage, channel);
  if (!found) return null;

  staff.panelChannelId = found.channel.id;
  staff.panelMessageId = found.id;
  saveStaffGuild(guild.id, staff);
  return found;
}
async function ensureStaffState(guild, channel = null) {
  let staff = await recoverStaffBackup(guild, channel);
  const panelMessage = await recoverStaffPanelMessage(guild, channel, staff);
  if (panelMessage) {
    staff = getStaffGuild(guild.id);
    staff.panelChannelId = panelMessage.channel.id;
    staff.panelMessageId = panelMessage.id;
    saveStaffGuild(guild.id, staff);
  }
  return getStaffGuild(guild.id);
}
async function saveStaffBackup(guild, fallbackChannel = null) {
  const staff = getStaffGuild(guild.id);
  const channelId = staffBackupChannelId(staff, fallbackChannel?.id || "");
  const channel = channelId
    ? await guild.channels.fetch(channelId).catch(() => null)
    : fallbackChannel;
  if (!channel?.isTextBased()) return false;

  const payload = Buffer.from(JSON.stringify({
    version: 1,
    guildId: guild.id,
    savedAt: new Date().toISOString(),
    staff
  }));
  const file = new AttachmentBuilder(payload, { name: STAFF_BACKUP_FILE });
  const content = `||${STAFF_BACKUP_MARKER}||\nBackup tecnico do atendimento/Pix. Nao apagar.`;
  let message = null;

  if (staff.backupMessageId) {
    message = await channel.messages.fetch(staff.backupMessageId).catch(() => null);
  }
  if (!message) message = await findBotMessage(channel, isStaffBackupMessage);
  if (message) {
    await message.edit({ content, attachments: [], files: [file] });
  } else {
    message = await channel.send({ content, files: [file] });
  }

  staff.backupChannelId = channel.id;
  staff.backupMessageId = message.id;
  saveStaffGuild(guild.id, staff);
  return true;
}
async function refreshStaffPanel(guildId) {
  const staff = getStaffGuild(guildId);
  if (!staff.panelChannelId || !staff.panelMessageId) return false;

  try {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(staff.panelChannelId);
    if (!channel || !channel.isTextBased()) return false;
    const message = await channel.messages.fetch(staff.panelMessageId);
    await message.edit({ embeds: [buildStaffPanelEmbed(guildId)], components: staffPanelRows() });
    return true;
  } catch (error) {
    console.log("Não consegui atualizar painel de atendimento:", error.message);
    return false;
  }
}
async function setupStaffPanel(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const channel = interactionOrMessage.channel;
  const member = interactionOrMessage.member;

  if (!isAdmin(member)) {
    const text = "Você precisa ser admin ou ter o cargo ADM configurado para criar esse painel.";
    if (interactionOrMessage.isRepliable?.()) return interactionOrMessage.reply({ content: text, ephemeral: true });
    return channel.send(text);
  }

  let staff = await ensureStaffState(guild, channel);
  let oldMessage = await recoverStaffPanelMessage(guild, channel, staff);

  if (oldMessage) {
    await oldMessage.edit({ embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() });
    await saveStaffBackup(guild, oldMessage.channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));
    staff = getStaffGuild(guild.id);
    if (interactionOrMessage.isRepliable?.()) {
      return interactionOrMessage.reply({ content: `Painel de atendimento atualizado em <#${staff.panelChannelId}>.`, ephemeral: true });
    }
    return channel.send(`Painel de atendimento atualizado em <#${staff.panelChannelId}>.`);
  }

  const sent = await channel.send({ embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() });
  staff.panelChannelId = channel.id;
  staff.panelMessageId = sent.id;
  saveStaffGuild(guild.id, staff);
  await saveStaffBackup(guild, channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));

  if (interactionOrMessage.isRepliable?.()) {
    return interactionOrMessage.reply({ content: `Painel de atendimento criado em <#${channel.id}>.`, ephemeral: true });
  }
}
async function savePixBackupCommand(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const channel = interactionOrMessage.channel;
  const member = interactionOrMessage.member;

  if (!isAdmin(member)) {
    const text = "So ADM pode salvar backup do Pix.";
    if (interactionOrMessage.isRepliable?.()) return interactionOrMessage.reply({ content: text, ephemeral: true });
    return channel.send(text);
  }

  await ensureStaffState(guild, channel);
  const saved = await saveStaffBackup(guild, channel).catch(error => {
    console.log(`Nao consegui salvar backup do Pix: ${error.message}`);
    return false;
  });
  await refreshStaffPanel(guild.id);

  const staff = getStaffGuild(guild.id);
  const text = saved
    ? `Backup do Pix salvo. Painel: ${staff.panelChannelId ? `<#${staff.panelChannelId}>` : "nao vinculado"}.`
    : "Nao consegui salvar backup do Pix. Confira se o bot pode enviar mensagem/anexo neste canal.";

  if (interactionOrMessage.isRepliable?.()) return interactionOrMessage.reply({ content: text, ephemeral: true });
  return channel.send(text);
}
function pixConfigModal(guildId, user) {
  const current = getStaffProfile(guildId, user.id) || {};

  return new ModalBuilder()
    .setCustomId("pixmodal")
    .setTitle("Configurar meu Pix")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("displayName")
          .setLabel("Nome que aparece na venda")
          .setPlaceholder("Ex: Sávio, Bruno")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setValue(String(current.displayName || user.username).slice(0, 50))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pixKey")
          .setLabel("Chave Pix")
          .setPlaceholder("CPF, email, telefone ou chave aleatória")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(180)
          .setRequired(true)
          .setValue(String(current.pixKey || "").slice(0, 180))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("qrCodeUrl")
          .setLabel("Link da imagem do QR Code, se tiver")
          .setPlaceholder("https://.../qrcode.png")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false)
          .setValue(String(current.qrCodeUrl || "").slice(0, 500))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Mensagem extra opcional")
          .setPlaceholder("Ex: Envie o comprovante aqui no carrinho.")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(700)
          .setRequired(false)
          .setValue(String(current.note || "Envie o comprovante aqui no carrinho.").slice(0, 700))
      )
    );
}
function buildPixEmbed(order, panel, profile) {
  const embed = new EmbedBuilder()
    .setTitle("💸 Pagamento Pix")
    .setDescription(
      `**Atendente:** ${profile.displayName || "ADM"} (<@${profile.userId}>)\n` +
      `**ID da compra:** \`${order.id}\`\n\n` +
      `**Total estimado:** ${totalLine(order, panel)}\n\n` +
      `**Chave Pix:**\n\`${profile.pixKey}\`\n\n` +
      `**Resumo:**\n${cartText(order, panel)}\n\n` +
      `${profile.note || "Envie o comprovante aqui no carrinho."}`
    )
    .setColor(parseColor(panel.color))
    .setTimestamp();

  if (profile.qrCodeUrl && validUrl(profile.qrCodeUrl)) embed.setImage(profile.qrCodeUrl);
  return embed;
}
function staffChoiceEmbed(order, guildId) {
  const online = onlineStaffProfiles(guildId);
  const onlineLine = online.length
    ? online.map(p => `🟢 **${p.displayName || "ADM"}** (<@${p.userId}>)`).join("\n")
    : "Nenhum ADM online. Um ADM ainda pode configurar Pix e assumir manualmente.";

  const assignedLine = order.assignedAdminId
    ? `✅ Assumido por **${order.assignedAdminName || "ADM"}** (<@${order.assignedAdminId}>).`
    : "⏳ Aguardando um ADM assumir.";

  return new EmbedBuilder()
    .setTitle("👥 Atendimento da compra")
    .setDescription(
      `${assignedLine}\n\n` +
      `**ADMs online:**\n${onlineLine}\n\n` +
      `Só quem tem cargo ADM pode clicar. Se tiver mais de um ON, fica para quem clicar primeiro.`
    )
    .setColor(order.assignedAdminId ? 0x2ecc71 : 0xf1c40f);
}
function staffChoiceRows(orderId, assigned = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`assume:${orderId}`).setLabel("Assumir compra").setEmoji("🙋").setStyle(ButtonStyle.Success).setDisabled(assigned),
      new ButtonBuilder().setCustomId(`sendpix:${orderId}`).setLabel("Reenviar Pix").setEmoji("💸").setStyle(ButtonStyle.Primary).setDisabled(!assigned)
    )
  ];
}
async function sendStaffChoiceMessage(channel, order, guildId) {
  const online = onlineStaffProfiles(guildId);
  const panel = getOrderPanel(order, guildId);

  if ((order.items || []).length && online.length === 1 && !order.assignedAdminId) {
    const profile = online[0];
    const db = readOrders();
    const saved = db.orders[order.id];
    if (saved && !saved.assignedAdminId) {
      saved.assignedAdminId = profile.userId;
      saved.assignedAdminName = profile.displayName || "ADM";
      saved.assignedAt = new Date().toISOString();
      db.orders[order.id] = saved;
      writeOrders(db);
      order = saved;
    }

    await channel.send({
      content: `<@${order.userId}> ✅ Compra assumida automaticamente por **${profile.displayName || "ADM"}**, único ADM online.`,
      embeds: [buildPixEmbed(order, panel, profile)],
      components: staffChoiceRows(order.id, true),
      allowedMentions: { users: [order.userId] }
    });

    await sendSafeDM(order.userId, {
      embeds: [buildPixEmbed(order, panel, profile)]
    });

    return;
  }

  await channel.send({ embeds: [staffChoiceEmbed(order, guildId)], components: staffChoiceRows(order.id, Boolean(order.assignedAdminId)) });
}
async function assumeOrder(interaction, id) {
  const db = readOrders();
  const order = orderForAction(db, id, interaction);

  if (!order || order.status !== "open") {
    return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode assumir compra.", ephemeral: true });
  }

  if (order.assignedAdminId) {
    return interaction.reply({ content: `Essa compra já foi assumida por <@${order.assignedAdminId}>.`, ephemeral: true });
  }

  await ensureStaffState(interaction.guild, interaction.channel);
  const profile = getStaffProfile(interaction.guildId, interaction.user.id);
  if (!profile?.pixKey) {
    return interaction.reply({ content: "Configure seu Pix primeiro com `!configpix`, `/configpix` ou no botão **Configurar meu Pix** do painel de atendimento.", ephemeral: true });
  }

  const online = onlineStaffProfiles(interaction.guildId);
  if (online.length > 0 && !profile.online) {
    return interaction.reply({ content: "Você está OFF. Clique em **Ficar ON** no painel de atendimento antes de assumir.", ephemeral: true });
  }

  order.assignedAdminId = interaction.user.id;
  order.assignedAdminName = profile.displayName || interaction.user.username;
  order.assignedAt = new Date().toISOString();
  db.orders[order.id] = order;
  writeOrders(db);

  const panel = getOrderPanel(order, actionGuildId(interaction));

  await interaction.channel.send({
    content: `<@${order.userId}> ✅ Compra #${order.id} assumida por **${order.assignedAdminName}** (<@${interaction.user.id}>).`,
    embeds: [buildPixEmbed(order, panel, profile)],
    components: staffChoiceRows(order.id, true),
    allowedMentions: { users: [order.userId, interaction.user.id] }
  });

  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return interaction.reply({ content: "Compra assumida e Pix enviado.", ephemeral: true });
}
async function resendPix(interaction, id) {
  const db = readOrders();
  const order = orderForAction(db, id, interaction);

  if (!order || order.status !== "open") {
    return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode reenviar Pix.", ephemeral: true });
  }

  if (!order.assignedAdminId) {
    return interaction.reply({ content: "Essa compra ainda não foi assumida. Clique em **Assumir compra** primeiro.", ephemeral: true });
  }

  await ensureStaffState(interaction.guild, interaction.channel);
  const profile = getStaffProfile(interaction.guildId, order.assignedAdminId);
  if (!profile?.pixKey) {
    return interaction.reply({ content: "O ADM responsável não tem Pix configurado mais.", ephemeral: true });
  }

  const panel = getOrderPanel(order, actionGuildId(interaction));
  await interaction.channel.send({ embeds: [buildPixEmbed(order, panel, profile)] });
  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return interaction.reply({ content: "Pix reenviado.", ephemeral: true });
}
async function handleStaffButton(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode mexer nesse painel.", ephemeral: true });
  }
  await ensureStaffState(interaction.guild, interaction.channel);

  const [, action] = interaction.customId.split(":");

  if (action === "config") {
    return interaction.showModal(pixConfigModal(interaction.guildId, interaction.user));
  }

  if (action === "on") {
    const profile = getStaffProfile(interaction.guildId, interaction.user.id);
    if (!profile?.pixKey) {
      return interaction.reply({ content: "Configure seu Pix antes de ficar ON.", ephemeral: true });
    }

    saveStaffProfile(interaction.guildId, interaction.user.id, { online: true });
    await refreshStaffPanel(interaction.guildId);
    await saveStaffBackup(interaction.guild, interaction.channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));
    return interaction.reply({ content: "Você está ON para receber vendas.", ephemeral: true });
  }

  if (action === "off") {
    saveStaffProfile(interaction.guildId, interaction.user.id, { online: false });
    await refreshStaffPanel(interaction.guildId);
    await saveStaffBackup(interaction.guild, interaction.channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));
    return interaction.reply({ content: "Você está OFF.", ephemeral: true });
  }

  if (action === "refresh") {
    await refreshStaffPanel(interaction.guildId);
    await saveStaffBackup(interaction.guild, interaction.channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));
    return interaction.reply({ content: "Painel atualizado.", ephemeral: true });
  }
}
async function handlePixModal(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode configurar Pix.", ephemeral: true });
  }
  await ensureStaffState(interaction.guild, interaction.channel);

  const displayName = interaction.fields.getTextInputValue("displayName").trim();
  const pixKey = interaction.fields.getTextInputValue("pixKey").trim();
  const qrCodeUrl = interaction.fields.getTextInputValue("qrCodeUrl").trim();
  const note = interaction.fields.getTextInputValue("note").trim();

  if (qrCodeUrl && !validUrl(qrCodeUrl)) {
    return interaction.reply({ content: "Link de QR Code inválido. Use http/https ou deixe vazio.", ephemeral: true });
  }

  saveStaffProfile(interaction.guildId, interaction.user.id, {
    displayName,
    pixKey,
    qrCodeUrl,
    note,
    online: false
  });
  await flushPersistentFile(STAFF_FILE).catch(error => {
    console.log(`Nao consegui confirmar Pix no KV agora: ${error.message}`);
  });

  await refreshStaffPanel(interaction.guildId);
  await saveStaffBackup(interaction.guild, interaction.channel).catch(error => {
    console.log(`Nao consegui salvar backup do Pix: ${error.message}`);
  });

  return interaction.reply({ content: "Pix salvo. Agora clique em **Ficar ON** no painel quando estiver disponível.", ephemeral: true });
}
function defaultPanel(guildId, scopeId = "default") {
  return {
    id: scopeId === "default" ? "main" : `panel_${scopeId}`,
    guildId,
    scopeId,
    channelId: "",
    publishedChannelId: "",
    publishedMessageId: "",
    configMessageChannelId: "",
    configMessageId: "",
    title: "🐉 Dragon Store",
    color: "#9b00ff",
    imageUrl: "",
    thumbnailUrl: "",
    quickOrder: defaultQuickOrder(),
    description: `🛒 **Loja em configuracao**\n\nAdicione produtos, imagem, cor e canal pelo configurador.\n\nQuando tudo estiver pronto, clique em **Publicar painel** para enviar ou atualizar a mensagem da loja.`,
    products: [],
    updatedAt: new Date().toISOString()
  };
}
function pixReward(name, chance, amount) {
  return {
    name,
    description: `Pix de ${money(amount)}`,
    weight: chance,
    chance,
    type: "pix",
    pixMin: amount,
    pixMax: amount
  };
}
function completePixRewardChances(rewards) {
  const list = rewards.map(reward => ({ ...reward }));
  const total = list.reduce((sum, reward) => sum + rewardChanceValue(reward), 0);
  if (total <= 0 || total >= 100) return list;

  const candidate = list
    .map((reward, index) => ({ reward, index, range: pixRewardRange(reward) }))
    .filter(item => isPixReward(item.reward))
    .sort((a, b) => a.range.max - b.range.max || a.index - b.index)[0];
  const targetIndex = candidate?.index ?? 0;
  const missing = 100 - total;
  const current = rewardChanceValue(list[targetIndex]);

  list[targetIndex].chance = Number((current + missing).toFixed(5));
  list[targetIndex].weight = list[targetIndex].chance;
  return list;
}
function pixBoxPresetRewards() {
  return completePixRewardChances([
    pixReward("5 centavos", 20, 0.05),
    pixReward("10 centavos", 8, 0.10),
    pixReward("20 centavos", 5, 0.20),
    pixReward("1 real", 2, 1),
    pixReward("10 reais", 0.5, 10),
    pixReward("100 reais", 0.01, 100),
    pixReward("1000 reais", 0.00001, 1000)
  ]);
}
const PRODUCT_PRESETS = {
  empty: {
    label: "Vazio",
    title: "🐉 Dragon Store",
    color: "#9b00ff",
    description:
      "🛒 **Loja em configuracao**\n\nAdicione produtos, imagem, cor e canal pelo configurador.\n\nQuando tudo estiver pronto, clique em **Publicar painel** para enviar ou atualizar a mensagem da loja.",
    productDescription: "Produto da loja.",
    items: []
  },
  pixbox: {
    label: "Caixa Pix",
    title: "Caixa Pix",
    color: "#28f6a1",
    description:
      "🎁 **Caixa Pix**\n\nCompre sua caixa e receba um valor Pix aleatorio ao finalizar a compra.",
    productDescription: "Caixa Pix com sorteio automatico ao finalizar a compra.",
    items: [{
      name: "Caixa Pix",
      price: "R$ 0,20",
      description: "Caixa Pix com sorteio automatico ao finalizar a compra.",
      stock: "infinito",
      type: "mystery_box",
      rewards: pixBoxPresetRewards()
    }]
  },
  tft: {
    label: "TFT Sets",
    title: "Frosted TFT",
    color: "#22c7ff",
    description:
      "🛒 **Sets TFT prontos para compra**\n\nSelecione um set no menu abaixo para abrir um carrinho privado com a equipe.\n\nDepois informe seu nick e o set desejado no carrinho para agilizar o atendimento.",
    productDescription: "Set TFT com entrega combinada no carrinho.",
    items: [
      ["Set Party Balloons", "R$ 18,90"],
      ["Set Lovesick", "R$ 11,80"],
      ["Set Spooky Brew", "R$ 9,40"],
      ["Set Pumpkin Slice", "R$ 8,90"],
      ["Set Gothic Bouquet", "R$ 8,40"],
      ["Set Dragon Puppet", "R$ 3,80"],
      ["Set Lovely Heart", "R$ 3,40"],
      ["Set Cherry Blossom", "R$ 4,90"],
      ["Set Icecream Mix", "R$ 4,90"],
      ["Set Bleak Ink", "R$ 6,90"],
      ["Set Batwing", "R$ 4,40"],
      ["Set Classic", "R$ 5,90"],
      ["Set Psycho", "R$ 4,50"],
      ["Set Dark Bone", "R$ 4,50"],
      ["Set Hollow Scythe", "R$ 2,00"],
      ["Set Bleeding Heart", "R$ 2,00"],
      ["Qualquer Hunter (2 por 1)", "R$ 2,00"],
      ["Sets da descrição", "R$ 2,00"],
      ["Set Devilish", "R$ 9,40"],
      ["Set Lion Dance", "R$ 3,50"],
      ["Set Devilborn", "R$ 3,90"],
      ["Set Pegasus Blade", "R$ 3,48"]
    ]
  },
  steam: {
    label: "Steam Keys",
    title: "Steam Keys",
    color: "#5865f2",
    description:
      "🎮 **Steam Keys digitais**\n\nEscolha uma opção no menu abaixo para abrir um carrinho privado. O atendimento e a entrega são feitos pela equipe.",
    productDescription: "Steam key digital com entrega manual no carrinho.",
    items: [
      ["Steam Key Black Premium", "R$ 3,99"],
      ["Steam Key Ruby", "R$ 2,69"],
      ["3x Steam Keys Aleatórias", "R$ 2,00"]
    ]
  },
  smm: {
    label: "SMM",
    title: "Serviços SMM",
    color: "#19c37d",
    description:
      "📈 **Serviços para redes sociais**\n\nSelecione o serviço desejado no menu abaixo para abrir um carrinho privado com a equipe.",
    productDescription: "Serviço SMM com detalhes combinados no carrinho.",
    items: [
      ["1.000 Seguidores (Sem Garantia)", "R$ 2,00"],
      ["5.000 Seguidores (Sem Garantia)", "R$ 7,50"],
      ["10.000 Seguidores (Sem Garantia)", "R$ 14,00"],
      ["1.000 Curtidas Mundiais", "R$ 2,00"],
      ["5.000 Curtidas Mundiais", "R$ 3,00"],
      ["10.000 Curtidas Mundiais", "R$ 5,50"],
      ["1.000 Curtidas Brasileiras", "R$ 4,00"],
      ["5.000 Curtidas Brasileiras", "R$ 18,00"],
      ["10.000 Curtidas Brasileiras", "R$ 35,00"],
      ["1.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 4,90"],
      ["5.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 22,50"],
      ["10.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 43,90"],
      ["1.000 Seguidores Brasileiros", "R$ 8,90"],
      ["10.000 Visualizações", "R$ 2,00"],
      ["50.000 Visualizações", "R$ 2,50"],
      ["100.000 Visualizações", "R$ 4,00"]
    ]
  }
};
function defaultQuickOrder() {
  return {
    title: "Compre aqui",
    description:
      "🛒 **ESCOLHA UMA DAS OPÇÕES PARA SER ATENDIDO!**\n\n• **Comprar:** Compre sets e robux com o suporte da nossa equipe.\n• **Automático:** Compre sets e receba rápido via sistema automático.\n• **Combos:** Compre x-all, combos e sets via sistema automático.",
    buttonLabel: "Comprar",
    question1: "Nick no roblox",
    question2: "Nome do Set que você deseja comprar",
    publishedChannelId: "",
    publishedMessageId: ""
  };
}
function productsFromPreset(preset) {
  return preset.items.map(item => {
    if (Array.isArray(item)) {
      const [name, price] = item;
      return {
        id: "p" + random7(),
        name,
        price,
        description: preset.productDescription,
        stock: "infinito",
        imageUrl: ""
      };
    }

    return {
      id: "p" + random7(),
      name: item.name || "Produto",
      price: item.price || "R$ 0,00",
      description: item.description || preset.productDescription || "Produto da loja",
      stock: item.stock || "infinito",
      imageUrl: item.imageUrl || "",
      type: item.type || "product",
      rewards: Array.isArray(item.rewards) ? item.rewards : undefined
    };
  });
}
function applyProductPreset(panel, presetKey) {
  const preset = PRODUCT_PRESETS[presetKey];
  if (!preset) return false;

  panel.title = preset.title;
  panel.color = preset.color;
  panel.description = preset.description;
  panel.products = productsFromPreset(preset);
  const oldQuick = quickOrderConfig(panel);
  panel.quickOrder = {
    ...oldQuick,
    title: presetKey === "tft" ? "Compre aqui" : oldQuick.title,
    description: presetKey === "tft"
      ? "🛒 **ESCOLHA UMA DAS OPÇÕES PARA SER ATENDIDO!**\n\n• **Comprar:** Compre sets e robux com o suporte da nossa equipe.\n• **Automático:** Compre sets e receba rápido via sistema automático.\n• **Combos:** Compre x-all, combos e sets via sistema automático."
      : oldQuick.description,
    buttonLabel: oldQuick.buttonLabel,
    question1: oldQuick.question1,
    question2: oldQuick.question2
  };

  return true;
}
function ensurePanelStore(store, guildId) {
  if (!store.guilds[guildId]) store.guilds[guildId] = {};
  const guildStore = store.guilds[guildId];

  if (!guildStore.panels) guildStore.panels = {};

  if (guildStore.panel && !Object.keys(guildStore.panels).length) {
    const legacyScopeId = guildStore.panel.scopeId || guildStore.panel.configMessageChannelId || "default";
    guildStore.panel.scopeId = legacyScopeId;
    if (!guildStore.panel.id) guildStore.panel.id = legacyScopeId === "default" ? "main" : `panel_${legacyScopeId}`;
    guildStore.panels[legacyScopeId] = guildStore.panel;
  }

  return guildStore;
}
function getPanel(guildId, scopeId = "default") {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const key = String(scopeId || "default");

  if (!guildStore.panels[key]) {
    guildStore.panels[key] = defaultPanel(guildId, key);
    writePanels(store);
  }

  return guildStore.panels[key];
}
function savePanel(guildId, panel, scopeId = null) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const key = String(scopeId || panel.scopeId || panel.configMessageChannelId || "default");
  panel.scopeId = key;
  if (!panel.id) panel.id = key === "default" ? "main" : `panel_${key}`;
  panel.updatedAt = new Date().toISOString();
  guildStore.panels[key] = panel;
  if (key === "default") guildStore.panel = panel;
  writePanels(store);
}
function getPanelById(guildId, panelId) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const panels = Object.values(guildStore.panels || {});
  const found = panels.find(panel => panel.id === panelId);

  if (!found && guildStore.panel?.id === panelId) return guildStore.panel;
  return found || null;
}
function allPublicPanels(guildStore) {
  const seen = new Set();
  const panels = [];
  const add = panel => {
    if (!panel) return;
    const key = panel.id || panel.scopeId || panel.configMessageId || panels.length;
    if (seen.has(key)) return;
    seen.add(key);
    panels.push(panel);
  };

  Object.values(guildStore?.panels || {}).forEach(add);
  add(guildStore?.panel);
  return panels;
}
function pickPublicPanel(guildStore) {
  const panels = allPublicPanels(guildStore);
  const preferredScope = process.env.PUBLIC_STORE_PANEL_SCOPE?.trim();
  if (preferredScope && guildStore?.panels?.[preferredScope]) return guildStore.panels[preferredScope];

  return panels.find(panel => panel?.publishedMessageId && (panel.products || []).length) ||
    panels.find(panel => (panel.products || []).length) ||
    panels[0] ||
    defaultPanel(process.env.GUILD_ID || "public-store");
}
function publicStoreProduct(p, panel, idPrefix = "") {
  const rawId = String(p.id || `p${random7()}`);
  return {
    id: idPrefix ? `${idPrefix}_${rawId}` : rawId,
    name: String(p.name || "Produto"),
    price: String(p.price || "A combinar"),
    description: String(p.description || "Produto digital da Dragon Store"),
    stock: String(p.stock || "infinito"),
    imageUrl: p.imageUrl || panel.imageUrl || "",
    type: p.type || "normal"
  };
}
function publicProductKey(product) {
  const name = String(product.name || "").trim().toLowerCase();
  const price = String(product.price || "").trim().toLowerCase();
  return name || price ? `${name}|${price}` : String(product.id || "");
}
function publicProductsFromPanels(guildStore, preferredPanel) {
  const panels = [
    preferredPanel,
    ...allPublicPanels(guildStore).sort((a, b) => {
      const aCount = (a.products || []).length;
      const bCount = (b.products || []).length;
      return bCount - aCount;
    })
  ];
  const seen = new Set();
  const products = [];

  for (const panel of panels) {
    for (const p of panel?.products || []) {
      const publicProduct = publicStoreProduct(p, panel);
      const key = publicProductKey(publicProduct);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push(publicProduct);
    }
  }

  return products.slice(0, 200);
}
function publicCategoryId(panel, index = 0) {
  return safeName(panel?.scopeId || panel?.id || panel?.title || `categoria-${index + 1}`) || `categoria-${index + 1}`;
}
function publicCategoryMinPrice(products) {
  let min = null;
  for (const product of products || []) {
    const value = parsePrice(product.price);
    if (value === null) continue;
    min = min === null ? value : Math.min(min, value);
  }
  return min;
}
function publicCategoryFromPanel(panel, index = 0) {
  const id = publicCategoryId(panel, index);
  const products = (panel.products || [])
    .map(product => publicStoreProduct(product, panel, id))
    .slice(0, 100);

  return {
    id,
    panelId: String(panel.id || ""),
    scopeId: String(panel.scopeId || ""),
    title: String(panel.title || `Categoria ${index + 1}`),
    description: String(panel.description || "Produtos digitais da Dragon Store"),
    imageUrl: panel.imageUrl || products.find(product => product.imageUrl)?.imageUrl || "",
    thumbnailUrl: panel.thumbnailUrl || "",
    color: normColor(panel.color || "#9b00ff"),
    minPrice: publicCategoryMinPrice(products),
    products
  };
}
function publicCategoriesFromPanels(guildStore, preferredPanel) {
  const seen = new Set();
  const panels = [
    preferredPanel,
    ...allPublicPanels(guildStore).sort((a, b) => {
      const aCount = (a.products || []).length;
      const bCount = (b.products || []).length;
      return bCount - aCount;
    })
  ];

  return panels
    .filter(Boolean)
    .filter(panel => (panel.products || []).length)
    .filter((panel, index) => {
      const key = panel.id || panel.scopeId || panel.configMessageId || `${panel.title || "panel"}-${index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((panel, index) => publicCategoryFromPanel(panel, index))
    .slice(0, 50);
}
async function recoverPublicPanelsFromDiscord(guildId, guildStore) {
  if (!client.isReady?.()) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const configuredChannelId = process.env.PUBLIC_STORE_CHANNEL_ID?.trim();
  const configuredMessageId = process.env.PUBLIC_STORE_MESSAGE_ID?.trim();

  if (configuredChannelId && configuredMessageId) {
    const channel = await guild.channels.fetch(configuredChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(configuredMessageId).catch(() => null);
      if (message) await recoverPanelFromPublishedMessage(message, guildId, configuredChannelId).catch(() => null);
    }
  }

  for (const panel of allPublicPanels(guildStore)) {
    if (!panel?.publishedChannelId || !panel?.publishedMessageId) continue;
    if ((panel.products || []).length && process.env.PUBLIC_STORE_RECOVER_ON_REQUEST !== "true") continue;

    const channel = await guild.channels.fetch(panel.publishedChannelId).catch(() => null);
    if (!channel?.isTextBased()) continue;
    const message = await channel.messages.fetch(panel.publishedMessageId).catch(() => null);
    if (message) await recoverPanelFromPublishedMessage(message, guildId, panel.scopeId || panel.publishedChannelId).catch(() => null);
  }

  if (configuredChannelId && !configuredMessageId) {
    const channel = await guild.channels.fetch(configuredChannelId).catch(() => null);
    if (channel?.isTextBased()) await findRecoverableSalePanels(channel, guildId, null).catch(() => []);
  }

  const savedProducts = publicProductsFromPanels(guildStore, pickPublicPanel(guildStore));
  const shouldScanAll = process.env.PUBLIC_STORE_SCAN_CHANNELS !== "false" ||
    process.env.PUBLIC_STORE_RECOVER_ON_REQUEST === "true" ||
    !savedProducts.length;

  if (shouldScanAll) {
    await scanGuildForPublishedSalePanels(guild, guildId, !savedProducts.length || process.env.PUBLIC_STORE_RECOVER_ON_REQUEST === "true").catch(error => {
      console.log("Nao consegui varrer paineis publicados:", error.message);
      return [];
    });
  }
}
async function publicStorePayload() {
  const store = readPanels();
  const configuredGuildId = process.env.PUBLIC_STORE_GUILD_ID?.trim() || process.env.GUILD_ID?.trim();
  const guildId = configuredGuildId || Object.keys(store.guilds || {})[0] || "public-store";
  let guildStore = store.guilds?.[guildId] || Object.values(store.guilds || {})[0] || { panels: {} };
  let panel = pickPublicPanel(guildStore);
  let categories = publicCategoriesFromPanels(guildStore, panel);
  let products = categories.length
    ? categories.flatMap(category => category.products).slice(0, 200)
    : publicProductsFromPanels(guildStore, panel);

  if (!products.length || process.env.PUBLIC_STORE_RECOVER_ON_REQUEST === "true" || process.env.PUBLIC_STORE_SCAN_CHANNELS !== "false") {
    await recoverPublicPanelsFromDiscord(guildId, guildStore);
    const freshStore = readPanels();
    guildStore = freshStore.guilds?.[guildId] || Object.values(freshStore.guilds || {})[0] || guildStore;
    panel = pickPublicPanel(guildStore);
    categories = publicCategoriesFromPanels(guildStore, panel);
    products = categories.length
      ? categories.flatMap(category => category.products).slice(0, 200)
      : publicProductsFromPanels(guildStore, panel);
  }

  return {
    storeName: process.env.PUBLIC_STORE_NAME?.trim() || "Dragon Store",
    title: panel.title || "Dragon Store",
    description: panel.description || "Produtos digitais com compra rapida pelo Discord.",
    imageUrl: panel.imageUrl || "",
    thumbnailUrl: panel.thumbnailUrl || "",
    color: normColor(panel.color || "#9b00ff"),
    discordInviteUrl: publicDiscordInviteUrl(process.env.DISCORD_INVITE_URL),
    ticketChannelId: config.ticketPanel?.channelId || "",
    categories,
    products,
    updatedAt: panel.updatedAt || new Date().toISOString()
  };
}
function sendHttpJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.PUBLIC_STORE_CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
  res.end(JSON.stringify(payload));
}
async function handleHttpRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.PUBLIC_STORE_CORS_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/public-store") {
    const expectedToken = process.env.PUBLIC_STORE_API_TOKEN?.trim();
    const auth = String(req.headers.authorization || "");

    if (!expectedToken) {
      return sendHttpJson(res, 503, { error: "PUBLIC_STORE_API_TOKEN nao configurado no bot." });
    }
    if (auth !== `Bearer ${expectedToken}`) {
      return sendHttpJson(res, 401, { error: "Nao autorizado." });
    }

    try {
      return sendHttpJson(res, 200, await publicStorePayload());
    } catch (error) {
      console.error("Erro na API publica da loja:", error?.message || error);
      return sendHttpJson(res, 500, { error: "Nao foi possivel carregar a loja." });
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Bot online");
}
function getOrderPanel(order, guildId) {
  return (order?.panelId && getPanelById(guildId, order.panelId)) ||
    getPanel(guildId, order?.panelScopeId || order?.scopeId || "default");
}
function findOrderInChannel(db, context, openOnly = true) {
  const guildId = actionGuildId(context);
  const channelId = context?.channel?.id || context?.channelId;
  if (!guildId || !channelId) return null;

  return Object.values(db.orders || {}).find(order =>
    order.guildId === guildId &&
    order.channelId === channelId &&
    (!openOnly || order.status === "open")
  ) || null;
}
function orderForAction(db, id, context, openOnly = true) {
  const order = db.orders?.[id];
  if (order && (!openOnly || order.status === "open")) return order;
  return findOrderInChannel(db, context, openOnly) || order || null;
}
function product(panel, id) { return (panel.products || []).find(p => p.id === id); }
function normalizeProductInput({ name, price, description, stock, imageUrl }) {
  const cleanImage = clampText(imageUrl, 500);
  return {
    name: clampText(name, 100, "Produto"),
    price: clampText(price, 50, "R$ 0,00"),
    description: clampText(description, 200, "Produto da loja"),
    stock: clampText(stock, 50, "infinito") || "infinito",
    imageUrl: cleanImage
  };
}
function orderItemFromProduct(p) {
  return {
    productId: p.id,
    quantity: 1,
    name: p.name,
    price: p.price,
    description: p.description || "",
    stock: p.stock || "infinito",
    type: p.type || "product",
    imageUrl: p.imageUrl || "",
    rewards: Array.isArray(p.rewards) ? p.rewards : undefined
  };
}
function orderItemDetails(item, panel) {
  const current = product(panel, item.productId);
  return {
    productId: item.productId,
    name: item.name || current?.name || "Produto removido",
    price: item.price || current?.price || "valor indisponível",
    description: item.description || current?.description || "",
    stock: item.stock || current?.stock || "infinito",
    type: item.type || current?.type || "product",
    imageUrl: item.imageUrl || current?.imageUrl || "",
    rewards: Array.isArray(item.rewards) ? item.rewards : current?.rewards
  };
}
function orderTotals(order, panel) {
  const summary = (order.items || []).reduce((currentSummary, item) => {
    const details = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unit = parsePrice(details.price);

    currentSummary.quantity += quantity;
    if (unit === null) currentSummary.unknown += quantity;
    else currentSummary.grossAmount += unit * quantity;

    return currentSummary;
  }, { amount: 0, grossAmount: 0, discountAmount: 0, discountPercent: 0, quantity: 0, unknown: 0 });

  const discounted = applyOrderDiscount(summary.grossAmount, order);
  summary.grossAmount = roundCurrency(summary.grossAmount);
  summary.amount = discounted.amount;
  summary.discountAmount = discounted.discountAmount;
  summary.discountPercent = discounted.discountPercent;
  return summary;
}
function legacyTotalLine(order, panel) {
  const totals = orderTotals(order, panel);
  if (!totals.quantity) return "Carrinho vazio";
  if (totals.unknown) return `${money(totals.amount)} + itens sem preço numérico`;
  return money(totals.amount);
}
function totalLine(order, panel) {
  const totals = orderTotals(order, panel);
  if (!totals.quantity) return "Carrinho vazio";
  const base = totals.discountAmount > 0
    ? `${money(totals.amount)} (${totals.discountPercent}% OFF, de ${money(totals.grossAmount)})`
    : money(totals.amount);
  if (totals.unknown) return `${base} + itens sem preco numerico`;
  return base;
}
function discountLine(order) {
  const percent = orderDiscountPercent(order);
  if (percent <= 0) return "";
  return `${order.discount?.label || "Desconto aplicado"}: **${percent}% OFF**`;
}
function closedCartDeleteSeconds() {
  const configured = Number(process.env.CLOSED_CART_DELETE_SECONDS ?? config.settings?.deleteClosedCartAfterSeconds ?? 3 * 24 * 60 * 60);
  return Number.isFinite(configured) && configured >= 0 ? configured : 3 * 24 * 60 * 60;
}
function isFinishedCart(order) {
  return ["closed", "cancelled", "canceled"].includes(String(order?.status || ""));
}
async function deleteClosedCartChannel(order) {
  if (!order?.guildId || !order?.channelId || !isFinishedCart(order)) return;

  try {
    const guild = await client.guilds.fetch(order.guildId);
    const channel = await guild.channels.fetch(order.channelId).catch(() => null);
    if (channel?.deletable) await channel.delete(`Carrinho ${order.id} encerrado ha 3 dias`);
  } catch (error) {
    console.log(`Nao consegui apagar carrinho ${order.id}: ${error.message}`);
  } finally {
    cartDeleteTimers.delete(order.id);
  }
}
function scheduleCartDeletion(order) {
  if (!order?.id || !order.channelId || !isFinishedCart(order)) return false;
  if (cartDeleteTimers.has(order.id)) clearTimeout(cartDeleteTimers.get(order.id));

  const seconds = closedCartDeleteSeconds();
  const closedAt = Date.parse(order.closedAt || order.cancelledAt || new Date().toISOString());
  const dueAt = Number.isFinite(closedAt) ? closedAt + seconds * 1000 : Date.now() + seconds * 1000;
  const delay = Math.max(1000, dueAt - Date.now());
  const cappedDelay = Math.min(delay, 2_147_483_647);

  cartDeleteTimers.set(order.id, setTimeout(() => deleteClosedCartChannel(order), cappedDelay));
  return true;
}
function scheduleExistingClosedCarts() {
  const db = readOrders();
  Object.values(db.orders || {}).forEach(scheduleCartDeletion);
}
function maskCustomerName(value) {
  const clean = String(value || "cliente").replace(/\s+/g, "");
  return `${clean.slice(0, 4) || "clie"}****`;
}
function successFeedTime(date = new Date()) {
  return date.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
function successOrderLine(order, panel) {
  const lines = (order.items || []).map(item => {
    const details = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    return `${details.name} ${quantity}x`;
  });
  return lines.join(", ") || "Pedido personalizado 1x";
}
function completionChannelId() {
  return String(process.env.COMPLETION_CHANNEL_ID || config.completion?.channelId || DEFAULT_COMPLETION_CHANNEL_ID).trim();
}
function completionFeedEnabled() {
  return config.completion?.enabled !== false && process.env.COMPLETION_FEED_ENABLED !== "false";
}
function cancellationChannelId() {
  return String(process.env.CANCELLATION_CHANNEL_ID || config.cancellation?.channelId || DEFAULT_CANCELLATION_CHANNEL_ID).trim();
}
function cancellationFeedEnabled() {
  return config.cancellation?.enabled !== false && process.env.CANCELLATION_FEED_ENABLED !== "false";
}
function adminCallCooldownSeconds() {
  const configured = Number(process.env.ADMIN_CALL_COOLDOWN_SECONDS ?? config.settings?.adminCallCooldownSeconds ?? 20);
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}
function adminCallCooldownRemaining(record) {
  const last = Date.parse(record?.lastAdminCallAt || "");
  if (!Number.isFinite(last)) return 0;
  const remaining = Math.ceil((last + adminCallCooldownSeconds() * 1000 - Date.now()) / 1000);
  return Math.max(0, remaining);
}
function configuredCustomerRoleId(guildId) {
  return configuredCustomerRoleIds(guildId)[0] || "";
}
function configuredCustomerRoleIds(guildId) {
  const staff = getStaffGuild(guildId);
  return [
    staff.customerRoleId,
    process.env.CUSTOMER_ROLE_ID,
    config.customerRoleId,
    DEFAULT_CUSTOMER_ROLE_ID
  ].map(value => String(value || "").trim()).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index);
}
async function grantCustomerRole(guild, userId) {
  const roleIds = configuredCustomerRoleIds(guild.id);
  if (!roleIds.length) return false;

  let granted = false;
  try {
    const member = await guild.members.fetch(userId);
    for (const roleId of roleIds) {
      try {
        await member.roles.add(roleId, "Compra finalizada na Dragon Store");
        granted = true;
      } catch (error) {
        console.log(`Nao consegui adicionar cargo ${roleId} para ${userId}: ${error.message}`);
      }
    }
    return granted;
  } catch (error) {
    console.log(`Nao consegui buscar membro para cargo cliente ${userId}: ${error.message}`);
    return false;
  }
}
async function sendSuccessFeed(guild, order, panel) {
  const staff = getStaffGuild(guild.id);
  if (!staff.successMessageEnabled || !staff.successChannelId) return false;
  if (staff.successChannelId === completionChannelId()) return false;

  const channel = await guild.channels.fetch(staff.successChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const embed = new EmbedBuilder()
    .setTitle("Produto entregue!")
    .setDescription(`${maskCustomerName(order.username)} - ${successOrderLine(order, panel)}\n${successFeedTime(new Date(order.closedAt || Date.now()))}`)
    .setColor(parseColor(panel.color, 0x28f6a1))
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  return true;
}
async function sendCompletionReceipt(guild, order, panel) {
  if (!completionFeedEnabled()) return false;

  const channelId = completionChannelId();
  if (!channelId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const products = successOrderLine(order, panel);
  const embed = new EmbedBuilder()
    .setTitle("Compra finalizada!")
    .setDescription(`<@${order.userId}> comprou: **${products}**`)
    .setColor(parseColor(panel.color, 0x28f6a1))
    .addFields(
      { name: "Cliente", value: `<@${order.userId}>`, inline: true },
      { name: "Pedido", value: `#${order.id}`, inline: true },
      { name: "Produtos", value: products.slice(0, 1024), inline: false }
    )
    .setTimestamp(new Date(order.closedAt || Date.now()));

  await channel.send({
    content: `Compra finalizada! <@${order.userId}> - ${products}`,
    embeds: [embed],
    allowedMentions: { users: [order.userId] }
  });
  return true;
}
async function sendCancellationNotice(guild, order, panel, actor) {
  if (!cancellationFeedEnabled()) return false;
  if (actor?.id && actor.id !== order.userId && config.cancellation?.notifyAdminCancels !== true) return false;

  const channelId = cancellationChannelId();
  if (!channelId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const products = successOrderLine(order, panel);
  const embed = new EmbedBuilder()
    .setTitle("Compra cancelada")
    .setDescription(`<@${order.userId}> cancelou a compra.`)
    .setColor(0xff5c7a)
    .addFields(
      { name: "Cliente", value: `<@${order.userId}>`, inline: true },
      { name: "Pedido", value: `#${order.id}`, inline: true },
      { name: "Produtos", value: products.slice(0, 1024), inline: false }
    )
    .setTimestamp(new Date(order.cancelledAt || Date.now()));

  await channel.send({
    content: `<@${order.userId}> compra cancelada.`,
    embeds: [embed],
    allowedMentions: { users: [order.userId] }
  });
  return true;
}
async function setupSuccessFeed(interactionOrMessage, options = {}) {
  const guild = interactionOrMessage.guild;
  const channel = interactionOrMessage.channel;
  const member = interactionOrMessage.member;

  if (!isAdmin(member)) {
    const text = "So ADM pode configurar o canal de vendas concluidas.";
    if (interactionOrMessage.isRepliable?.()) return interactionOrMessage.reply({ content: text, ephemeral: true });
    return channel.send(text);
  }

  const staff = getStaffGuild(guild.id);
  staff.successChannelId = channel.id;
  staff.successMessageEnabled = options.enabled ?? true;
  if (options.customerRoleId) staff.customerRoleId = options.customerRoleId;
  saveStaffGuild(guild.id, staff);
  await saveStaffBackup(guild, channel).catch(error => {
    console.log(`Nao consegui salvar backup do atendimento: ${error.message}`);
  });

  const effectiveRoleId = staff.customerRoleId || configuredCustomerRoleId(guild.id);
  const roleText = effectiveRoleId ? `<@&${effectiveRoleId}>` : "`CUSTOMER_ROLE_ID`/cargo cliente ainda nao definido";
  const statusText = staff.successMessageEnabled ? "ativado" : "desativado";
  const embed = new EmbedBuilder()
    .setTitle("Feed de vendas configurado")
    .setDescription(`Este canal vai receber as vendas concluidas com nome mascarado.\n\nStatus: **${statusText}**\nCargo cliente: ${roleText}\nLimpeza de carrinhos: **3 dias apos encerrar**.`)
    .setColor(0x28f6a1)
    .setTimestamp();

  if (interactionOrMessage.isRepliable?.()) {
    return interactionOrMessage.reply({ embeds: [embed], ephemeral: true });
  }
  return channel.send({ embeds: [embed] });
}
function saoPauloDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || "01";
  return { year: part("year"), month: part("month"), day: part("day") };
}
function isoWeekKeyFromParts(parts) {
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((local - yearStart) / 86400000) + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function periodKeys(date = new Date()) {
  const parts = saoPauloDateParts(date);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    week: isoWeekKeyFromParts(parts),
    month: `${parts.year}-${parts.month}`,
    year: parts.year
  };
}
function emptyCustomerStats(userId, username) {
  return {
    userId,
    username: username || "cliente",
    totalSpent: 0,
    orderCount: 0,
    periods: { day: {}, week: {}, month: {}, year: {} },
    lastOrderAt: ""
  };
}
function recordPeriodSpend(stats, period, key, amount, ordersDelta = 1) {
  if (!stats.periods) stats.periods = { day: {}, week: {}, month: {}, year: {} };
  if (!stats.periods[period]) stats.periods[period] = {};
  const bucket = stats.periods[period][key] || { amount: 0, orders: 0 };
  bucket.amount = roundCurrency(Math.max(0, (Number(bucket.amount) || 0) + amount));
  bucket.orders = Math.max(0, (Number(bucket.orders) || 0) + ordersDelta);
  stats.periods[period][key] = bucket;
}
function emptySellerStats(userId, username) {
  return {
    userId,
    username: username || "vendedor",
    totalSold: 0,
    orderCount: 0,
    totalItems: 0,
    periods: { day: {}, week: {}, month: {}, year: {} },
    lastSaleAt: ""
  };
}
function recordSellerSpend(db, order, totals, now, keys) {
  if (order.sellerRecordedAt || !order.closedByAdminId || totals.amount <= 0) return;
  const guildId = order.guildId || "default";
  if (!db.sellers[guildId]) db.sellers[guildId] = {};
  const seller = db.sellers[guildId][order.closedByAdminId] || emptySellerStats(order.closedByAdminId, order.closedByAdminName);

  seller.username = order.closedByAdminName || seller.username;
  seller.totalSold = roundCurrency((Number(seller.totalSold) || 0) + totals.amount);
  seller.orderCount = (Number(seller.orderCount) || 0) + 1;
  seller.totalItems = (Number(seller.totalItems) || 0) + totals.quantity;
  seller.lastSaleAt = now.toISOString();
  for (const [period, key] of Object.entries(keys)) recordPeriodSpend(seller, period, key, totals.amount, 1);

  db.sellers[guildId][order.closedByAdminId] = seller;
  order.sellerRecordedAt = now.toISOString();
}
function recordCustomerSpend(db, order, panel) {
  if (order.spendRecordedAt) return;
  const totals = orderTotals(order, panel);
  order.spentAmount = totals.amount;
  order.grossAmount = totals.grossAmount;
  order.discountAmount = totals.discountAmount;
  order.discountPercent = totals.discountPercent;
  order.totalQuantity = totals.quantity;
  if (!order.userId || totals.amount <= 0) return;

  const guildId = order.guildId || "default";
  if (!db.customers[guildId]) db.customers[guildId] = {};
  const customer = db.customers[guildId][order.userId] || emptyCustomerStats(order.userId, order.username);
  const now = new Date(order.closedAt || Date.now());
  const keys = periodKeys(now);

  customer.username = order.username || customer.username;
  customer.totalSpent = roundCurrency((Number(customer.totalSpent) || 0) + totals.amount);
  customer.orderCount += 1;
  customer.lastOrderAt = now.toISOString();
  for (const [period, key] of Object.entries(keys)) recordPeriodSpend(customer, period, key, totals.amount, 1);

  db.customers[guildId][order.userId] = customer;
  recordSellerSpend(db, order, totals, now, keys);
  order.spendRecordedAt = now.toISOString();
}
const RANKING_PERIODS = {
  day: "Dia",
  week: "Semana",
  month: "Mes",
  year: "Ano"
};
function customerPeriodAmount(customer, period, key) {
  return Number(customer?.periods?.[period]?.[key]?.amount || 0);
}
function rankingData(guildId, period = "month", page = 0) {
  const db = readOrders();
  const key = periodKeys()[period] || periodKeys().month;
  const rows = Object.values(db.customers?.[guildId] || {})
    .map(customer => ({ ...customer, periodAmount: customerPeriodAmount(customer, period, key) }))
    .filter(customer => customer.periodAmount > 0)
    .sort((a, b) => b.periodAmount - a.periodAmount || String(a.username).localeCompare(String(b.username)));
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  return { rows, pageRows: rows.slice(safePage * pageSize, safePage * pageSize + pageSize), page: safePage, totalPages, key };
}
function rankingEmbed(guildId, period = "month", page = 0) {
  const selectedPeriod = RANKING_PERIODS[period] ? period : "month";
  const data = rankingData(guildId, selectedPeriod, page);
  const lines = data.pageRows.length
    ? data.pageRows.map((customer, index) => {
        const pos = data.page * 10 + index + 1;
        return `**${pos}.** <@${customer.userId}> - ${money(customer.periodAmount)} (${customer.periods?.[selectedPeriod]?.[data.key]?.orders || 0} compra(s))`;
      }).join("\n")
    : "Nenhuma venda registrada nesse periodo.";

  return new EmbedBuilder()
    .setTitle("Ranking de gastos")
    .setDescription(lines)
    .setColor(0x28f6a1)
    .addFields(
      { name: "Periodo", value: `${RANKING_PERIODS[selectedPeriod]} atual`, inline: true },
      { name: "Pagina", value: `${data.page + 1}/${data.totalPages}`, inline: true }
    )
    .setTimestamp();
}
function rankingComponents(guildId, period = "month", page = 0) {
  const selectedPeriod = RANKING_PERIODS[period] ? period : "month";
  const data = rankingData(guildId, selectedPeriod, page);
  return [
    new ActionRowBuilder().addComponents(
      Object.entries(RANKING_PERIODS).map(([key, label]) =>
        new ButtonBuilder()
          .setCustomId(`rank:${key}:0`)
          .setLabel(label)
          .setStyle(key === selectedPeriod ? ButtonStyle.Primary : ButtonStyle.Secondary)
      )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rank:${selectedPeriod}:${Math.max(0, data.page - 1)}`)
        .setLabel("Anterior")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(data.page <= 0),
      new ButtonBuilder()
        .setCustomId(`rank:${selectedPeriod}:${data.page + 1}`)
        .setLabel("Proxima")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(data.page >= data.totalPages - 1)
    )
  ];
}
async function showSpendRanking(interaction, period = "month", page = 0) {
  if (!await requireAdminInteraction(interaction, "Voce precisa ser ADM para ver o ranking de gastos.")) return;
  const selectedPeriod = RANKING_PERIODS[period] ? period : "month";
  const data = rankingData(interaction.guildId, selectedPeriod, page);
  const payload = {
    embeds: [rankingEmbed(interaction.guildId, selectedPeriod, data.page)],
    components: rankingComponents(interaction.guildId, selectedPeriod, data.page)
  };

  if (interaction.isButton()) return interaction.update(payload);
  return interaction.reply({ ...payload, ephemeral: true });
}
async function sendSpendRankingMessage(message, period = "month", page = 0) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode ver o ranking de gastos.");
  const selectedPeriod = RANKING_PERIODS[period] ? period : "month";
  const data = rankingData(message.guild.id, selectedPeriod, page);
  await message.delete().catch(() => null);
  return message.channel.send({
    content: `<@${message.author.id}> ranking de gastos atualizado.`,
    embeds: [rankingEmbed(message.guild.id, selectedPeriod, data.page)],
    components: rankingComponents(message.guild.id, selectedPeriod, data.page)
  });
}
function publicSpendRankingData(guildId) {
  const db = readOrders();
  return Object.values(db.customers?.[guildId] || {})
    .filter(customer => Number(customer.totalSpent) > 0)
    .sort((a, b) => Number(b.totalSpent || 0) - Number(a.totalSpent || 0) || String(a.username).localeCompare(String(b.username)))
    .slice(0, 10);
}
function publicSpendRankingEmbed(guildId) {
  const rows = publicSpendRankingData(guildId);
  const lines = rows.length
    ? rows.map((customer, index) => `**${index + 1}.** <@${customer.userId}> - ${money(Number(customer.totalSpent || 0))} (${customer.orderCount || 0} compra(s))`).join("\n")
    : "Ainda nao tem compras registradas.";

  return new EmbedBuilder()
    .setTitle("Top gastos do servidor")
    .setDescription(lines)
    .setColor(0x28f6a1)
    .setFooter({ text: "Ranking publico com valores finais pagos, ja considerando descontos." })
    .setTimestamp();
}
async function showPublicSpendRanking(interaction) {
  return interaction.reply({ embeds: [publicSpendRankingEmbed(interaction.guildId)] });
}
function customerStats(guildId, userId) {
  const db = readOrders();
  return db.customers?.[guildId]?.[userId] || emptyCustomerStats(userId, "");
}
function spendBalanceEmbed(guildId, user) {
  const stats = customerStats(guildId, user.id);
  return new EmbedBuilder()
    .setTitle("Saldo gasto")
    .setDescription(`<@${user.id}> ja gastou **${money(Number(stats.totalSpent || 0))}** na loja.`)
    .setColor(0x28f6a1)
    .addFields(
      { name: "Compras registradas", value: String(stats.orderCount || 0), inline: true },
      { name: "Ultima compra", value: stats.lastOrderAt ? `<t:${Math.floor(Date.parse(stats.lastOrderAt) / 1000)}:R>` : "Nenhuma", inline: true }
    )
    .setTimestamp();
}
async function showSpendBalance(interaction) {
  const requested = interaction.options.getUser("usuario") || interaction.user;
  if (requested.id !== interaction.user.id && !isAdmin(interaction.member)) {
    return interaction.reply({ content: "So ADM pode consultar saldo gasto de outro usuario.", ephemeral: true });
  }
  return interaction.reply({ embeds: [spendBalanceEmbed(interaction.guildId, requested)], ephemeral: true });
}
function adjustCustomerSpend(db, guildId, user, delta, reason = "ajuste manual") {
  if (!db.customers[guildId]) db.customers[guildId] = {};
  const customer = db.customers[guildId][user.id] || emptyCustomerStats(user.id, user.username);
  const now = new Date();
  const keys = periodKeys(now);

  customer.username = user.username || customer.username;
  customer.totalSpent = roundCurrency(Math.max(0, (Number(customer.totalSpent) || 0) + delta));
  customer.manualAdjustments = [
    ...(customer.manualAdjustments || []),
    { amount: roundCurrency(delta), reason: clampText(reason, 200, "ajuste manual"), at: now.toISOString() }
  ].slice(-25);
  customer.lastManualAdjustmentAt = now.toISOString();
  if (delta > 0 && !customer.lastOrderAt) customer.lastOrderAt = now.toISOString();
  for (const [period, key] of Object.entries(keys)) recordPeriodSpend(customer, period, key, delta, 0);

  if (customer.totalSpent <= 0) delete db.customers[guildId][user.id];
  else db.customers[guildId][user.id] = customer;
  return customer;
}
async function adjustSpendCommand(interaction, mode) {
  if (!await requireAdminInteraction(interaction, "So ADM pode ajustar saldo gasto.")) return;
  const user = interaction.options.getUser("usuario");
  const value = interaction.options.getNumber("valor");
  const reason = interaction.options.getString("motivo") || "ajuste manual";
  if (!user || user.bot) return interaction.reply({ content: "Escolha um membro valido.", ephemeral: true });
  if (!Number.isFinite(value) || value <= 0) return interaction.reply({ content: "Valor invalido.", ephemeral: true });

  const delta = mode === "remove" ? -value : value;
  const db = readOrders();
  const stats = adjustCustomerSpend(db, interaction.guildId, user, delta, reason);
  writeOrders(db);
  return interaction.reply({
    content: `${mode === "remove" ? "Removi" : "Adicionei"} ${money(value)} ${mode === "remove" ? "do" : "ao"} saldo de <@${user.id}>. Saldo atual: **${money(Number(stats?.totalSpent || 0))}**.`,
    ephemeral: true
  });
}
async function resetSpendCommand(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode remover alguem do ranking.")) return;
  const user = interaction.options.getUser("usuario");
  if (!user) return interaction.reply({ content: "Escolha um usuario.", ephemeral: true });

  const db = readOrders();
  if (!db.customers[interaction.guildId]) db.customers[interaction.guildId] = {};
  delete db.customers[interaction.guildId][user.id];
  writeOrders(db);
  return interaction.reply({ content: `<@${user.id}> removido do ranking de gastos.`, ephemeral: true });
}
function sellerRankingData(guildId) {
  const db = readOrders();
  return Object.values(db.sellers?.[guildId] || {})
    .filter(seller => Number(seller.totalSold) > 0)
    .sort((a, b) => Number(b.totalSold || 0) - Number(a.totalSold || 0) || String(a.username).localeCompare(String(b.username)));
}
function sellerRankingEmbed(guildId) {
  const rows = sellerRankingData(guildId).slice(0, 25);
  const total = rows.reduce((sum, seller) => sum + Number(seller.totalSold || 0), 0);
  const lines = rows.length
    ? rows.map((seller, index) => `**${index + 1}.** <@${seller.userId}> - ${money(Number(seller.totalSold || 0))} (${seller.orderCount || 0} venda(s), ${seller.totalItems || 0} item(ns))`).join("\n")
    : "Nenhuma venda registrada por ADM ainda.";

  return new EmbedBuilder()
    .setTitle("Vendas por ADM")
    .setDescription(lines)
    .setColor(0x28f6a1)
    .addFields({ name: "Total vendido", value: money(total), inline: true })
    .setFooter({ text: "Conta o ADM que clicou em Finalizar compra." })
    .setTimestamp();
}
async function showSellerSales(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode ver vendas por atendente.")) return;
  return interaction.reply({ embeds: [sellerRankingEmbed(interaction.guildId)], ephemeral: true });
}
async function resetSellerSales(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode resetar vendas por atendente.")) return;
  const user = interaction.options.getUser("vendedor");
  const db = readOrders();
  if (!db.sellers[interaction.guildId]) db.sellers[interaction.guildId] = {};
  if (user) delete db.sellers[interaction.guildId][user.id];
  else db.sellers[interaction.guildId] = {};
  writeOrders(db);
  return interaction.reply({ content: user ? `Vendas de <@${user.id}> resetadas.` : "Ranking de vendas dos ADMs resetado.", ephemeral: true });
}
function orderId(type) {
  const db = readOrders();
  let id = random7();
  while ((type === "order" && db.orders[id]) || (type === "ticket" && db.tickets[id])) id = random7();
  return id;
}

function isPixBox(item) {
  const text = plainText(`${item?.name || ""} ${item?.description || ""}`);
  return item?.type === "pix_box" || /\bcaixa\b/.test(text) && /\bpix\b/.test(text);
}
function isPixReward(reward) {
  const text = plainText(`${reward?.name || ""} ${reward?.description || ""}`);
  return reward?.type === "pix" || /\bpix\b/.test(text);
}
function pixRewardRange(reward = {}) {
  return normalizePixRange(reward.pixMin, reward.pixMax, `${reward.name || ""} ${reward.description || ""}`);
}
function defaultPixReward(item = {}) {
  const range = pixBoxDefaults();
  return {
    name: item.name || "Caixa Pix",
    description: `Pix aleatorio entre ${money(range.min)} e ${money(range.max)}`,
    weight: 100,
    type: "pix",
    pixMin: range.min,
    pixMax: range.max
  };
}
function itemRewards(item) {
  const rewards = Array.isArray(item?.rewards) ? item.rewards.filter(reward => rewardChanceValue(reward) > 0) : [];
  return rewards.length ? completePixRewardChances(rewards) : isPixBox(item) ? [defaultPixReward(item)] : [];
}
function isMysteryBox(item) {
  return (item?.type === "mystery_box" || isPixBox(item)) && itemRewards(item).length > 0;
}
function productIcon(item) {
  return isMysteryBox(item) ? "🎁" : "🛒";
}
function parseRewardLines(raw) {
  const rewards = String(raw || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|").map(part => part.trim());
      const name = parts[0] || "Brinde surpresa";
      const chance = Math.max(0, Number.parseFloat((parts[1] || "1").replace(",", ".")) || 1);
      const description = parts[2] || "Brinde digital";
      const extraText = parts.slice(2).join(" | ");
      const pixLike = /\bpix\b/.test(plainText(`${name} ${extraText}`));
      const reward = { name: name.slice(0, 100), description: description.slice(0, 200), weight: chance, chance };

      if (pixLike) {
        const range = normalizePixRange(parts[3], parts[4], `${name} ${extraText}`);
        reward.type = "pix";
        reward.pixMin = range.min;
        reward.pixMax = range.max;
        reward.description = `Pix aleatorio entre ${money(range.min)} e ${money(range.max)}`;
      }

      return reward;
    })
    .filter(reward => rewardChanceValue(reward) > 0);

  return rewards.length ? completePixRewardChances(rewards) : [
    { name: "Mini Pack Digital", description: "Brinde digital padrão", weight: 100 }
  ];
}
function rewardChanceText(rewards) {
  const list = Array.isArray(rewards) && rewards.length ? rewards : [defaultPixReward()];
  const absolute = usesAbsoluteChances(list);
  const total = list.reduce((sum, reward) => sum + rewardChanceValue(reward), 0) || 1;
  return list.map(reward => {
    const rawChance = rewardChanceValue(reward);
    const chance = (absolute ? rawChance : (rawChance / total) * 100).toFixed(2).replace(".00", "");
    const description = isPixReward(reward)
      ? (() => {
          const range = pixRewardRange(reward);
          return `Pix de ${money(range.min)} ate ${money(range.max)}`;
        })()
      : reward.description || "brinde digital";
    return `• **${reward.name}** — ${chance}% (${description})`;
  }).join("\n");
}
function rewardPublicText(rewards) {
  const list = Array.isArray(rewards) && rewards.length ? completePixRewardChances(rewards) : [defaultPixReward()];
  return list.map(reward => {
    if (isPixReward(reward)) {
      const range = pixRewardRange(reward);
      const value = range.min === range.max
        ? money(range.min)
        : `${money(range.min)} a ${money(range.max)}`;
      return `• **${reward.name}** — ${value}`;
    }

    return `• **${reward.name}**${reward.description ? ` — ${reward.description}` : ""}`;
  }).join("\n");
}
function rewardConfigLine(reward) {
  if (isPixReward(reward)) {
    const range = pixRewardRange(reward);
    return `${reward.name} | ${rewardChanceValue(reward) || 1} | Pix aleatorio | ${range.min} | ${range.max}`;
  }

  return `${reward.name} | ${rewardChanceValue(reward) || 1} | ${reward.description || ""}`;
}
function rewardChanceValue(reward) {
  const raw = reward?.chance ?? reward?.weight;
  const value = Number.parseFloat(String(raw ?? "0").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function usesAbsoluteChances(rewards) {
  const list = Array.isArray(rewards) ? rewards : [];
  if (!list.some(reward => reward.chance !== undefined)) return false;
  const total = list.reduce((sum, reward) => sum + rewardChanceValue(reward), 0);
  return total > 0 && total <= 100;
}
function pickWeightedReward(rewards) {
  const valid = rewards.filter(reward => rewardChanceValue(reward) > 0);
  const absolute = usesAbsoluteChances(valid);
  const total = valid.reduce((sum, reward) => sum + rewardChanceValue(reward), 0);

  if (absolute) {
    let roll = Math.random() * 100;
    for (const reward of valid) {
      roll -= rewardChanceValue(reward);
      if (roll <= 0) return reward;
    }
    return valid[0] || { name: "Brinde digital", description: "Brinde digital", weight: 100, chance: 100 };
  }

  let roll = Math.random() * total;

  for (const reward of valid) {
    roll -= rewardChanceValue(reward);
    if (roll <= 0) return reward;
  }

  return valid[valid.length - 1] || { name: "Brinde digital", description: "Brinde digital", weight: 1 };
}
function resolveRewardResult(reward) {
  if (!isPixReward(reward)) {
    return {
      rewardName: reward.name,
      rewardDescription: reward.description || "Brinde digital"
    };
  }

  const range = pixRewardRange(reward);
  const amount = randomPixAmount(range.min, range.max);
  return {
    rewardName: `${reward.name} - ${money(amount)}`,
    rewardDescription: `Valor Pix sorteado: **${money(amount)}**`,
    rewardType: "pix",
    pixAmount: amount,
    pixMin: range.min,
    pixMax: range.max
  };
}
function rollMysteryBoxes(order, panel) {
  const results = [];

  for (const item of order.items || []) {
    const p = orderItemDetails(item, panel);
    if (!isMysteryBox(p)) continue;

    const rewards = itemRewards(p);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    for (let i = 0; i < quantity; i++) {
      const reward = pickWeightedReward(rewards);
      const resolved = resolveRewardResult(reward);
      results.push({
        boxProductId: p.productId,
        boxName: p.name,
        ...resolved,
        rolledAt: new Date().toISOString()
      });
    }
  }

  return results;
}
function mysteryResultsText(results) {
  if (!Array.isArray(results) || !results.length) return "";
  return results.map((result, index) => {
    return `🎁 **Caixa ${index + 1}: ${result.boxName}**
Resultado: **${result.rewardName}**
${result.rewardDescription}`;
  }).join("\n\n");
}
function mysteryResultsEmbed(results, panel) {
  if (!Array.isArray(results) || !results.length) return null;
  return new EmbedBuilder()
    .setTitle("🎁 Resultado da Caixa Surpresa")
    .setDescription(mysteryResultsText(results).slice(0, 4096))
    .setColor(parseColor(panel.color))
    .setFooter({ text: "Resultado gerado automaticamente ao finalizar a compra." })
    .setTimestamp();
}
function rollPixBoxPreset(quantity = 1) {
  const amount = Math.min(100, Math.max(1, Number(quantity) || 1));
  const rewards = pixBoxPresetRewards();
  const results = [];

  for (let i = 0; i < amount; i++) {
    const reward = pickWeightedReward(rewards);
    results.push({
      boxProductId: "manual_pix_box",
      boxName: "Caixa Pix",
      ...resolveRewardResult(reward),
      rolledAt: new Date().toISOString()
    });
  }

  return results;
}
function pixBoxCommandEmbeds(results, panel = defaultPanel("manual")) {
  const embeds = [];
  const pageSize = 10;
  for (let i = 0; i < results.length; i += pageSize) {
    const page = results.slice(i, i + pageSize);
    embeds.push(
      new EmbedBuilder()
        .setTitle(`Caixa Pix sorteada (${i + 1}-${i + page.length}/${results.length})`)
        .setDescription(mysteryResultsText(page).slice(0, 4096))
        .setColor(parseColor(panel.color, 0x28f6a1))
        .setFooter({ text: "Sorteio manual com o preset padrao da Caixa Pix." })
        .setTimestamp()
    );
  }
  return embeds;
}
async function runPixBoxCommand(context, quantity = 1, targetUser = null) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode sortear Caixa Pix manualmente.", ephemeral: true });
  }

  const guildId = actionGuildId(context);
  const db = readOrders();
  const order = findOrderInChannel(db, context, false);
  const panel = order ? getOrderPanel(order, guildId) : getPanel(guildId, context.channel?.id || "default");
  const results = rollPixBoxPreset(quantity);
  const targetId = targetUser?.id || order?.userId || "";
  const payload = {
    content: targetId ? `<@${targetId}> resultado da Caixa Pix:` : "Resultado da Caixa Pix:",
    embeds: pixBoxCommandEmbeds(results, panel),
    allowedMentions: targetId ? { users: [targetId] } : undefined,
    ephemeral: !targetId
  };

  return actionReply(context, payload);
}

function panelEmbed(panel) {
  const e = new EmbedBuilder()
    .setTitle(panel.title || "Loja")
    .setDescription(String(panel.description || "Selecione um produto abaixo.").slice(0, 4096))
    .setColor(parseColor(panel.color))
    .setFooter({ text: "Selecione um produto para abrir um carrinho privado com a equipe." });
  if (panel.imageUrl && validUrl(panel.imageUrl)) e.setImage(panel.imageUrl);
  if (panel.thumbnailUrl && validUrl(panel.thumbnailUrl)) e.setThumbnail(panel.thumbnailUrl);
  return e;
}
function productOptionDescription(p) {
  const parts = [
    String(p.price || "valor a combinar"),
    String(p.description || "Produto da loja"),
    `Estoque: ${String(p.stock || "infinito")}`
  ];
  return parts.join(" | ").slice(0, 100);
}
function productSelect(panel, customId = `buy:${panel.id}`) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${customId}:${sid()}`)
    .setPlaceholder("📦 Selecione um produto")
    .setMinValues(1).setMaxValues(1);
  if (!panel.products.length) {
    menu.setDisabled(true).addOptions([{ label: "Nenhum produto configurado", value: "none", description: "Use !configds para adicionar." }]);
  } else {
    menu.addOptions(panel.products.slice(0, 25).map(p => ({
      label: `${productIcon(p)} ${String(p.name).slice(0, 96)}`,
      description: productOptionDescription(p),
      value: p.id
    })));
  }
  return new ActionRowBuilder().addComponents(menu);
}
function saleMessage(panel) { return { embeds: [panelEmbed(panel)], components: [productSelect(panel)] }; }
function componentCustomId(component) {
  return String(component?.customId || component?.data?.custom_id || component?.data?.customId || "");
}
function componentOptions(component) {
  if (Array.isArray(component?.options)) return component.options;
  if (Array.isArray(component?.data?.options)) return component.data.options;
  return [];
}
function optionField(option, field) {
  return option?.[field] ?? option?.data?.[field] ?? "";
}
function saleSelectComponentFromMessage(message) {
  for (const row of message?.components || []) {
    for (const component of row.components || []) {
      if (componentCustomId(component).startsWith("buy:")) return component;
    }
  }
  return null;
}
function quickBuyComponentFromMessage(message) {
  for (const row of message?.components || []) {
    for (const component of row.components || []) {
      if (componentCustomId(component).startsWith("quickbuy:")) return component;
    }
  }
  return null;
}
function panelIdFromComponentCustomId(customId) {
  return String(customId || "").split(":")[1] || "";
}
function scopeIdFromPanelId(panelId, fallback = "default") {
  const raw = String(panelId || "");
  if (raw === "main") return "default";
  if (raw.startsWith("panel_")) return raw.slice("panel_".length) || fallback;
  return fallback;
}
function stripProductIcon(label) {
  return String(label || "")
    .replace(/^(🛒|🎁)\s*/u, "")
    .trim() || "Produto";
}
function embedColorToHex(embed) {
  if (typeof embed?.hexColor === "string") return normColor(embed.hexColor);
  if (typeof embed?.color === "number") return `#${embed.color.toString(16).padStart(6, "0")}`;
  return "#9b00ff";
}
function parseRecoveredProductOption(option) {
  const fallbackId = `p${random7()}`;
  const parts = String(optionField(option, "description") || "")
    .split("|")
    .map(part => part.trim())
    .filter(Boolean);
  const stockPart = parts.find(part => /^Estoque:/i.test(part));
  const description = parts
    .filter((part, index) => index > 0 && !/^Estoque:/i.test(part))
    .join(" | ");

  return {
    id: clampText(optionField(option, "value") || fallbackId, 100, fallbackId),
    name: clampText(stripProductIcon(optionField(option, "label")), 100, "Produto"),
    price: clampText(parts[0] || "A combinar", 50, "A combinar"),
    description: clampText(description || "Produto recuperado do painel publicado", 200, "Produto da loja"),
    stock: clampText(stockPart ? stockPart.replace(/^Estoque:\s*/i, "") : "infinito", 50, "infinito"),
    imageUrl: ""
  };
}
function applyEmbedToPanel(panel, embed) {
  if (!embed) return;
  panel.title = embed.title || panel.title;
  panel.description = embed.description || panel.description;
  panel.color = embedColorToHex(embed);
  panel.imageUrl = embed.image?.url || panel.imageUrl || "";
  panel.thumbnailUrl = embed.thumbnail?.url || panel.thumbnailUrl || "";
}
function parseMessageReference(raw, fallbackChannelId) {
  const text = String(raw || "").trim();
  const link = text.match(/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})/);
  if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] };

  const ids = text.match(/\d{15,25}/g) || [];
  if (ids.length >= 2) return { channelId: ids[0], messageId: ids[1] };
  if (ids.length === 1) return { channelId: fallbackChannelId, messageId: ids[0] };
  return null;
}
function panelFromSaleMessage(message, guildId, scopeIdOverride = null) {
  const select = saleSelectComponentFromMessage(message);
  if (!select) return null;

  const panelId = panelIdFromComponentCustomId(componentCustomId(select));
  const scopeId = scopeIdOverride || scopeIdFromPanelId(panelId, message.channelId || "default");
  const panel = defaultPanel(guildId, scopeId);
  const options = componentOptions(select).filter(option => optionField(option, "value") && optionField(option, "value") !== "none");

  panel.id = panelId || panel.id;
  panel.channelId = message.channelId;
  panel.publishedChannelId = message.channelId;
  panel.publishedMessageId = message.id;
  panel.products = options.map(parseRecoveredProductOption).slice(0, 25);
  panel.recoveredAt = new Date().toISOString();
  applyEmbedToPanel(panel, message.embeds?.[0]);

  return panel;
}
function panelFromQuickOrderMessage(message, guildId, scopeIdOverride = null) {
  const button = quickBuyComponentFromMessage(message);
  if (!button) return null;

  const panelId = panelIdFromComponentCustomId(componentCustomId(button));
  const scopeId = scopeIdOverride || scopeIdFromPanelId(panelId, message.channelId || "default");
  const panel = defaultPanel(guildId, scopeId);
  const quick = quickOrderConfig(panel);
  const embed = message.embeds?.[0];

  panel.id = panelId || panel.id;
  panel.channelId = message.channelId;
  panel.quickOrder = {
    ...quick,
    title: embed?.title || quick.title,
    description: embed?.description || quick.description,
    publishedChannelId: message.channelId,
    publishedMessageId: message.id
  };
  panel.recoveredAt = new Date().toISOString();
  applyEmbedToPanel(panel, embed);

  return panel;
}
async function recoverPanelFromPublishedMessage(message, guildId, scopeIdOverride = null) {
  const panel = panelFromSaleMessage(message, guildId, scopeIdOverride);
  if (!panel) return null;
  savePanel(guildId, panel, panel.scopeId);
  return panel;
}
async function recoverQuickOrderFromPublishedMessage(message, guildId, scopeIdOverride = null) {
  const panel = panelFromQuickOrderMessage(message, guildId, scopeIdOverride);
  if (!panel) return null;
  savePanel(guildId, panel, panel.scopeId);
  return panel;
}
function shouldAutoRecoverPanel(panel) {
  return !panel?.publishedMessageId && !(panel?.products || []).length;
}
async function findRecoverableSalePanel(channel, guildId, scopeId) {
  if (!channel?.messages?.fetch) return null;
  const messages = await channel.messages.fetch({ limit: 75 }).catch(() => null);
  if (!messages?.size) return null;

  const sorted = [...messages.values()].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    if (right > left) return 1;
    if (right < left) return -1;
    return 0;
  });
  const found = sorted.find(message => {
    const sameBot = !client.user?.id || message.author?.id === client.user.id;
    return sameBot && saleSelectComponentFromMessage(message);
  });

  return found ? recoverPanelFromPublishedMessage(found, guildId, scopeId) : null;
}
async function findRecoverableSalePanels(channel, guildId, scopeId = null, limit = 75) {
  if (!channel?.messages?.fetch) return [];
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages?.size) return [];

  const sorted = [...messages.values()].sort((a, b) => {
    const left = BigInt(a.id);
    const right = BigInt(b.id);
    if (right > left) return 1;
    if (right < left) return -1;
    return 0;
  });
  const recovered = [];
  const seen = new Set();
  const seenPanelKeys = new Set();

  for (const message of sorted) {
    const sameBot = !client.user?.id || message.author?.id === client.user.id;
    if (!sameBot || !saleSelectComponentFromMessage(message) || seen.has(message.id)) continue;
    const select = saleSelectComponentFromMessage(message);
    const panelKey = panelIdFromComponentCustomId(componentCustomId(select)) || message.channelId;
    if (seenPanelKeys.has(panelKey)) continue;
    seen.add(message.id);
    seenPanelKeys.add(panelKey);
    const panel = await recoverPanelFromPublishedMessage(message, guildId, scopeId).catch(() => null);
    if (panel) recovered.push(panel);
  }

  return recovered;
}
function publicPanelScanFresh(guildId) {
  const ttl = Math.max(10, Number(process.env.PUBLIC_STORE_SCAN_CACHE_SECONDS || 60) || 60) * 1000;
  const last = publicPanelScanCache.get(guildId) || 0;
  if (Date.now() - last < ttl) return true;
  publicPanelScanCache.set(guildId, Date.now());
  return false;
}
function isScannablePublicChannel(channel) {
  return Boolean(
    channel?.messages?.fetch &&
    channel?.isTextBased?.() &&
    !channel.isThread?.() &&
    [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
  );
}
async function scanGuildForPublishedSalePanels(guild, guildId, force = false) {
  if (process.env.PUBLIC_STORE_SCAN_CHANNELS === "false") return [];
  if (!force && publicPanelScanFresh(guildId)) return [];
  publicPanelScanCache.set(guildId, Date.now());

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels?.size) return [];

  const maxChannels = Math.max(1, Number(process.env.PUBLIC_STORE_SCAN_CHANNEL_LIMIT || 80) || 80);
  const messageLimit = Math.min(100, Math.max(10, Number(process.env.PUBLIC_STORE_SCAN_MESSAGE_LIMIT || 75) || 75));
  const candidates = [...channels.values()]
    .filter(isScannablePublicChannel)
    .sort((a, b) => (a.rawPosition ?? 9999) - (b.rawPosition ?? 9999))
    .slice(0, maxChannels);
  const recovered = [];

  for (const channel of candidates) {
    const panels = await findRecoverableSalePanels(channel, guildId, null, messageLimit).catch(() => []);
    recovered.push(...panels);
  }

  if (recovered.length) console.log(`API publica recuperou ${recovered.length} painel(is) publicados do Discord.`);
  return recovered;
}
async function resetSelectMessage(interaction, payload) {
  try {
    await interaction.message?.edit(payload);
  } catch (error) {
    console.log("Não consegui resetar o menu de seleção:", error.message);
  }
}
function quickOrderConfig(panel) {
  return { ...defaultQuickOrder(), ...(panel.quickOrder || {}) };
}
function quickOrderEmbed(panel) {
  const quick = quickOrderConfig(panel);
  const embed = new EmbedBuilder()
    .setTitle(quick.title || "Compre aqui")
    .setDescription(String(quick.description || defaultQuickOrder().description).slice(0, 4096))
    .setColor(parseColor(panel.color));

  if (panel.imageUrl && validUrl(panel.imageUrl)) embed.setImage(panel.imageUrl);
  if (panel.thumbnailUrl && validUrl(panel.thumbnailUrl)) embed.setThumbnail(panel.thumbnailUrl);
  return embed;
}
function quickOrderRows(panel) {
  const quick = quickOrderConfig(panel);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quickbuy:${panel.id}`)
        .setLabel(String(quick.buttonLabel || "Comprar").slice(0, 80))
        .setEmoji("🛍️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`quickauto:${panel.id}`)
        .setLabel("Automático")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`quickcombo:${panel.id}`)
        .setLabel("Combos")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`quickhelp:${panel.id}`)
        .setLabel("?")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    )
  ];
}
function quickOrderMessage(panel) {
  return { embeds: [quickOrderEmbed(panel)], components: quickOrderRows(panel) };
}
function quickOrderEditModal(sessionId, panel) {
  const quick = quickOrderConfig(panel);
  return new ModalBuilder()
    .setCustomId(`modal:${sessionId}:quickedit`)
    .setTitle("Editar mensagem comprar")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quickTitle")
          .setLabel("Título da mensagem")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setValue(String(quick.title || "Compre aqui").slice(0, 100))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quickDescription")
          .setLabel("Texto da mensagem")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(2000)
          .setRequired(true)
          .setValue(String(quick.description || defaultQuickOrder().description).slice(0, 2000))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("buttonLabel")
          .setLabel("Texto do botão comprar")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
          .setValue(String(quick.buttonLabel || "Comprar").slice(0, 80))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("question1")
          .setLabel("Pergunta 1 do formulário")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(45)
          .setRequired(true)
          .setValue(String(quick.question1 || "Nick no roblox").slice(0, 45))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("question2")
          .setLabel("Pergunta 2 do formulário")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(45)
          .setRequired(true)
          .setValue(String(quick.question2 || "Nome do Set que você deseja comprar").slice(0, 45))
      )
    );
}
function quickOrderBuyModal(panel) {
  const quick = quickOrderConfig(panel);
  return new ModalBuilder()
    .setCustomId(`quickmodal:${panel.id}`)
    .setTitle(String(quick.title || "Comprar").slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("answer1")
          .setLabel(String(quick.question1 || "Nick no roblox").slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("answer2")
          .setLabel(String(quick.question2 || "Nome do Set que você deseja comprar").slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      )
    );
}
function productInfoEmbed(item, panel, title = "Produto selecionado") {
  const details = item.productId ? orderItemDetails(item, panel) : item;
  const embed = new EmbedBuilder()
    .setTitle(`${productIcon(details)} ${title}`)
    .setDescription(`**${details.name}**\n${details.description || "Produto da loja"}`.slice(0, 4096))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Valor", value: String(details.price || "a combinar").slice(0, 1024), inline: true },
      { name: "Estoque", value: String(details.stock || "infinito").slice(0, 1024), inline: true }
    );

  if (isMysteryBox(details)) {
    embed.addFields({ name: "Possíveis prêmios", value: rewardPublicText(itemRewards(details)).slice(0, 1024), inline: false });
  }

  if (details.imageUrl && validUrl(details.imageUrl)) embed.setImage(details.imageUrl);
  return embed;
}

function configEmbed(panel, ownerId) {
  const lines = panel.products.length
    ? panel.products.slice(0, 15).map((p, i) => {
        const extra = isMysteryBox(p) ? ` | 🎁 ${itemRewards(p).length} prêmios` : "";
        const image = p.imageUrl ? " | 🖼️ imagem" : "";
        return `\`${i + 1}.\` ${productIcon(p)} **${p.name}** — ${p.price} | Estoque: ${p.stock || "infinito"}${image}${extra}`;
      }).join("\n")
    : "Nenhum produto.";

  const publishedLine = panel.publishedChannelId && panel.publishedMessageId
    ? `<#${panel.publishedChannelId}> / mensagem \`${panel.publishedMessageId}\``
    : "Nenhum painel publicado salvo ainda.";
  const scopeLine = /^\d{15,25}$/.test(String(panel.scopeId || ""))
    ? `<#${panel.scopeId}>`
    : "canal atual";

  return new EmbedBuilder()
    .setTitle("⚙️ Configurador da Loja")
    .setColor(parseColor(panel.color))
    .setDescription(`Use os botões abaixo para montar o painel igual ao da print.

**Dono:** <@${ownerId}>
**Config deste canal:** ${scopeLine}
**Canal de publicação:** ${panel.channelId ? `<#${panel.channelId}>` : "não definido; se publicar agora, usa este canal"}
**Painel publicado salvo:** ${publishedLine}
**Cor:** \`${panel.color}\`
**Imagem:** ${panel.imageUrl ? "configurada ✅" : "sem imagem"}

**Produtos:**
${lines}

**Publicar painel** publica ou reutiliza a mensagem salva quando possível.
**Atualizar publicado** edita manualmente o painel que já está no chat.
Use **Editar produto** para trocar nome, preço, estoque, foto e brindes.
Use **Presets** para substituir os produtos só deste canal.
Use **Vincular painel** se o Render perdeu o JSON e voce quer recuperar uma mensagem ja publicada.
Use os botões de **Enviar imagem** para mandar arquivo direto no Discord, sem colar link.`);
}
function configRows(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:title`).setLabel("Título").setEmoji("🏷️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:desc`).setLabel("Descrição").setEmoji("📝").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:image`).setLabel("Imagem").setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:color`).setLabel("Cor").setEmoji("🎨").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:channel`).setLabel("Canal").setEmoji("📢").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:add`).setLabel("Adicionar produto").setEmoji("➕").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:remove`).setLabel("Remover produto").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:preview`).setLabel("Preview").setEmoji("👁️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:publish`).setLabel("Publicar painel").setEmoji("🚀").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:update`).setLabel("Atualizar publicado").setEmoji("♻️").setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:mystery`).setLabel("Adicionar caixa surpresa").setEmoji("🎁").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:edit`).setLabel("Editar produto").setEmoji("✏️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:linkpanel`).setLabel("Vincular painel").setEmoji("🔗").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:reset`).setLabel("Resetar vazio").setEmoji("♻️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:close`).setLabel("Fechar config").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:uploadpanel`).setLabel("Enviar imagem do painel").setEmoji("🖼️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:uploadproduct`).setLabel("Enviar foto de produto").setEmoji("📸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:preset`).setLabel("Presets").setEmoji("📋").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:quickedit`).setLabel("Editar compra").setEmoji("🧾").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:quickpublish`).setLabel("Publicar compra").setEmoji("🛍️").setStyle(ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:rewards`).setLabel("Sorteio/Chances").setEmoji("🎲").setStyle(ButtonStyle.Primary)
    )
  ];
}
async function refreshConfig(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    const guild = await client.guilds.fetch(s.guildId);
    const ch = await guild.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(s.messageId);
    const panel = getPanel(s.guildId, s.scopeId);
    await msg.edit({ embeds: [configEmbed(panel, s.ownerId)], components: configRows(sessionId) });
  } catch (e) { console.error("refreshConfig:", e.message); }
}
async function startConfig(channel, member, user) {
  if (!isAdmin(member)) return channel.send(`<@${user.id}> você precisa ser admin ou ter o cargo ADM configurado.`);

  const guildId = channel.guild.id;
  let panel = getPanel(guildId, channel.id);
  if (shouldAutoRecoverPanel(panel)) {
    panel = await findRecoverableSalePanel(channel, guildId, channel.id) || panel;
  }
  const sessionId = sid();
  let msg = null;

  // Se já existe um !configds nesse mesmo canal, edita ele em vez de criar outro.
  if (panel.configMessageChannelId === channel.id && panel.configMessageId) {
    msg = await channel.messages.fetch(panel.configMessageId).catch(() => null);
  }

  if (msg) {
    await msg.edit({ embeds: [configEmbed(panel, user.id)], components: configRows(sessionId) });
  } else {
    msg = await channel.send({ embeds: [configEmbed(panel, user.id)], components: configRows(sessionId) });
    panel.configMessageChannelId = channel.id;
    panel.configMessageId = msg.id;
    savePanel(guildId, panel, channel.id);
  }

  sessions.set(sessionId, { guildId, scopeId: channel.id, channelId: channel.id, messageId: msg.id, ownerId: user.id, createdAt: Date.now() });
  setTimeout(() => sessions.delete(sessionId), 60 * 60 * 1000);
}
async function sessionOrReply(interaction, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    await interaction.reply({ content: "Sessão expirada. Use `!configds` ou `/configds` de novo.", ephemeral: true });
    return null;
  }
  if (interaction.user.id !== s.ownerId && !isAdmin(interaction.member)) {
    await interaction.reply({ content: "Só quem abriu ou um admin pode mexer nisso.", ephemeral: true });
    return null;
  }
  return s;
}
function editModal(sessionId, field, panel) {
  const modal = new ModalBuilder().setCustomId(`modal:${sessionId}:${field}`).setTitle("Configurar painel");
  if (field === "title") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Título").setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(String(panel.title || "").slice(0, 256))));
  if (field === "desc") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Descrição").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue(String(panel.description || "").slice(0, 4000))));
  if (field === "image") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("URL da imagem/banner").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(String(panel.imageUrl || "").slice(0, 500))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("thumb").setLabel("URL do thumbnail/opcional").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(String(panel.thumbnailUrl || "").slice(0, 500)))
  );
  if (field === "color") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("color").setLabel("Cor HEX").setPlaceholder("#9b00ff").setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(true).setValue(String(panel.color || "#9b00ff"))));
  if (field === "channel") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel").setLabel("ID do canal de publicação").setPlaceholder("Cole o ID do canal").setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(false).setValue(String(panel.channelId || ""))));
  if (field === "linkpanel") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("messageRef").setLabel("Link ou ID da mensagem publicada").setPlaceholder("Cole o link da mensagem antiga do painel").setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true)));
  if (field === "add") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Nome do produto").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Valor").setPlaceholder("R$ 5,00").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pdesc").setLabel("Descrição curta").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("stock").setLabel("Estoque").setPlaceholder("infinito").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("imageUrl").setLabel("URL da foto do produto").setPlaceholder("https://.../produto.png").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false))
  );
  if (field === "mystery") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Nome da caixa surpresa").setPlaceholder("Ex: Caixa Surpresa de Packs").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Valor").setPlaceholder("R$ 0,10").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pdesc").setLabel("Descrição curta").setPlaceholder("Sorteia um brinde digital após finalizar").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("stock").setLabel("Estoque").setPlaceholder("infinito").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("rewards").setLabel("Brindes: nome | peso | desc/pix").setPlaceholder("Caixa Pix | 100 | Pix aleatorio | 0 | 1000\nPack Premium | 5 | pack raro").setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))
  );
  return modal;
}
function productEditModal(sessionId, p) {
  const modal = new ModalBuilder()
    .setCustomId(`modal:${sessionId}:edit:${p.id}`)
    .setTitle("Editar produto")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Nome")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setValue(String(p.name || "").slice(0, 100))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("price")
          .setLabel("Valor")
          .setPlaceholder("R$ 5,00")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setValue(String(p.price || "").slice(0, 50))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pdesc")
          .setLabel("Descrição curta")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setRequired(false)
          .setValue(String(p.description || "").slice(0, 200))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("stock")
          .setLabel("Estoque")
          .setPlaceholder("infinito")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(false)
          .setValue(String(p.stock || "infinito").slice(0, 50))
      )
    );

  if (isMysteryBox(p)) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("rewards")
          .setLabel("Brindes: nome | peso | desc/pix")
          .setPlaceholder("Caixa Pix | 100 | Pix aleatorio | 0 | 1000")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setValue(itemRewards(p).map(rewardConfigLine).join("\n").slice(0, 1000))
      )
    );
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("imageUrl")
          .setLabel("URL da foto do produto")
          .setPlaceholder("https://.../produto.png")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false)
          .setValue(String(p.imageUrl || "").slice(0, 500))
      )
    );
  }

  return modal;
}
async function publishPanelMessage(interaction, panel, guildId) {
  const channelId = panel.channelId || panel.publishedChannelId || interaction.channelId;
  const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, message: "Canal inválido. Clique em **Canal** e cole o ID correto." };
  }

  let oldMessage = null;
  if (panel.publishedChannelId === ch.id && panel.publishedMessageId) {
    oldMessage = await ch.messages.fetch(panel.publishedMessageId).catch(() => null);
  }

  if (oldMessage) {
    await oldMessage.edit(saleMessage(panel));
    return { ok: true, action: "updated", channelId: ch.id, messageId: oldMessage.id };
  }

  const sent = await ch.send(saleMessage(panel));
  panel.publishedChannelId = ch.id;
  panel.publishedMessageId = sent.id;
  savePanel(guildId, panel, panel.scopeId);
  return { ok: true, action: "published", channelId: ch.id, messageId: sent.id };
}
async function updatePublishedPanel(guild, panel) {
  if (!panel.publishedChannelId || !panel.publishedMessageId) return false;

  try {
    const ch = await guild.channels.fetch(panel.publishedChannelId);
    if (!ch || !ch.isTextBased()) return false;
    const msg = await ch.messages.fetch(panel.publishedMessageId);
    await msg.edit(saleMessage(panel));
    return true;
  } catch (error) {
    console.log("Não consegui atualizar painel publicado:", error.message);
    return false;
  }
}
async function updatePublishedQuickOrder(guild, panel) {
  const quick = quickOrderConfig(panel);
  if (!quick.publishedChannelId || !quick.publishedMessageId) return false;

  try {
    const ch = await guild.channels.fetch(quick.publishedChannelId);
    if (!ch || !ch.isTextBased()) return false;
    const msg = await ch.messages.fetch(quick.publishedMessageId);
    await msg.edit(quickOrderMessage(panel));
    return true;
  } catch (error) {
    console.log("Não consegui atualizar mensagem de compra publicada:", error.message);
    return false;
  }
}
function panelImageUploadMenu(sessionId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`uploadpanel:${sessionId}`)
      .setPlaceholder("Onde salvar a imagem?")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([
        { label: "Banner do painel", description: "Imagem grande do embed da loja", value: "panelImage" },
        { label: "Thumbnail do painel", description: "Imagem pequena no canto do embed", value: "panelThumb" }
      ])
  );
}
function productImageUploadMenu(sessionId, panel) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`uploadproduct:${sessionId}`)
      .setPlaceholder("Produto que vai receber a foto")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(p => ({
        label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
        description: productOptionDescription(p),
        value: p.id
      })))
  );
}
function rewardProductMenu(sessionId, panel) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`reward:${sessionId}`)
      .setPlaceholder("Produto que vai receber sorteio/chances")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(p => ({
        label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
        description: isMysteryBox(p) ? "Editar chances ja configuradas" : "Transformar este produto em sorteio",
        value: p.id
      })))
  );
}
function rewardEditModal(sessionId, p) {
  const currentRewards = itemRewards(p);
  const currentValue = currentRewards.length
    ? currentRewards.map(rewardConfigLine).join("\n")
    : pixBoxPresetRewards().map(rewardConfigLine).join("\n");

  return new ModalBuilder()
    .setCustomId(`modal:${sessionId}:rewards:${p.id}`)
    .setTitle("Configurar sorteio")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("rewards")
          .setLabel("Nome | porcentagem | desc/pix")
          .setPlaceholder("5 centavos | 84.48999 | Pix")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setValue(currentValue.slice(0, 1000))
      )
    );
}
function presetMenu(sessionId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`preset:${sessionId}`)
      .setPlaceholder("Escolha um preset para substituir os produtos")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(Object.entries(PRODUCT_PRESETS).map(([value, preset]) => ({
        label: preset.label,
        description: value === "empty" ? "Limpa os produtos e deixa o painel pronto para configurar" : `${preset.items.length} produtos cadastrados automaticamente`,
        value
      })))
  );
}
async function publishQuickOrderMessage(interaction, panel, guildId) {
  const quick = quickOrderConfig(panel);
  const channelId = panel.channelId || quick.publishedChannelId || interaction.channelId;
  const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, message: "Canal inválido. Clique em **Canal** e cole o ID correto." };
  }

  let oldMessage = null;
  if (quick.publishedChannelId === ch.id && quick.publishedMessageId) {
    oldMessage = await ch.messages.fetch(quick.publishedMessageId).catch(() => null);
  }

  if (oldMessage) {
    await oldMessage.edit(quickOrderMessage(panel));
    return { ok: true, action: "updated", channelId: ch.id, messageId: oldMessage.id };
  }

  const sent = await ch.send(quickOrderMessage(panel));
  panel.quickOrder = {
    ...quick,
    publishedChannelId: ch.id,
    publishedMessageId: sent.id
  };
  savePanel(guildId, panel, panel.scopeId);
  return { ok: true, action: "published", channelId: ch.id, messageId: sent.id };
}
async function saveAttachmentAsDiscordImage(channel, attachment, label) {
  if (attachment.size > MAX_SAVED_IMAGE_BYTES) {
    return {
      url: attachment.url,
      copied: false,
      note: "O arquivo era grande demais para eu reenviar; salvei a URL do anexo original."
    };
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") || attachment.contentType || "image/png";
    if (!contentType.startsWith("image/")) throw new Error("arquivo baixado não é imagem");

    const bytes = Buffer.from(await response.arrayBuffer());
    const file = new AttachmentBuilder(bytes, { name: savedImageName(attachment) });
    const saved = await channel.send({ content: `Imagem salva para **${label}**.`, files: [file] });
    const savedAttachment = saved.attachments.first();

    return {
      url: savedAttachment?.url || attachment.url,
      copied: Boolean(savedAttachment),
      note: savedAttachment ? "Copiei a imagem para uma mensagem do bot e salvei essa URL." : "Salvei a URL do anexo original."
    };
  } catch (error) {
    console.log("Não consegui copiar imagem enviada:", error.message);
    return {
      url: attachment.url,
      copied: false,
      note: "Não consegui copiar a imagem, então salvei a URL do anexo original."
    };
  }
}
async function queueImageUpload(interaction, sessionId, pending) {
  const key = imageUploadKey(interaction.guildId, interaction.channelId, interaction.user.id);
  const uploadState = {
    ...pending,
    sessionId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    expiresAt: Date.now() + IMAGE_UPLOAD_TTL_MS
  };
  imageUploads.set(key, uploadState);
  setTimeout(() => {
    if (imageUploads.get(key)?.expiresAt === uploadState.expiresAt) imageUploads.delete(key);
  }, IMAGE_UPLOAD_TTL_MS + 1000);

  const s = sessions.get(sessionId);
  const panel = getPanel(interaction.guildId, s?.scopeId || interaction.channelId);
  const label = imageUploadTargetLabel(pending, panel);
  return interaction.reply({
    content: `Beleza. Agora envie a imagem como **anexo neste canal** em até 3 minutos. Vou salvar como ${label}.`,
    ephemeral: true
  });
}
function removeProductRows(sessionId, panel, selectedIds = []) {
  const products = (panel.products || []).slice(0, 25);
  const selected = new Set(selectedIds);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`remove:${sessionId}`)
    .setPlaceholder("Selecione os produtos para remover")
    .setMinValues(1)
    .setMaxValues(Math.max(1, products.length))
    .addOptions(products.map(p => ({
      label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
      description: productOptionDescription(p),
      value: p.id,
      default: selected.has(p.id)
    })));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rmconfirm:${sessionId}`)
      .setLabel(`Remover (${selected.size})`)
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(selected.size === 0),
    new ButtonBuilder()
      .setCustomId(`rmcancel:${sessionId}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary)
  );

  return [new ActionRowBuilder().addComponents(menu), buttons];
}
function selectedProductNames(panel, ids) {
  const wanted = new Set(ids || []);
  return (panel.products || [])
    .filter(p => wanted.has(p.id))
    .map(p => `• ${productIcon(p)} ${p.name}`)
    .join("\n");
}
async function handleConfigButton(interaction) {
  const [, sessionId, action] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  if (["title", "desc", "image", "color", "channel", "linkpanel", "add", "mystery"].includes(action)) return interaction.showModal(editModal(sessionId, action, panel));
  if (action === "preview") return interaction.reply({ content: "Preview:", ...saleMessage(panel), ephemeral: true });
  if (action === "preset") {
    return interaction.reply({ content: "Escolha o preset. Isso substitui os produtos atuais deste canal.", components: [presetMenu(sessionId)], ephemeral: true });
  }
  if (action === "quickedit") {
    return interaction.showModal(quickOrderEditModal(sessionId, panel));
  }
  if (action === "quickpublish") {
    const result = await publishQuickOrderMessage(interaction, panel, s.guildId);
    if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });
    await refreshConfig(sessionId);
    const actionText = result.action === "updated" ? "Mensagem de compra atualizada" : "Mensagem de compra publicada";
    return interaction.reply({ content: `${actionText} em <#${result.channelId}>.`, ephemeral: true });
  }
  if (action === "uploadpanel") {
    return interaction.reply({ content: "Escolha onde a imagem do painel vai entrar:", components: [panelImageUploadMenu(sessionId)], ephemeral: true });
  }
  if (action === "uploadproduct") {
    if (!panel.products.length) return interaction.reply({ content: "Cadastre um produto antes de enviar foto.", ephemeral: true });
    return interaction.reply({ content: "Escolha o produto que vai receber a foto:", components: [productImageUploadMenu(sessionId, panel)], ephemeral: true });
  }
  if (action === "rewards") {
    if (!panel.products.length) return interaction.reply({ content: "Cadastre um produto antes de configurar sorteio.", ephemeral: true });
    return interaction.reply({
      content: "Escolha o produto que vai receber/editar porcentagens de sorteio.",
      components: [rewardProductMenu(sessionId, panel)],
      ephemeral: true
    });
  }
  if (action === "publish") {
    const result = await publishPanelMessage(interaction, panel, s.guildId);
    if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });
    await refreshConfig(sessionId);

    const actionText = result.action === "updated" ? "Painel existente atualizado" : "Painel publicado";
    return interaction.reply({ content: `${actionText} em <#${result.channelId}> e salvo para futuras edições.`, ephemeral: true });
  }
  if (action === "update") {
    if (!panel.publishedChannelId || !panel.publishedMessageId) {
      return interaction.reply({ content: "Ainda não tem painel publicado salvo. Clique em **Publicar painel** primeiro.", ephemeral: true });
    }

    const ch = await interaction.guild.channels.fetch(panel.publishedChannelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return interaction.reply({ content: "Não achei o canal do painel publicado. Publique de novo.", ephemeral: true });

    const msg = await ch.messages.fetch(panel.publishedMessageId).catch(() => null);
    if (!msg) return interaction.reply({ content: "Não achei a mensagem antiga do painel. Ela pode ter sido apagada. Publique de novo.", ephemeral: true });

    await msg.edit(saleMessage(panel));
    return interaction.reply({ content: `Painel antigo atualizado em <#${ch.id}>.`, ephemeral: true });
  }
  if (action === "edit") {
    if (!panel.products.length) return interaction.reply({ content: "Não tem produto para editar.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`edit:${sessionId}`)
      .setPlaceholder("Produto para editar")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(p => ({
        label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
        description: productOptionDescription(p),
        value: p.id
      })));
    return interaction.reply({ content: "Escolha o produto que quer editar:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }
  if (action === "remove") {
    if (!panel.products.length) return interaction.reply({ content: "Não tem produto para remover.", ephemeral: true });
    s.removeIds = [];
    return interaction.reply({ content: "Selecione um ou mais produtos e confirme para remover.", components: removeProductRows(sessionId, panel), ephemeral: true });
  }
  if (action === "reset") {
    const resetPanel = defaultPanel(s.guildId, s.scopeId);
    resetPanel.configMessageChannelId = s.channelId;
    resetPanel.configMessageId = s.messageId;
    savePanel(s.guildId, resetPanel, s.scopeId);
    await refreshConfig(sessionId);
    return interaction.reply({ content: "Painel resetado para vazio.", ephemeral: true });
  }
  if (action === "close") {
    sessions.delete(sessionId);
    return interaction.update({ content: "Configuração fechada.", embeds: [], components: [] });
  }
}
async function handleModal(interaction) {
  const [, sessionId, field, productId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  if (field === "title") panel.title = interaction.fields.getTextInputValue("title").trim();
  if (field === "desc") panel.description = interaction.fields.getTextInputValue("desc").trim();
  if (field === "image") {
    const image = interaction.fields.getTextInputValue("image").trim();
    const thumb = interaction.fields.getTextInputValue("thumb").trim();
    if (!validUrl(image) || !validUrl(thumb)) return interaction.reply({ content: "URL inválida. Use link http/https ou deixe vazio.", ephemeral: true });
    panel.imageUrl = image; panel.thumbnailUrl = thumb;
  }
  if (field === "color") panel.color = normColor(interaction.fields.getTextInputValue("color"));
  if (field === "channel") {
    const channel = interaction.fields.getTextInputValue("channel").trim();
    if (channel && !/^\d{15,25}$/.test(channel)) return interaction.reply({ content: "ID de canal inválido.", ephemeral: true });
    panel.channelId = channel;
  }
  if (field === "linkpanel") {
    const ref = parseMessageReference(interaction.fields.getTextInputValue("messageRef"), panel.publishedChannelId || panel.channelId || interaction.channelId);
    if (!ref?.messageId || !ref?.channelId) {
      return interaction.reply({ content: "Cole um link de mensagem do Discord ou o ID da mensagem publicada.", ephemeral: true });
    }
    if (ref.guildId && ref.guildId !== interaction.guildId) {
      return interaction.reply({ content: "Essa mensagem parece ser de outro servidor.", ephemeral: true });
    }

    const ch = await interaction.guild.channels.fetch(ref.channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) {
      return interaction.reply({ content: "Nao achei o canal dessa mensagem. Confira o link/ID e as permissoes do bot.", ephemeral: true });
    }

    const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (!msg) {
      return interaction.reply({ content: "Nao achei essa mensagem no canal informado.", ephemeral: true });
    }

    const recovered = await recoverPanelFromPublishedMessage(msg, s.guildId, s.scopeId);
    if (!recovered) {
      return interaction.reply({ content: "Essa mensagem nao parece ser um painel de produtos publicado por este bot.", ephemeral: true });
    }

    recovered.configMessageChannelId = s.channelId;
    recovered.configMessageId = s.messageId;
    savePanel(s.guildId, recovered, s.scopeId);
    await refreshConfig(sessionId);
    return interaction.reply({ content: `Painel vinculado e recuperado de <#${ch.id}> com **${recovered.products.length}** produtos.`, ephemeral: true });
  }
  if (field === "quickedit") {
    const oldQuick = quickOrderConfig(panel);
    panel.quickOrder = {
      ...oldQuick,
      title: interaction.fields.getTextInputValue("quickTitle").trim() || "Compre aqui",
      description: interaction.fields.getTextInputValue("quickDescription").trim() || defaultQuickOrder().description,
      buttonLabel: interaction.fields.getTextInputValue("buttonLabel").trim() || "Comprar",
      question1: interaction.fields.getTextInputValue("question1").trim() || "Nick no roblox",
      question2: interaction.fields.getTextInputValue("question2").trim() || "Nome do Set que você deseja comprar"
    };
  }
  if (field === "add") {
    if (panel.products.length >= 25) return interaction.reply({ content: "Limite de 25 produtos atingido.", ephemeral: true });
    const imageUrl = interaction.fields.getTextInputValue("imageUrl").trim();
    if (imageUrl && !validUrl(imageUrl)) return interaction.reply({ content: "URL da foto inválida. Use link http/https ou deixe vazio.", ephemeral: true });
    panel.products.push({
      id: "p" + random7(),
      ...normalizeProductInput({
        name: interaction.fields.getTextInputValue("name"),
        price: interaction.fields.getTextInputValue("price"),
        description: interaction.fields.getTextInputValue("pdesc") || "Produto da loja",
        stock: interaction.fields.getTextInputValue("stock") || "infinito",
        imageUrl
      })
    });
  }
  if (field === "mystery") {
    if (panel.products.length >= 25) return interaction.reply({ content: "Limite de 25 produtos atingido.", ephemeral: true });
    panel.products.push({
      id: "p" + random7(),
      type: "mystery_box",
      name: interaction.fields.getTextInputValue("name").trim(),
      price: interaction.fields.getTextInputValue("price").trim(),
      description: interaction.fields.getTextInputValue("pdesc").trim() || "Sorteia um brinde digital após a compra ser finalizada",
      stock: interaction.fields.getTextInputValue("stock").trim() || "infinito",
      rewards: parseRewardLines(interaction.fields.getTextInputValue("rewards"))
    });
  }
  if (field === "edit") {
    const target = product(panel, productId);
    if (!target) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });
    const wasMysteryBox = isMysteryBox(target);

    const patch = normalizeProductInput({
      name: interaction.fields.getTextInputValue("name"),
      price: interaction.fields.getTextInputValue("price"),
      description: interaction.fields.getTextInputValue("pdesc") || "Produto da loja",
      stock: interaction.fields.getTextInputValue("stock") || "infinito",
      imageUrl: target.imageUrl || ""
    });

    target.name = patch.name;
    target.price = patch.price;
    target.description = patch.description;
    target.stock = patch.stock;

    if (wasMysteryBox || isMysteryBox(target)) {
      if (target.type !== "mystery_box" && target.type !== "pix_box") target.type = "mystery_box";
      target.rewards = parseRewardLines(interaction.fields.getTextInputValue("rewards"));
    } else {
      const imageUrl = interaction.fields.getTextInputValue("imageUrl").trim();
      if (imageUrl && !validUrl(imageUrl)) return interaction.reply({ content: "URL da foto inválida. Use link http/https ou deixe vazio.", ephemeral: true });
      target.imageUrl = imageUrl;
    }
  }
  if (field === "rewards") {
    const target = product(panel, productId);
    if (!target) return interaction.reply({ content: "Produto nao encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

    target.type = "mystery_box";
    target.rewards = parseRewardLines(interaction.fields.getTextInputValue("rewards"));
  }
  savePanel(s.guildId, panel, s.scopeId);
  await refreshConfig(sessionId);
  return interaction.reply({ content: "Atualizado.", ephemeral: true });
}
async function handleRemove(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  s.removeIds = interaction.values;
  const picked = selectedProductNames(panel, s.removeIds) || "Nenhum produto selecionado.";
  return interaction.update({
    content: `Produtos marcados para remocao:\n${picked}`,
    components: removeProductRows(sessionId, panel, s.removeIds)
  });
}
async function handleRemoveConfirm(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const ids = Array.isArray(s.removeIds) ? s.removeIds : [];
  if (!ids.length) {
    return interaction.reply({ content: "Selecione pelo menos um produto antes de confirmar.", ephemeral: true });
  }

  const panel = getPanel(s.guildId, s.scopeId);
  const before = panel.products.length;
  const removeSet = new Set(ids);
  panel.products = panel.products.filter(p => !removeSet.has(p.id));
  const removed = before - panel.products.length;

  savePanel(s.guildId, panel, s.scopeId);
  s.removeIds = [];
  await refreshConfig(sessionId);
  return interaction.update({ content: `${removed} produto(s) removido(s).`, components: [] });
}
async function handleRemoveCancel(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  s.removeIds = [];
  return interaction.update({ content: "Remocao cancelada.", components: [] });
}
async function handleEditProduct(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

  return interaction.showModal(productEditModal(sessionId, p));
}
async function handlePanelImageUploadTarget(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  return queueImageUpload(interaction, sessionId, { target: interaction.values[0] });
}
async function handleProductImageUploadTarget(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

  return queueImageUpload(interaction, sessionId, { target: "product", productId: p.id });
}
async function handleRewardProduct(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto nao encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

  return interaction.showModal(rewardEditModal(sessionId, p));
}
async function handlePresetSelect(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const presetKey = interaction.values[0];
  const ok = applyProductPreset(panel, presetKey);
  if (!ok) return interaction.reply({ content: "Preset não encontrado.", ephemeral: true });

  savePanel(s.guildId, panel, s.scopeId);
  await refreshConfig(sessionId);

  const preset = PRODUCT_PRESETS[presetKey];
  return interaction.update({
    content: `Preset **${preset.label}** aplicado neste canal com **${preset.items.length}** produtos.`,
    components: []
  });
}

async function privateChannel(guild, user, name, parent) {
  return guild.channels.create({
    name, type: ChannelType.GuildText, parent,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: config.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
    ]
  });
}
function panelForManualCart(guildId, channelId) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const panels = Object.values(guildStore.panels || {});
  const current = guildStore.panels?.[channelId];
  if (current?.products?.length) return current;

  const publishedHere = panels.find(panel => panel.publishedChannelId === channelId && panel.products?.length);
  if (publishedHere) return publishedHere;

  return panels.find(panel => panel.products?.length) || current || getPanel(guildId, channelId);
}
async function openManualCartCommand(context, targetUser) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode abrir carrinho manual para cliente.", ephemeral: true });
  }
  if (!targetUser) {
    return actionReply(context, { content: "Marque o cliente. Ex: `/carrinho cliente:@usuario` ou `!carrinho @usuario`.", ephemeral: true });
  }
  if (targetUser.bot) {
    return actionReply(context, { content: "Nao da para abrir carrinho para bot.", ephemeral: true });
  }

  const guild = context.guild;
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) return actionReply(context, { content: "Esse usuario nao esta no servidor.", ephemeral: true });

  const panel = panelForManualCart(guild.id, context.channel.id);
  const discount = discountForMember(member);
  const id = orderId("order");
  const ch = await privateChannel(guild, targetUser, `carrinho-${safeName(targetUser.username)}-aberto-${id}`, config.categories.cartOpen);
  const order = {
    id,
    guildId: guild.id,
    panelId: panel.id,
    panelScopeId: panel.scopeId || "default",
    status: "open",
    userId: targetUser.id,
    username: targetUser.username,
    channelId: ch.id,
    items: [],
    discount,
    manual: true,
    createdByAdminId: actionUser(context).id,
    assignedAdminId: null,
    assignedAdminName: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  const db = readOrders();
  db.orders[id] = order;
  writeOrders(db);

  const intro = new EmbedBuilder()
    .setTitle(`Carrinho aberto #${id}`)
    .setDescription([
      "Carrinho aberto manualmente pela equipe. Selecione um produto no menu ou descreva o pedido neste chat.",
      discount ? discountLine(order) : ""
    ].filter(Boolean).join("\n\n"))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${targetUser.id}>`, inline: true },
      { name: "ID da compra", value: id, inline: true },
      { name: "Aberto por", value: `<@${actionUser(context).id}>`, inline: true }
    )
    .setTimestamp();

  await ch.send({
    content: `<@${targetUser.id}>`,
    embeds: [intro, cartEmbed(order, panel)],
    components: [productSelect(panel, `cartadd:${id}`), cartButtons(id)],
    allowedMentions: { users: [targetUser.id] }
  });
  await ch.send({ embeds: [staffChoiceEmbed(order, guild.id)], components: staffChoiceRows(id, false) });

  await sendSafeDM(targetUser.id, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Carrinho criado")
        .setDescription(`A equipe abriu um carrinho para voce.\n\nID da compra: \`${id}\`\nAcesse o canal no servidor: ${ch}`)
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  return actionReply(context, { content: `Carrinho criado para <@${targetUser.id}>: ${ch}`, ephemeral: true });
}
function cartText(order, panel) {
  if (!Array.isArray(order.items) || !order.items.length) return "Carrinho vazio.";
  const discountPercent = orderDiscountPercent(order);
  const base = order.items.map(item => {
    const p = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unit = parsePrice(p.price);
    const subtotal = unit === null
      ? ""
      : discountPercent > 0
        ? ` = ${money(roundCurrency(unit * quantity * (1 - discountPercent / 100)))} (de ${money(roundCurrency(unit * quantity))})`
        : ` = ${money(roundCurrency(unit * quantity))}`;
    return `• ${productIcon(p)} **${p.name}** — ${p.price} x${quantity}${subtotal}`;
  }).join("\n");

  if (Array.isArray(order.mysteryResults) && order.mysteryResults.length) {
    return `${base}

**Caixas abertas:**
${mysteryResultsText(order.mysteryResults)}`;
  }

  return base;
}
function cartEmbed(order, panel) {
  const totals = orderTotals(order, panel);
  const statusLabel = order.status === "open" ? "Aberto" : order.status === "cancelled" ? "Cancelado" : "Fechado";
  const firstImage = (order.items || [])
    .map(item => orderItemDetails(item, panel).imageUrl)
    .find(url => url && validUrl(url));
  const embed = new EmbedBuilder()
    .setTitle(`🛒 Carrinho #${order.id}`)
    .setDescription(cartText(order, panel))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${order.userId}>`, inline: true },
      { name: "Status", value: statusLabel, inline: true },
      { name: "Atendente", value: order.assignedAdminId ? `<@${order.assignedAdminId}>` : "Ainda não assumido", inline: true },
      { name: "Itens", value: String(totals.quantity), inline: true },
      { name: "Total estimado", value: totalLine(order, panel), inline: true }
    )
    .setTimestamp();

  const discountText = discountLine(order);
  if (discountText) embed.addFields({ name: "Desconto", value: discountText, inline: false });
  if (firstImage) embed.setThumbnail(firstImage);
  return embed;
}
function cartButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`call:${orderId}`).setLabel("Chamar ADM").setEmoji("📣").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`view:${orderId}`).setLabel("Ver carrinho").setEmoji("🧾").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`finish:${orderId}`).setLabel("Finalizar compra").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel:${orderId}`).setLabel("Cancelar compra").setEmoji("✖️").setStyle(ButtonStyle.Danger)
  );
}
function commandHelpEmbed(member) {
  const prefix = config.prefix || "!";
  const admin = isAdmin(member);
  const publicCommands = [
    "`/help` ou `!help` - mostra esta lista.",
    "`/rankinggastos` ou `!rankinggastos` - top 10 publico de quem mais gastou.",
    "`/saldogasto` ou `!saldogasto` - mostra seu saldo gasto em modo privado."
  ];
  const setupCommands = [
    "`/configds` ou `!configds` - abre o configurador da loja no canal.",
    "`/setup-atendimento` ou `!atendimento` - cria/atualiza o painel ON/OFF dos ADMs.",
    "`/configpix` ou `!configpix` - configura Pix do ADM.",
    "`/salvarpix` ou `!salvarpix` - salva backup do Pix e painel de atendimento.",
    "`/setup-ticket` - envia o painel de ticket.",
    "`/setupsucess` ou `!setupsucess` - define feed de vendas concluidas e cargo cliente.",
    "`/status-loja` ou `!status-loja` - mostra resumo da loja."
  ];
  const salesCommands = [
    "`/avaliacao` ou `!avaliacao` - finaliza carrinho e pede avaliacao.",
    "`/carrinho cliente:@user` ou `!carrinho @user` - abre carrinho manual.",
    "`/caixapix quantidade:5` ou `!caixapix 5` - sorteia Caixa Pix manual.",
    "`/lock` e `/unlock` ou `!lock` e `!unlock` - trava/libera chat atual.",
    "`/ranking-gastos` ou `!ranking-gastos` - ranking admin paginado por periodo.",
    "`/vendas` ou `!vendas` - ranking privado de vendas por ADM.",
    "`/vendasreset` - reseta vendas dos ADMs para testes.",
    "`/gastos-add` - adiciona saldo gasto manual para cliente.",
    "`/gastos-remover` - remove saldo gasto manual de cliente.",
    "`/gastos-reset` - remove cliente do ranking de gastos."
  ];

  const embed = new EmbedBuilder()
    .setTitle("Comandos da Dragon Store")
    .setDescription("Lista rapida dos comandos disponiveis neste bot.")
    .setColor(0x28f6a1)
    .addFields(
      { name: "Publicos", value: publicCommands.join("\n"), inline: false }
    )
    .setFooter({ text: `Prefixo atual: ${prefix}` })
    .setTimestamp();

  if (admin) {
    embed.addFields(
      { name: "Admin - Setup", value: setupCommands.join("\n"), inline: false },
      { name: "Admin - Vendas", value: salesCommands.join("\n"), inline: false }
    );
  } else {
    embed.addFields({ name: "Administracao", value: "Comandos de admin aparecem aqui apenas para quem tem permissao.", inline: false });
  }

  return embed;
}
async function sendHelpCommand(context) {
  const embed = commandHelpEmbed(context.member);
  const payload = { embeds: [embed], ephemeral: true };
  if (context.isRepliable?.()) return context.reply(payload);
  const sent = await sendSafeDM(context.author.id, { embeds: [embed] });
  if (sent) return context.reply("Enviei a lista de comandos no seu privado.").catch(() => null);
  if (isAdmin(context.member)) return context.reply("Nao consegui mandar DM. Use `/help` para ver os comandos em modo privado.").catch(() => null);
  return context.reply({ embeds: [embed] }).catch(() => null);
}
function buildStoreStatusEmbed(guildId, scopeId = "default") {
  const panel = getPanel(guildId, scopeId);
  const db = readOrders();
  const orders = Object.values(db.orders || {}).filter(order => {
    const sameGuild = !order.guildId || order.guildId === guildId;
    const samePanel = order.panelScopeId ? order.panelScopeId === scopeId : scopeId === "default";
    return sameGuild && samePanel;
  });
  const openOrders = orders.filter(order => order.status === "open");
  const closedOrders = orders.filter(order => order.status === "closed");
  const revenue = closedOrders.reduce((summary, order) => {
    const totals = orderTotals(order, panel);
    summary.amount += totals.amount;
    summary.unknown += totals.unknown;
    return summary;
  }, { amount: 0, unknown: 0 });
  const online = onlineStaffProfiles(guildId);
  const published = panel.publishedChannelId && panel.publishedMessageId
    ? `<#${panel.publishedChannelId}> / \`${panel.publishedMessageId}\``
    : "Nenhum painel publicado salvo";
  const staffLine = online.length
    ? online.map(profile => `🟢 ${profile.displayName || "ADM"} (<@${profile.userId}>)`).join("\n")
    : "Nenhum ADM online agora";
  const revenueLine = revenue.unknown
    ? `${money(revenue.amount)} + ${revenue.unknown} item(ns) sem preço numérico`
    : money(revenue.amount);

  return new EmbedBuilder()
    .setTitle("📊 Status da loja")
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Produtos", value: `${panel.products.length}/25 cadastrados`, inline: true },
      { name: "Carrinhos abertos", value: String(openOrders.length), inline: true },
      { name: "Vendas fechadas", value: String(closedOrders.length), inline: true },
      { name: "Faturamento estimado", value: revenueLine, inline: false },
      { name: "Painel publicado", value: published, inline: false },
      { name: "Atendimento online", value: staffLine.slice(0, 1024), inline: false }
    )
    .setFooter({ text: "Valores são estimativas a partir dos preços cadastrados; pagamento continua manual via Pix." })
    .setTimestamp();
}
async function openCart(interaction) {
  const [, panelId] = interaction.customId.split(":");
  let panel = getPanelById(interaction.guildId, panelId);
  if (!panel || !product(panel, interaction.values[0])) {
    panel = await recoverPanelFromPublishedMessage(
      interaction.message,
      interaction.guildId,
      panel?.scopeId || scopeIdFromPanelId(panelId, interaction.channelId)
    ) || panel;
  }
  if (!panel) return interaction.reply({ content: "Painel antigo. Use `!configds`, clique em **Vincular painel** e cole o link desta mensagem.", ephemeral: true });
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado.", ephemeral: true });
  await resetSelectMessage(interaction, saleMessage(panel));
  const discount = discountForMember(interaction.member);
  const id = orderId("order");
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.cartOpen);
  const order = {
    id,
    guildId: interaction.guildId,
    panelId: panel.id,
    panelScopeId: panel.scopeId || "default",
    status: "open",
    userId: interaction.user.id,
    username: interaction.user.username,
    channelId: ch.id,
    items: [orderItemFromProduct(p)],
    discount,
    assignedAdminId: null,
    assignedAdminName: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    closedAt: null
  };
  const db = readOrders(); db.orders[id] = order; writeOrders(db);
  const intro = new EmbedBuilder().setTitle(`🛒 Carrinho aberto #${id}`).setDescription([config.messages.cartWelcome, discount ? discountLine(order) : ""].filter(Boolean).join("\n\n")).setColor(parseColor(panel.color)).addFields({ name: "Cliente", value: `<@${interaction.user.id}>`, inline: true }, { name: "ID da compra", value: id, inline: true });
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [intro, productInfoEmbed(p, panel, "Produto inicial"), cartEmbed(order, panel)], components: [productSelect(panel, `cartadd:${id}`), cartButtons(id)] });
  await sendStaffChoiceMessage(ch, order, interaction.guildId);

  await sendSafeDM(interaction.user.id, {
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Carrinho criado")
        .setDescription(
          `Seu carrinho foi criado com sucesso!

` +
          `**Produto inicial:** ${productIcon(p)} ${p.name}
` +
          `**Valor:** ${p.price}
` +
          `**Total estimado:** ${totalLine(order, panel)}
` +
          `**ID da compra:** \`${id}\`

` +
          `Acesse o canal do carrinho no servidor para finalizar: ${ch}`
        )
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  return interaction.reply({ content: `Carrinho criado: ${ch}`, ephemeral: true });
}
async function handleQuickBuyButton(interaction, panelId) {
  const panel = getPanelById(interaction.guildId, panelId) ||
    await recoverQuickOrderFromPublishedMessage(interaction.message, interaction.guildId, scopeIdFromPanelId(panelId, interaction.channelId));
  if (!panel) return interaction.reply({ content: "Mensagem de compra antiga. Use `!configds` e publique a mensagem de compra de novo.", ephemeral: true });
  return interaction.showModal(quickOrderBuyModal(panel));
}
function quickOrderAnswersEmbed(order, panel) {
  const quick = order.quickOrder || quickOrderConfig(panel);
  const answers = order.customAnswers || {};
  return new EmbedBuilder()
    .setTitle(`🛍️ Pedido personalizado #${order.id}`)
    .setDescription("Pedido criado pelo botão **Comprar**.")
    .setColor(parseColor(panel.color))
    .addFields(
      { name: quick.question1 || "Nick no roblox", value: String(answers.answer1 || "Não informado").slice(0, 1024), inline: false },
      { name: quick.question2 || "Nome do Set que você deseja comprar", value: String(answers.answer2 || "Não informado").slice(0, 1024), inline: false }
    )
    .setTimestamp();
}
async function handleQuickOrderSubmit(interaction) {
  const [, panelId] = interaction.customId.split(":");
  const panel = getPanelById(interaction.guildId, panelId);
  if (!panel) return interaction.reply({ content: "Mensagem de compra antiga. Peça para um admin publicar de novo.", ephemeral: true });

  const quick = quickOrderConfig(panel);
  const answer1 = interaction.fields.getTextInputValue("answer1").trim();
  const answer2 = interaction.fields.getTextInputValue("answer2").trim();
  const discount = discountForMember(interaction.member);
  const id = orderId("order");
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.cartOpen);
  const order = {
    id,
    guildId: interaction.guildId,
    panelId: panel.id,
    panelScopeId: panel.scopeId || "default",
    status: "open",
    userId: interaction.user.id,
    username: interaction.user.username,
    channelId: ch.id,
    items: [{
      productId: `custom_${id}`,
      quantity: 1,
      name: answer2 || "Pedido personalizado",
      price: "A combinar",
      description: `${quick.question1}: ${answer1}\n${quick.question2}: ${answer2}`,
      stock: "sob demanda",
      type: "custom_order",
      imageUrl: panel.imageUrl || ""
    }],
    discount,
    customAnswers: { answer1, answer2 },
    quickOrder: {
      title: quick.title,
      question1: quick.question1,
      question2: quick.question2
    },
    assignedAdminId: null,
    assignedAdminName: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  const db = readOrders();
  db.orders[id] = order;
  writeOrders(db);

  const intro = new EmbedBuilder()
    .setTitle(`🛒 Carrinho aberto #${id}`)
    .setDescription([config.messages.cartWelcome, discount ? discountLine(order) : ""].filter(Boolean).join("\n\n"))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${interaction.user.id}>`, inline: true },
      { name: "ID da compra", value: id, inline: true }
    );

  await ch.send({
    content: `<@${interaction.user.id}>`,
    embeds: [intro, quickOrderAnswersEmbed(order, panel), cartEmbed(order, panel)],
    components: [productSelect(panel, `cartadd:${id}`), cartButtons(id)]
  });
  await sendStaffChoiceMessage(ch, order, interaction.guildId);

  await sendSafeDM(interaction.user.id, {
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Carrinho criado")
        .setDescription(
          `Seu carrinho foi criado com sucesso!\n\n` +
          `**${quick.question1}:** ${answer1}\n` +
          `**${quick.question2}:** ${answer2}\n` +
          `**ID da compra:** \`${id}\`\n\n` +
          `Acesse o canal do carrinho no servidor para continuar: ${ch}`
        )
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  return interaction.reply({ content: `Carrinho criado: ${ch}`, ephemeral: true });
}
async function addCart(interaction) {
  const [, id] = interaction.customId.split(":");
  const db = readOrders(); const order = orderForAction(db, id, interaction);
  if (!order || order.status !== "open") return actionReply(interaction, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Você não pode alterar esse carrinho.", ephemeral: true });
  const panel = getOrderPanel(order, actionGuildId(interaction)); const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado.", ephemeral: true });
  await resetSelectMessage(interaction, { components: [productSelect(panel, `cartadd:${order.id}`), cartButtons(order.id)] });
  const item = order.items.find(i => i.productId === p.id);
  if (item) item.quantity += 1; else order.items.push(orderItemFromProduct(p));
  db.orders[order.id] = order; writeOrders(db);
  await interaction.reply({ content: `Adicionado: ${productIcon(p)} **${p.name}** — ${p.price}`, ephemeral: true });
  return interaction.channel.send({ embeds: [productInfoEmbed(p, panel, "Produto adicionado"), cartEmbed(order, panel)] });
}
async function callAdmin(interaction, id, type = "order") {
  const db = readOrders(); const record = type === "ticket" ? db.tickets[id] : orderForAction(db, id, interaction);
  if (!record || record.status !== "open") return interaction.reply({ content: "Canal fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== record.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });

  const remaining = adminCallCooldownRemaining(record);
  if (remaining > 0) {
    return interaction.reply({ content: `Aguarde ${remaining}s para chamar ADM de novo.`, ephemeral: true });
  }

  record.lastAdminCallAt = new Date().toISOString();
  if (type === "ticket") db.tickets[record.id || id] = record;
  else db.orders[record.id] = record;
  writeOrders(db);

  await interaction.channel.send({ content: `<@&${config.adminRoleId}> ${config.messages.adminCall}\nID: **${record.id || id}** | Cliente: <@${record.userId}>` });
  return interaction.reply({ content: "ADM chamado.", ephemeral: true });
}
async function viewCart(interaction, id) {
  const db = readOrders(); const order = orderForAction(db, id, interaction, false);
  if (!order) return interaction.reply({ content: "Carrinho não encontrado.", ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });
  return interaction.reply({ embeds: [cartEmbed(order, getOrderPanel(order, actionGuildId(interaction)))], ephemeral: true });
}
function actionUser(context) {
  return context.user || context.author;
}
function actionGuildId(context) {
  return context.guildId || context.guild?.id;
}
function stripEphemeral(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const { ephemeral, ...rest } = payload;
  return rest;
}
async function actionReply(context, payload) {
  if (context.isRepliable?.()) return context.reply(payload);
  return context.channel.send(stripEphemeral(payload));
}
function openOrderByChannel(guildId, channelId) {
  const db = readOrders();
  return Object.values(db.orders || {}).find(order =>
    order.guildId === guildId &&
    order.channelId === channelId &&
    order.status === "open"
  ) || null;
}
function ticketByChannel(db, guildId, channelId, openOnly = true) {
  return Object.values(db.tickets || {}).find(ticket =>
    (!ticket.guildId || ticket.guildId === guildId) &&
    ticket.channelId === channelId &&
    (!openOnly || ticket.status === "open")
  ) || null;
}
async function setChannelLock(context, locked) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode travar ou liberar chat.", ephemeral: true });
  }

  const guildId = actionGuildId(context);
  const channel = context.channel;
  if (!channel?.permissionOverwrites?.edit) {
    return actionReply(context, { content: "Nao consigo alterar permissoes neste canal.", ephemeral: true });
  }

  const db = readOrders();
  const order = findOrderInChannel(db, context, false);
  const ticket = ticketByChannel(db, guildId, channel.id, false);
  const record = order || ticket;
  const targetId = record?.userId || "";
  const actor = actionUser(context);
  const now = new Date().toISOString();

  if (targetId) {
    await channel.permissionOverwrites.edit(targetId, {
      ViewChannel: true,
      SendMessages: locked ? false : true,
      ReadMessageHistory: true,
      AttachFiles: locked ? false : true
    }, { reason: `${locked ? "Lock" : "Unlock"} por ${actor.username || actor.id}` });

    record.lockedAt = locked ? now : null;
    record.lockedById = locked ? actor.id : null;
    if (order) db.orders[order.id] = record;
    else db.tickets[record.id] = record;
    writeOrders(db);
  } else {
    await channel.permissionOverwrites.edit(context.guild.id, {
      SendMessages: locked ? false : null
    }, { reason: `${locked ? "Lock" : "Unlock"} por ${actor.username || actor.id}` });
  }

  const text = locked
    ? targetId ? `Chat travado para <@${targetId}>.` : "Chat travado para @everyone."
    : targetId ? `Chat liberado para <@${targetId}>.` : "Chat liberado.";
  return actionReply(context, { content: text, ephemeral: true });
}
function normalizeChannelId(value) {
  const raw = String(value || "").trim();
  return raw.match(/\d{15,25}/)?.[0] || "";
}
function reviewConfig(options = {}) {
  const channelId = normalizeChannelId(options.reviewChannelId || config.review?.channelId || process.env.REVIEW_CHANNEL_ID || "");
  return {
    channelId,
    message: clampText(options.reviewMessage || config.review?.message || "Obrigado pela compra! Se possivel, deixe uma avaliacao no chat {channel}.", 1000),
    channelPingMessage: clampText(config.review?.channelPingMessage || "Obrigado pela compra! Deixe sua avaliacao aqui quando puder.", 500),
    deletePingAfterSeconds: Math.max(1, Number(config.review?.deletePingAfterSeconds ?? 10) || 10)
  };
}
function reviewMessageText(order, review) {
  const channelText = review.channelId ? `<#${review.channelId}>` : "canal de avaliacoes";
  return review.message
    .replaceAll("{cliente}", `<@${order.userId}>`)
    .replaceAll("{channel}", channelText)
    .replaceAll("{canal}", channelText)
    .replaceAll("{id}", order.id);
}
function reviewOptionsFromText(rawContent) {
  const args = String(rawContent || "").trim().split(/\s+/).slice(1).join(" ").trim();
  const channelId = normalizeChannelId(args);
  const reviewMessage = channelId
    ? args.replace(/<#\d{15,25}>|\d{15,25}/, "").trim()
    : args;

  return {
    reviewChannelId: channelId,
    reviewMessage
  };
}
async function sendReviewRequest(context, order, options = {}) {
  const review = reviewConfig(options);
  const text = reviewMessageText(order, review);
  await context.channel.send({
    content: `<@${order.userId}> ${text}`,
    allowedMentions: { users: [order.userId] }
  }).catch(() => null);

  if (!review.channelId) return { ok: false, message: "Canal de avaliacoes nao configurado." };
  const channel = await context.guild.channels.fetch(review.channelId).catch(() => null);
  if (!channel?.isTextBased()) return { ok: false, message: "Canal de avaliacoes invalido." };

  const ping = await channel.send({
    content: `<@${order.userId}> ${review.channelPingMessage}`,
    allowedMentions: { users: [order.userId] }
  }).catch(() => null);
  if (ping) setTimeout(() => ping.delete().catch(() => null), review.deletePingAfterSeconds * 1000);
  return { ok: true, message: `Pedido de avaliacao enviado em <#${review.channelId}>.` };
}
async function finishCurrentCartWithReview(context, options = {}) {
  const guildId = actionGuildId(context);
  const order = openOrderByChannel(guildId, context.channel.id);
  if (!order) {
    return actionReply(context, { content: "Nao encontrei carrinho aberto neste canal.", ephemeral: true });
  }
  return finishCart(context, order.id, { ...options, requestReview: true });
}
async function cancelCart(interaction, id) {
  const actor = actionUser(interaction);
  const guildId = actionGuildId(interaction);
  const db = readOrders(); const order = orderForAction(db, id, interaction);
  if (!order || order.status !== "open") return actionReply(interaction, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (actor.id !== order.userId && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Sem permissao para cancelar esse carrinho.", ephemeral: true });

  const panel = getOrderPanel(order, guildId);
  const now = new Date().toISOString();
  order.status = "cancelled";
  order.cancelledAt = now;
  order.closedAt = now;
  order.cancelledById = actor.id;
  order.cancelledByName = interaction.member?.displayName || actor.username;
  order.channelDeletedAt = now;
  db.orders[order.id] = order;
  writeOrders(db);
  await sendCancellationNotice(interaction.guild, order, panel, actor).catch(error => {
    console.log(`Nao consegui enviar aviso de cancelamento ${order.id}: ${error.message}`);
  });

  await sendSafeDM(order.userId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Compra cancelada")
        .setDescription(`O carrinho #${order.id} foi cancelado.\n\nResumo:\n${cartText(order, panel)}`.slice(0, 4096))
        .setColor(0xff5c7a)
        .setTimestamp()
    ]
  });

  await actionReply(interaction, { content: `Carrinho #${order.id} cancelado. Apagando este chat agora.`, ephemeral: true });
  setTimeout(() => interaction.channel.delete(`Carrinho ${order.id} cancelado`).catch(error => {
    console.log(`Nao consegui apagar carrinho cancelado ${order.id}: ${error.message}`);
  }), 1500);
}
async function finishCart(interaction, id, options = {}) {
  const actor = actionUser(interaction);
  const guildId = actionGuildId(interaction);
  const db = readOrders(); const order = orderForAction(db, id, interaction);
  if (!order || order.status !== "open") return actionReply(interaction, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (config.settings.finalizeCartOnlyAdmins && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Só admin finaliza. Clique em **Chamar ADM**.", ephemeral: true });
  if (!Array.isArray(order.items) || !order.items.length) {
    return actionReply(interaction, { content: "Esse carrinho ainda esta vazio. Adicione um produto antes de finalizar.", ephemeral: true });
  }
  const panel = getOrderPanel(order, guildId);
  const mysteryResults = Array.isArray(order.mysteryResults) && order.mysteryResults.length
    ? order.mysteryResults
    : rollMysteryBoxes(order, panel);
  if (mysteryResults.length) order.mysteryResults = mysteryResults;
  order.status = "closed";
  order.closedAt = new Date().toISOString();
  order.closedByAdminId = actor.id;
  order.closedByAdminName = interaction.member?.displayName || actor.username;
  recordCustomerSpend(db, order, panel);
  db.orders[order.id] = order;
  writeOrders(db);
  await interaction.channel.setName(interaction.channel.name.includes("aberto") ? interaction.channel.name.replace("aberto", "fechado") : `carrinho-${safeName(order.username)}-fechado-${order.id}`).catch(() => null);
  if (config.categories.closed) await interaction.channel.setParent(config.categories.closed, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  const roleGranted = await grantCustomerRole(interaction.guild, order.userId);
  await sendCompletionReceipt(interaction.guild, order, panel).catch(error => console.log(`Nao consegui enviar recibo da venda ${order.id}: ${error.message}`));
  await sendSuccessFeed(interaction.guild, order, panel).catch(error => console.log(`Nao consegui enviar feed da venda ${order.id}: ${error.message}`));
  scheduleCartDeletion(order);
  const thanks = config.messages.purchaseThanks.replaceAll("{id}", order.id);
  const extraEmbed = mysteryResultsEmbed(mysteryResults, panel);
  const reviewResult = options.requestReview
    ? await sendReviewRequest(interaction, order, options).catch(error => ({ ok: false, message: `Nao consegui enviar avaliacao: ${error.message}` }))
    : null;
  await interaction.channel.send({ content: `<@${order.userId}> ${thanks}\nEste canal sera apagado automaticamente em 3 dias.`, embeds: [cartEmbed(order, panel), extraEmbed].filter(Boolean) });

  await sendSafeDM(order.userId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Compra finalizada")
        .setDescription(`${thanks}

**Resumo da compra:**
Total estimado: **${totalLine(order, panel)}**
${discountLine(order) ? `\n${discountLine(order)}` : ""}

${cartText(order, panel)}`.slice(0, 4096))
        .setColor(parseColor(panel.color))
        .setTimestamp(),
      extraEmbed
    ].filter(Boolean)
  });

  const reviewText = reviewResult ? ` ${reviewResult.message}` : "";
  const roleText = roleGranted ? "" : " Nao consegui aplicar o cargo cliente; confira se o cargo do bot esta acima do cargo cliente.";
  return actionReply(interaction, { content: mysteryResults.length ? `Compra #${order.id} finalizada e caixa surpresa sorteada.${reviewText}${roleText}` : `Compra #${order.id} finalizada.${reviewText}${roleText}`, ephemeral: true });
}

function ticketPanelEmbed() { return new EmbedBuilder().setTitle(config.ticketPanel.title).setDescription(config.ticketPanel.description).setColor(parseColor(config.ticketPanel.embedColor, 0x2b2d31)); }
async function setupTicket(interaction) {
  if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para enviar o painel de ticket.")) return;
  const ch = await interaction.guild.channels.fetch(config.ticketPanel.channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return interaction.reply({ content: "Canal de ticket inválido no config.json.", ephemeral: true });
  const btn = new ButtonBuilder().setCustomId("openticket").setLabel(config.ticketPanel.buttonLabel).setEmoji(config.ticketPanel.buttonEmoji).setStyle(ButtonStyle.Primary);
  await ch.send({ embeds: [ticketPanelEmbed()], components: [new ActionRowBuilder().addComponents(btn)] });
  return interaction.reply({ content: `Painel de ticket enviado em <#${ch.id}>.`, ephemeral: true });
}
async function openTicket(interaction) {
  const id = orderId("ticket");
  const ch = await privateChannel(interaction.guild, interaction.user, `ticket-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.ticketOpen || config.categories.cartOpen);
  const db = readOrders(); db.tickets[id] = { id, status: "open", userId: interaction.user.id, username: interaction.user.username, channelId: ch.id, createdAt: new Date().toISOString(), closedAt: null }; writeOrders(db);
  const embed = new EmbedBuilder().setTitle(`🎫 Ticket #${id}`).setDescription(config.messages.ticketWelcome).setColor(0x2b2d31).addFields({ name: "Cliente", value: `<@${interaction.user.id}>`, inline: true });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tcall:${id}`).setLabel("Chamar ADM").setEmoji("📣").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`tclose:${id}`).setLabel("Fechar ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger));
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
  return interaction.reply({ content: `Ticket criado: ${ch}`, ephemeral: true });
}
async function closeTicket(interaction, id) {
  const db = readOrders(); const ticket = db.tickets[id];
  if (!ticket || ticket.status !== "open") return interaction.reply({ content: "Ticket fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== ticket.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });
  ticket.status = "closed"; ticket.closedAt = new Date().toISOString(); db.tickets[id] = ticket; writeOrders(db);
  const seconds = Number(config.settings.deleteTicketAfterCloseSeconds ?? 5);
  await interaction.reply({ content: `Ticket fechado. Apagando em ${seconds}s.` });
  setTimeout(() => interaction.channel.delete(`Ticket ${id} fechado`).catch(() => null), Math.max(1, seconds) * 1000);
}
async function handlePendingImageUpload(message) {
  const key = imageUploadKey(message.guild.id, message.channel.id, message.author.id);
  const pending = imageUploads.get(key);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    imageUploads.delete(key);
    await message.reply("O tempo para enviar a imagem expirou. Clique no botão de envio de imagem de novo.").catch(() => null);
    return false;
  }

  if (!isAdmin(message.member)) {
    imageUploads.delete(key);
    await message.reply("Só ADM pode salvar imagem no painel da loja.").catch(() => null);
    return true;
  }

  const attachment = message.attachments.find(isImageAttachment);
  if (!attachment) {
    if (message.attachments.size) {
      await message.reply("Recebi um anexo, mas ele não parece ser imagem. Envie PNG, JPG, WEBP ou GIF.").catch(() => null);
      return true;
    }
    return false;
  }

  const s = sessions.get(pending.sessionId);
  if (!s) {
    imageUploads.delete(key);
    await message.reply("A sessão do configurador expirou. Abra `/configds` de novo.").catch(() => null);
    return true;
  }

  const panel = getPanel(s.guildId, s.scopeId);
  const label = imageUploadTargetLabel(pending, panel);
  const savedImage = await saveAttachmentAsDiscordImage(message.channel, attachment, label);

  if (pending.target === "panelImage") {
    panel.imageUrl = savedImage.url;
  } else if (pending.target === "panelThumb") {
    panel.thumbnailUrl = savedImage.url;
  } else if (pending.target === "product") {
    const p = product(panel, pending.productId);
    if (!p) {
      imageUploads.delete(key);
      await message.reply("Não achei mais esse produto. Reabra o configurador e tente de novo.").catch(() => null);
      return true;
    }
    p.imageUrl = savedImage.url;
  }

  savePanel(s.guildId, panel, s.scopeId);
  imageUploads.delete(key);
  await refreshConfig(pending.sessionId);

  const publishedUpdated = ["panelImage", "panelThumb"].includes(pending.target)
    ? await updatePublishedPanel(message.guild, panel)
    : false;
  const quickUpdated = ["panelImage", "panelThumb"].includes(pending.target)
    ? await updatePublishedQuickOrder(message.guild, panel)
    : false;
  const publishedText = [
    publishedUpdated ? "Painel publicado atualizado também." : "",
    quickUpdated ? "Mensagem de compra publicada atualizada também." : ""
  ].filter(Boolean).join("\n");

  await message.reply(`Imagem salva como **${label}**.\n${savedImage.note}${publishedText ? `\n${publishedText}` : ""}`).catch(() => null);
  return true;
}

client.once("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await ensureStaffState(guild, null).catch(error => {
      console.log(`Nao consegui recuperar atendimento em ${guild.id}: ${error.message}`);
    });
    await refreshStaffPanel(guild.id).catch(() => null);
  }
  scheduleExistingClosedCarts();
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (await handlePendingImageUpload(message)) return;
  const rawContent = message.content.trim();
  const content = rawContent.toLowerCase();
  const plainContent = content.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (content === `${config.prefix || "!"}help`) {
    return sendHelpCommand(message);
  }

  if (content === `${config.prefix || "!"}configds`) {
    await message.delete().catch(() => null);
    return startConfig(message.channel, message.member, message.author);
  }

  if (content === `${config.prefix || "!"}atendimento`) {
    await message.delete().catch(() => null);
    return setupStaffPanel(message);
  }

  if (content === `${config.prefix || "!"}salvarpix`) {
    await message.delete().catch(() => null);
    return savePixBackupCommand(message);
  }

  if (content.startsWith(`${config.prefix || "!"}caixapix`)) {
    const args = rawContent.trim().split(/\s+/).slice(1);
    const quantity = Number(args.find(arg => /^\d{1,3}$/.test(arg)) || 1);
    const targetUser = message.mentions.users.first() || null;
    await message.delete().catch(() => null);
    return runPixBoxCommand(message, quantity, targetUser);
  }

  if (content.startsWith(`${config.prefix || "!"}carrinho`)) {
    const userId = rawContent.match(/\d{15,25}/)?.[0] || "";
    const targetUser = message.mentions.users.first() || (userId ? await client.users.fetch(userId).catch(() => null) : null);
    await message.delete().catch(() => null);
    return openManualCartCommand(message, targetUser);
  }

  if (content === `${config.prefix || "!"}lock`) {
    await message.delete().catch(() => null);
    return setChannelLock(message, true);
  }

  if (content === `${config.prefix || "!"}unlock`) {
    await message.delete().catch(() => null);
    return setChannelLock(message, false);
  }

  if (content.startsWith(`${config.prefix || "!"}setupsucess`)) {
    await message.delete().catch(() => null);
    const enabled = !/\b(off|false|desativar|desligar)\b/.test(content);
    return setupSuccessFeed(message, { enabled });
  }

  if (plainContent.startsWith(`${config.prefix || "!"}avaliacao`)) {
    if (!isAdmin(message.member)) return message.reply("So ADM pode finalizar compra com pedido de avaliacao.");
    const options = reviewOptionsFromText(rawContent);
    await message.delete().catch(() => null);
    return finishCurrentCartWithReview(message, options);
  }

  if (content === `${config.prefix || "!"}configpix`) {
    if (!isAdmin(message.member)) return message.reply("Só ADM pode configurar Pix.");
    await message.delete().catch(() => null);
    const reply = await message.channel.send({
      content: `<@${message.author.id}> clique no botão abaixo para abrir o formulário do Pix. Se o Discord não mostrar os comandos com \`/\`, esse botão resolve.`,
      components: pixShortcutRows()
    });
    setTimeout(() => reply.delete().catch(() => null), 2 * 60 * 1000);
    return;
  }

  if (content === `${config.prefix || "!"}status-loja`) {
    if (!isAdmin(message.member)) return message.reply("Só ADM pode ver o status da loja.");
    await message.delete().catch(() => null);
    const sent = await sendSafeDM(message.author.id, { embeds: [buildStoreStatusEmbed(message.guild.id, message.channel.id)] });
    return message.channel.send(sent
      ? `<@${message.author.id}> enviei o status da loja no seu privado.`
      : `<@${message.author.id}> não consegui mandar DM. Use \`/status-loja\` para ver em modo privado.`);
  }
  if (content === `${config.prefix || "!"}ranking-gastos`) {
    return sendSpendRankingMessage(message);
  }
  if (content === `${config.prefix || "!"}rankinggastos`) {
    return message.channel.send({ embeds: [publicSpendRankingEmbed(message.guild.id)] });
  }
  if (content === `${config.prefix || "!"}saldogasto`) {
    return message.reply({ embeds: [spendBalanceEmbed(message.guild.id, message.author)] });
  }
  if (content === `${config.prefix || "!"}vendas`) {
    if (!isAdmin(message.member)) return message.reply("So ADM pode ver vendas por atendente.");
    await message.delete().catch(() => null);
    return message.channel.send({ embeds: [sellerRankingEmbed(message.guild.id)] });
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "help") return sendHelpCommand(interaction);
      if (interaction.commandName === "configds") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para abrir o configurador da loja.")) return;
        await interaction.reply({ content: "Abri o configurador neste canal.", ephemeral: true });
        return startConfig(interaction.channel, interaction.member, interaction.user);
      }
      if (interaction.commandName === "setup-ticket") return setupTicket(interaction);
      if (interaction.commandName === "setup-atendimento") return setupStaffPanel(interaction);
      if (interaction.commandName === "salvarpix") return savePixBackupCommand(interaction);
      if (interaction.commandName === "caixapix") {
        return runPixBoxCommand(
          interaction,
          interaction.options.getInteger("quantidade") || 1,
          interaction.options.getUser("cliente")
        );
      }
      if (interaction.commandName === "carrinho") return openManualCartCommand(interaction, interaction.options.getUser("cliente"));
      if (interaction.commandName === "lock") return setChannelLock(interaction, true);
      if (interaction.commandName === "unlock") return setChannelLock(interaction, false);
      if (interaction.commandName === "setupsucess") {
        const enabled = interaction.options.getBoolean("ativo") ?? true;
        const role = interaction.options.getRole("cargo-cliente");
        return setupSuccessFeed(interaction, { enabled, customerRoleId: role?.id || "" });
      }
      if (interaction.commandName === "avaliacao") {
        const reviewChannel = interaction.options.getChannel("canal");
        const reviewMessage = interaction.options.getString("mensagem") || "";
        return finishCurrentCartWithReview(interaction, {
          reviewChannelId: reviewChannel?.id || "",
          reviewMessage
        });
      }
      if (interaction.commandName === "configpix") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para configurar Pix.")) return;
        await ensureStaffState(interaction.guild, interaction.channel);
        return interaction.showModal(pixConfigModal(interaction.guildId, interaction.user));
      }
      if (interaction.commandName === "status-loja") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para ver o status da loja.")) return;
        return interaction.reply({ embeds: [buildStoreStatusEmbed(interaction.guildId, interaction.channelId)], ephemeral: true });
      }
      if (interaction.commandName === "ranking-gastos") return showSpendRanking(interaction);
      if (interaction.commandName === "rankinggastos") return showPublicSpendRanking(interaction);
      if (interaction.commandName === "saldogasto") return showSpendBalance(interaction);
      if (interaction.commandName === "vendas") return showSellerSales(interaction);
      if (interaction.commandName === "vendasreset") return resetSellerSales(interaction);
      if (interaction.commandName === "gastos-add") return adjustSpendCommand(interaction, "add");
      if (interaction.commandName === "gastos-remover") return adjustSpendCommand(interaction, "remove");
      if (interaction.commandName === "gastos-reset") return resetSpendCommand(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("rmconfirm:")) return handleRemoveConfirm(interaction);
      if (interaction.customId.startsWith("rmcancel:")) return handleRemoveCancel(interaction);
      if (interaction.customId.startsWith("cfg:")) return handleConfigButton(interaction);
      if (interaction.customId.startsWith("staff:")) return handleStaffButton(interaction);
      if (interaction.customId.startsWith("rank:")) {
        const [, period, page] = interaction.customId.split(":");
        return showSpendRanking(interaction, period, Number(page) || 0);
      }
      if (interaction.customId.startsWith("quickbuy:")) {
        const [, panelId] = interaction.customId.split(":");
        return handleQuickBuyButton(interaction, panelId);
      }
      if (interaction.customId === "openticket") return openTicket(interaction);
      const [act, id] = interaction.customId.split(":");
      if (act === "call") return callAdmin(interaction, id, "order");
      if (act === "view") return viewCart(interaction, id);
      if (act === "finish") return finishCart(interaction, id);
      if (act === "cancel") return cancelCart(interaction, id);
      if (act === "assume") return assumeOrder(interaction, id);
      if (act === "sendpix") return resendPix(interaction, id);
      if (act === "tcall") return callAdmin(interaction, id, "ticket");
      if (act === "tclose") return closeTicket(interaction, id);
    }
    if (interaction.isModalSubmit() && interaction.customId === "pixmodal") return handlePixModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("quickmodal:")) return handleQuickOrderSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal:")) return handleModal(interaction);
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("preset:")) return handlePresetSelect(interaction);
      if (interaction.customId.startsWith("remove:")) return handleRemove(interaction);
      if (interaction.customId.startsWith("edit:")) return handleEditProduct(interaction);
      if (interaction.customId.startsWith("uploadpanel:")) return handlePanelImageUploadTarget(interaction);
      if (interaction.customId.startsWith("uploadproduct:")) return handleProductImageUploadTarget(interaction);
      if (interaction.customId.startsWith("reward:")) return handleRewardProduct(interaction);
      if (interaction.customId.startsWith("buy:")) return openCart(interaction);
      if (interaction.customId.startsWith("cartadd:")) return addCart(interaction);
    }
  } catch (err) {
    console.error(err);
    const payload = { content: `Erro: \`${err.message}\``, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("DISCORD_TOKEN não configurado.");
  process.exit(1);
}
async function boot() {
  await hydratePersistentFiles();
  await client.login(token);
}
boot().catch(error => {
  console.error("Falha ao iniciar bot:", error);
  process.exit(1);
});
