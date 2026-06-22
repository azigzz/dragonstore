require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");
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
const DEFAULT_STATUS_VOICE_CHANNEL_ID = "1515799363857809494";
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
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "";
const BOT_DB_PREFIX = process.env.BOT_DB_PREFIX || BOT_KV_PREFIX;
const KV_FILE_KEYS = {
  [PANELS_FILE]: `${BOT_KV_PREFIX}:panels`,
  [ORDERS_FILE]: `${BOT_KV_PREFIX}:orders`,
  [STAFF_FILE]: `${BOT_KV_PREFIX}:staff`
};
const DB_FILE_KEYS = {
  [PANELS_FILE]: `${BOT_DB_PREFIX}:panels`,
  [ORDERS_FILE]: `${BOT_DB_PREFIX}:orders`,
  [STAFF_FILE]: `${BOT_DB_PREFIX}:staff`
};
const memoryJsonStore = new Map();
const kvWriteQueues = new Map();
const postgresWriteQueues = new Map();
let postgresPool = null;
let postgresStoreReady = false;

process.on("unhandledRejection", error => {
  console.error("Erro async nao tratado:", error);
});
process.on("uncaughtException", error => {
  console.error("Erro fatal nao tratado:", error);
  drainPersistentWriteQueues().finally(() => closePostgresPool()).finally(() => process.exit(1));
});

ensureDataDir();
ensureJsonFile(PANELS_FILE, { guilds: {} });
ensureJsonFile(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {}, auditLogs: [] });
ensureJsonFile(STAFF_FILE, { guilds: {} });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates]
});
client.on("error", error => {
  console.error("Erro do client Discord:", error);
});
client.on("shardError", error => {
  console.error("Erro de shard Discord:", error);
});

const sessions = new Map();
const addCartSessions = new Map();
const imageUploads = new Map();
const paymentProofUploads = new Map();
const cartDeleteTimers = new Map();
const publicPanelScanCache = new Map();
const orderActionLocks = new Set();
let statusVoiceReconnectTimer = null;
const IMAGE_UPLOAD_TTL_MS = 3 * 60 * 1000;
const PROOF_UPLOAD_TTL_MS = 2 * 60 * 1000;
const MAX_SAVED_IMAGE_BYTES = 8 * 1024 * 1024;
const ADD_CART_SESSION_TTL_MS = 10 * 60 * 1000;

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  enqueuePersistJsonToKv(file, data).catch(error => {
    console.log(`Nao consegui salvar ${path.basename(file)} no KV: ${error.message}`);
  });
  enqueuePersistJsonToPostgres(file, data).catch(error => {
    console.log(`Nao consegui salvar ${path.basename(file)} no Postgres: ${error.message}`);
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
function enqueuePersistJsonToKv(file, data) {
  const key = KV_FILE_KEYS[file];
  if (!key || !kvEnabled()) return Promise.resolve(false);

  const snapshot = cloneJson(data);
  const previous = kvWriteQueues.get(file) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(() => persistJsonToKv(file, snapshot));
  const tracked = next.finally(() => {
    if (kvWriteQueues.get(file) === tracked) kvWriteQueues.delete(file);
  });
  kvWriteQueues.set(file, tracked);
  return tracked;
}
function postgresEnabled() {
  return Boolean(DATABASE_URL);
}
function postgresSsl() {
  return process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false };
}
function getPostgresPool() {
  if (!postgresEnabled()) return null;
  if (!postgresPool) postgresPool = new Pool({ connectionString: DATABASE_URL, ssl: postgresSsl() });
  return postgresPool;
}
async function ensurePostgresStore() {
  if (!postgresEnabled()) return false;
  if (postgresStoreReady) return true;
  const pool = getPostgresPool();
  const schemaPath = path.join(__dirname, "..", "database", "postgres-schema.sql");
  if (fs.existsSync(schemaPath)) {
    await pool.query(fs.readFileSync(schemaPath, "utf8"));
  } else {
    await pool.query(`
      create table if not exists bot_json_store (
        key text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
  }
  postgresStoreReady = true;
  return true;
}
async function readJsonFromPostgres(file) {
  const key = DB_FILE_KEYS[file];
  if (!key || !await ensurePostgresStore()) return null;
  const result = await getPostgresPool().query("select payload from bot_json_store where key = $1", [key]);
  return result.rows[0]?.payload || null;
}
async function writeJsonToPostgres(file, data) {
  const key = DB_FILE_KEYS[file];
  if (!key || !await ensurePostgresStore()) return false;
  await getPostgresPool().query(`
    insert into bot_json_store (key, payload, updated_at)
    values ($1, $2::jsonb, now())
    on conflict (key) do update set payload = excluded.payload, updated_at = now()
  `, [key, JSON.stringify(data)]);
  return true;
}
function enqueuePersistJsonToPostgres(file, data) {
  const key = DB_FILE_KEYS[file];
  if (!key || !postgresEnabled()) return Promise.resolve(false);

  const snapshot = cloneJson(data);
  const previous = postgresWriteQueues.get(file) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(() => writeJsonToPostgres(file, snapshot));
  const tracked = next.finally(() => {
    if (postgresWriteQueues.get(file) === tracked) postgresWriteQueues.delete(file);
  });
  postgresWriteQueues.set(file, tracked);
  return tracked;
}
async function hydrateJsonFromPostgres(file, fallback) {
  const key = DB_FILE_KEYS[file];
  if (!key || !postgresEnabled()) return false;
  const remote = await readJsonFromPostgres(file).catch(error => {
    console.log(`Nao consegui carregar ${path.basename(file)} do Postgres: ${error.message}`);
    return null;
  });
  if (!hasUsefulPersistedData(file, remote)) return false;
  const data = remote || fallback;
  try {
    writeJsonLocal(file, data);
    console.log(`${path.basename(file)} carregado do Postgres.`);
  } catch (error) {
    rememberJson(file, data);
    console.log(`${path.basename(file)} carregado do Postgres em memoria (${error.message}).`);
  }
  return true;
}
async function drainPersistentWriteQueues(timeoutMs = 5000) {
  const writes = [...kvWriteQueues.values(), ...postgresWriteQueues.values()];
  if (!writes.length) return;
  await Promise.race([
    Promise.allSettled(writes),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}
async function closePostgresPool() {
  if (!postgresPool) return;
  await postgresPool.end().catch(() => null);
  postgresPool = null;
  postgresStoreReady = false;
}
async function hydratePersistentFiles() {
  const files = [
    [PANELS_FILE, { guilds: {} }],
    [ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {}, auditLogs: [] }],
    [STAFF_FILE, { guilds: {} }]
  ];
  const hydrated = new Set();

  if (postgresEnabled()) {
    await ensurePostgresStore()
      .then(() => console.log(`Postgres ativo para persistencia do bot (${BOT_DB_PREFIX}).`))
      .catch(error => console.log(`Postgres configurado, mas indisponivel agora: ${error.message}`));

    for (const [file, fallback] of files) {
      if (await hydrateJsonFromPostgres(file, fallback)) hydrated.add(file);
    }
  }

  if (kvEnabled()) {
    for (const [file, fallback] of files) {
      if (!hydrated.has(file)) await hydrateJsonFromKv(file, fallback);
    }
  }

  if (!postgresEnabled() && !kvEnabled()) {
    console.log("Postgres/KV do bot nao configurados; usando JSON local para paineis, pedidos e Pix.");
  }
}
async function flushPersistentFile(file) {
  const data = readJson(file, {});
  const results = await Promise.allSettled([
    enqueuePersistJsonToKv(file, data),
    enqueuePersistJsonToPostgres(file, data)
  ]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}
function dbText(value, fallback = "") {
  return String(value ?? fallback).trim();
}
function dbJson(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}
function dbCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}
function dbStatus(status) {
  const value = dbText(status, ORDER_STATUS.OPEN).toLowerCase();
  if (value === ORDER_STATUS.CANCELED) return ORDER_STATUS.CANCELLED;
  if ([ORDER_STATUS.OPEN, ORDER_STATUS.PROCESSING, ORDER_STATUS.CLOSED, ORDER_STATUS.CANCELLED, "expired"].includes(value)) return value;
  return ORDER_STATUS.OPEN;
}
function dbProductId(panelId, productId) {
  const cleanPanelId = dbText(panelId);
  const cleanProductId = dbText(productId);
  if (!cleanProductId) return null;
  return cleanPanelId ? `${cleanPanelId}:${cleanProductId}`.slice(0, 240) : cleanProductId.slice(0, 240);
}
function stockQuantityFromLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || /inf|ilimit|sob|consulta|demanda/.test(raw)) return null;
  const match = raw.match(/\d{1,9}/);
  if (!match) return null;
  const quantity = Number.parseInt(match[0], 10);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : null;
}
function formatStockLabel(quantity, previous = "") {
  if (quantity === null || quantity === undefined) return previous || "infinito";
  return String(Math.max(0, Number(quantity) || 0));
}
function productHasStock(productItem, quantity = 1) {
  const stock = stockQuantityFromLabel(productItem?.stock);
  return stock === null || stock >= Math.max(1, Number(quantity) || 1);
}
function stockUnavailableMessage(productItem, quantity = 1) {
  const stock = stockQuantityFromLabel(productItem?.stock);
  if (stock === null) return "";
  const wanted = Math.max(1, Number(quantity) || 1);
  return stock <= 0
    ? `**${productItem?.name || "Produto"}** esta sem estoque.`
    : `**${productItem?.name || "Produto"}** tem apenas ${stock} em estoque, mas foram pedidos ${wanted}.`;
}
async function withPostgresClient(callback) {
  if (!postgresEnabled()) return null;
  await ensurePostgresStore();
  const dbClient = await getPostgresPool().connect();
  try {
    return await callback(dbClient);
  } finally {
    dbClient.release();
  }
}
async function withPostgresTransaction(callback) {
  return withPostgresClient(async dbClient => {
    await dbClient.query("begin");
    try {
      const result = await callback(dbClient);
      await dbClient.query("commit");
      return result;
    } catch (error) {
      await dbClient.query("rollback").catch(() => null);
      throw error;
    }
  });
}
async function upsertGuildRelational(dbClient, guildId) {
  const id = dbText(guildId, "default");
  await dbClient.query(`
    insert into guilds (id, name, updated_at)
    values ($1, $2, now())
    on conflict (id) do update set updated_at = now()
  `, [id, id]);
  return id;
}
async function upsertPanelRelational(dbClient, guildId, panel) {
  const panelId = dbText(panel?.id);
  if (!panelId) return null;
  await upsertGuildRelational(dbClient, guildId);
  await dbClient.query(`
    insert into panels (
      id, guild_id, scope_id, title, description, color, image_url, thumbnail_url,
      channel_id, published_channel_id, published_message_id, quick_order, updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now())
    on conflict (id) do update set
      title = excluded.title,
      description = excluded.description,
      color = excluded.color,
      image_url = excluded.image_url,
      thumbnail_url = excluded.thumbnail_url,
      channel_id = excluded.channel_id,
      published_channel_id = excluded.published_channel_id,
      published_message_id = excluded.published_message_id,
      quick_order = excluded.quick_order,
      updated_at = now()
  `, [
    panelId,
    dbText(guildId, "default"),
    dbText(panel.scopeId, "default"),
    dbText(panel.title, "Dragon Store"),
    dbText(panel.description),
    dbText(panel.color, "#9b00ff"),
    dbText(panel.imageUrl),
    dbText(panel.thumbnailUrl),
    dbText(panel.channelId),
    dbText(panel.publishedChannelId),
    dbText(panel.publishedMessageId),
    dbJson(panel.quickOrder || {}, {})
  ]);

  for (const productItem of panel.products || []) {
    await dbClient.query(`
      insert into products (
        id, panel_id, guild_id, name, price_label, price_cents, description,
        stock_label, stock_quantity, type, image_url, rewards, active, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,true,now())
      on conflict (id) do update set
        name = excluded.name,
        price_label = excluded.price_label,
        price_cents = excluded.price_cents,
        description = excluded.description,
        stock_label = excluded.stock_label,
        stock_quantity = excluded.stock_quantity,
        type = excluded.type,
        image_url = excluded.image_url,
        rewards = excluded.rewards,
        active = true,
        updated_at = now()
    `, [
      dbProductId(panelId, productItem.id),
      panelId,
      dbText(guildId, "default"),
      dbText(productItem.name, "Produto"),
      dbText(productItem.price, "R$ 0,00"),
      Number.isFinite(Number(productItem.priceCents)) ? Number(productItem.priceCents) : priceCentsFromValue(productItem.price),
      dbText(productItem.description),
      dbText(productItem.stock, "infinito"),
      stockQuantityFromLabel(productItem.stock),
      dbText(productItem.type, "product"),
      dbText(productItem.imageUrl),
      dbJson(Array.isArray(productItem.rewards) ? productItem.rewards : [], [])
    ]);
  }

  return panelId;
}
function relationalOrderValues(order, panel, statusOverride = null) {
  const totals = orderTotals(order, panel);
  const status = dbStatus(statusOverride || order.status);
  const grossAmount = Number.isFinite(Number(order.grossAmount)) ? Number(order.grossAmount) : totals.grossAmount;
  const discountAmount = Number.isFinite(Number(order.discountAmount)) ? Number(order.discountAmount) : totals.discountAmount;
  const paidAmount = Number.isFinite(Number(order.spentAmount)) ? Number(order.spentAmount) : totals.amount;
  return {
    status,
    version: Number(order.version) || 0,
    discount: order.discount || null,
    grossAmountCents: dbCents(grossAmount),
    discountAmountCents: dbCents(discountAmount),
    paidAmountCents: dbCents(paidAmount),
    panelId: dbText(panel?.id || order.panelId) || null,
    panelScopeId: dbText(order.panelScopeId || order.scopeId || panel?.scopeId, "default"),
    updatedAt: order.updatedAt || new Date().toISOString()
  };
}
async function insertOrderRelationalIfMissing(dbClient, order, panel) {
  const guildId = await upsertGuildRelational(dbClient, order.guildId || "default");
  await upsertPanelRelational(dbClient, guildId, panel);
  const values = relationalOrderValues(order, panel);
  await dbClient.query(`
    insert into orders (
      id, guild_id, panel_id, panel_scope_id, channel_id, user_id, username, status,
      version, discount, gross_amount_cents, discount_amount_cents, paid_amount_cents,
      assigned_admin_id, assigned_admin_name, processing_by_admin_id, processing_by_admin_name,
      delivered_by_admin_id, delivered_by_admin_name, delivery_message,
      closed_by_admin_id, closed_by_admin_name, processing_started_at, delivered_at, closed_at, cancelled_at,
      created_at, updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
    on conflict (id) do update set
      guild_id = excluded.guild_id,
      panel_id = excluded.panel_id,
      panel_scope_id = excluded.panel_scope_id,
      channel_id = excluded.channel_id,
      user_id = excluded.user_id,
      username = excluded.username,
      discount = excluded.discount,
      gross_amount_cents = excluded.gross_amount_cents,
      discount_amount_cents = excluded.discount_amount_cents,
      paid_amount_cents = excluded.paid_amount_cents,
      assigned_admin_id = excluded.assigned_admin_id,
      assigned_admin_name = excluded.assigned_admin_name,
      updated_at = now()
  `, [
    dbText(order.id),
    guildId,
    values.panelId,
    values.panelScopeId,
    dbText(order.channelId),
    dbText(order.userId),
    dbText(order.username),
    values.status,
    values.version,
    dbJson(values.discount, null),
    values.grossAmountCents,
    values.discountAmountCents,
    values.paidAmountCents,
    dbText(order.assignedAdminId) || null,
    dbText(order.assignedAdminName),
    dbText(order.processingByAdminId) || null,
    dbText(order.processingByAdminName),
    dbText(order.deliveredByAdminId) || null,
    dbText(order.deliveredByAdminName),
    dbText(order.deliveryMessage),
    dbText(order.closedByAdminId) || null,
    dbText(order.closedByAdminName),
    order.processingStartedAt || null,
    order.deliveredAt || null,
    order.closedAt || null,
    order.cancelledAt || null,
    order.createdAt || new Date().toISOString(),
    values.updatedAt
  ]);
}
async function syncOrderItemsRelational(dbClient, order, panel) {
  await dbClient.query("delete from order_items where order_id = $1", [dbText(order.id)]);
  for (const item of order.items || []) {
    const details = orderItemDetails(item, panel);
    const sourcePanelId = dbText(details.sourcePanelId || panel?.id || order.panelId);
    await dbClient.query(`
      insert into order_items (
        order_id, product_id, source_panel_id, name, price_label, price_cents,
        description, stock_label, type, image_url, rewards, quantity
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
    `, [
      dbText(order.id),
      dbProductId(sourcePanelId, details.sourceProductId || details.productId),
      sourcePanelId,
      dbText(details.name, "Produto"),
      dbText(details.price),
      Number.isFinite(Number(details.priceCents)) ? Number(details.priceCents) : priceCentsFromValue(details.price),
      dbText(details.description),
      dbText(details.stock),
      dbText(details.type, "product"),
      dbText(details.imageUrl),
      dbJson(Array.isArray(details.rewards) ? details.rewards : [], []),
      Math.max(1, Number(item.quantity) || 1)
    ]);
  }
}
async function writeOrderRelational(dbClient, order, panel) {
  await insertOrderRelationalIfMissing(dbClient, order, panel);
  const values = relationalOrderValues(order, panel);
  await dbClient.query(`
    update orders set
      status = $2,
      version = $3,
      discount = $4::jsonb,
      gross_amount_cents = $5,
      discount_amount_cents = $6,
      paid_amount_cents = $7,
      assigned_admin_id = $8,
      assigned_admin_name = $9,
      processing_by_admin_id = $10,
      processing_by_admin_name = $11,
      delivered_by_admin_id = $12,
      delivered_by_admin_name = $13,
      delivery_message = $14,
      closed_by_admin_id = $15,
      closed_by_admin_name = $16,
      processing_started_at = $17,
      delivered_at = $18,
      closed_at = $19,
      cancelled_at = $20,
      updated_at = now()
    where id = $1
  `, [
    dbText(order.id),
    values.status,
    values.version,
    dbJson(values.discount, null),
    values.grossAmountCents,
    values.discountAmountCents,
    values.paidAmountCents,
    dbText(order.assignedAdminId) || null,
    dbText(order.assignedAdminName),
    dbText(order.processingByAdminId) || null,
    dbText(order.processingByAdminName),
    dbText(order.deliveredByAdminId) || null,
    dbText(order.deliveredByAdminName),
    dbText(order.deliveryMessage),
    dbText(order.closedByAdminId) || null,
    dbText(order.closedByAdminName),
    order.processingStartedAt || null,
    order.deliveredAt || null,
    order.closedAt || null,
    order.cancelledAt || null
  ]);
  await syncOrderItemsRelational(dbClient, order, panel);
}
async function writeStatsRelational(dbClient, db, order) {
  const guildId = dbText(order.guildId, "default");
  const customer = db.customers?.[guildId]?.[order.userId];
  if (customer) {
    await dbClient.query(`
      insert into customer_stats (guild_id, user_id, username, total_spent_cents, order_count, periods, last_order_at, updated_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,now())
      on conflict (guild_id, user_id) do update set
        username = excluded.username,
        total_spent_cents = excluded.total_spent_cents,
        order_count = excluded.order_count,
        periods = excluded.periods,
        last_order_at = excluded.last_order_at,
        updated_at = now()
    `, [
      guildId,
      dbText(customer.userId || order.userId),
      dbText(customer.username || order.username),
      dbCents(customer.totalSpent),
      Number(customer.orderCount) || 0,
      dbJson(customer.periods || {}, {}),
      customer.lastOrderAt || null
    ]);
  }

  const seller = order.closedByAdminId ? db.sellers?.[guildId]?.[order.closedByAdminId] : null;
  if (seller) {
    await dbClient.query(`
      insert into admin_sales (guild_id, admin_user_id, username, total_sold_cents, order_count, total_items, periods, last_sale_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now())
      on conflict (guild_id, admin_user_id) do update set
        username = excluded.username,
        total_sold_cents = excluded.total_sold_cents,
        order_count = excluded.order_count,
        total_items = excluded.total_items,
        periods = excluded.periods,
        last_sale_at = excluded.last_sale_at,
        updated_at = now()
    `, [
      guildId,
      dbText(seller.userId || order.closedByAdminId),
      dbText(seller.username || order.closedByAdminName),
      dbCents(seller.totalSold),
      Number(seller.orderCount) || 0,
      Number(seller.totalItems) || 0,
      dbJson(seller.periods || {}, {}),
      seller.lastSaleAt || null
    ]);
  }
}
async function writePaymentRelational(dbClient, order, panel) {
  const hasProof = Boolean(order.paymentProofLatestUrl || (Array.isArray(order.paymentProofs) && order.paymentProofs.length));
  if (order.paymentStatus !== "marked_paid" && !order.paidAt && !hasProof) return;
  const totals = orderTotals(order, panel);
  const amount = Number.isFinite(Number(order.paidAmount)) ? Number(order.paidAmount) : totals.amount;
  const status = order.paymentStatus === "marked_paid" || order.paidAt ? "marked_paid" : "proof_received";
  const markedAt = order.paidAt || order.paymentProofSubmittedAt || order.closedAt || new Date().toISOString();
  await upsertGuildRelational(dbClient, order.guildId || "default");
  await dbClient.query(`
    insert into payments (
      external_id, order_id, guild_id, status, amount_cents, method,
      staff_user_id, proof_attachment_url, marked_paid_at, created_at
    )
    values ($1,$2,$3,$4,$5,'pix_manual',$6,$7,$8,$8)
    on conflict (external_id) do update set
      status = excluded.status,
      amount_cents = excluded.amount_cents,
      method = excluded.method,
      staff_user_id = excluded.staff_user_id,
      proof_attachment_url = excluded.proof_attachment_url,
      marked_paid_at = excluded.marked_paid_at
  `, [
    `payment_${dbText(order.id)}_manual`,
    dbText(order.id),
    dbText(order.guildId, "default"),
    status,
    dbCents(amount),
    dbText(order.paidByAdminId || order.assignedAdminId || order.closedByAdminId) || null,
    dbText(order.paymentProofLatestUrl) || null,
    markedAt
  ]);
}
async function writeAuditEntryRelational(dbClient, entry) {
  const guildId = dbText(entry.guildId, "default");
  await upsertGuildRelational(dbClient, guildId);
  await dbClient.query(`
    insert into audit_logs (external_id, guild_id, actor_id, actor_name, action, order_id, target_user_id, details, created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
    on conflict (external_id) do update set
      actor_id = excluded.actor_id,
      actor_name = excluded.actor_name,
      action = excluded.action,
      order_id = excluded.order_id,
      target_user_id = excluded.target_user_id,
      details = excluded.details
  `, [
    dbText(entry.id),
    guildId,
    dbText(entry.actorId) || null,
    dbText(entry.actorName),
    dbText(entry.action, "unknown"),
    dbText(entry.orderId) || null,
    dbText(entry.targetUserId) || null,
    dbJson(entry.details || {}, {}),
    entry.createdAt || new Date().toISOString()
  ]);
}
function enqueueAuditLogEntryToPostgres(entry) {
  if (!postgresEnabled() || !entry?.id) return Promise.resolve(false);
  return withPostgresClient(dbClient => writeAuditEntryRelational(dbClient, entry))
    .catch(error => {
      console.log(`Nao consegui espelhar audit log no Postgres: ${error.message}`);
      return false;
    });
}
async function writeRecentAuditLogsRelational(dbClient, db, orderId) {
  const recent = (db.auditLogs || []).filter(entry => !orderId || entry.orderId === orderId).slice(-25);
  for (const entry of recent) await writeAuditEntryRelational(dbClient, entry);
}
async function finalizeOrderWithPostgres(db, order, panel, context, applyFinalState) {
  if (!postgresEnabled()) return { ok: true, used: false };
  const actor = actionUser(context);
  const actorName = context.member?.displayName || actor?.username || actor?.id || "ADM";
  const processingAt = new Date().toISOString();

  try {
    return await withPostgresTransaction(async dbClient => {
      await insertOrderRelationalIfMissing(dbClient, order, panel);
      await syncOrderItemsRelational(dbClient, order, panel);
      await dbClient.query(`
        update orders
        set status = 'open',
          processing_started_at = null,
          processing_by_admin_id = null,
          processing_by_admin_name = null,
          version = version + 1,
          updated_at = now()
        where id = $1
          and status = 'processing'
          and processing_started_at is not null
          and processing_started_at < now() - interval '10 minutes'
      `, [dbText(order.id)]);
      const lock = await dbClient.query(`
        update orders
        set status = 'processing',
          processing_started_at = $2,
          processing_by_admin_id = $3,
          processing_by_admin_name = $4,
          version = version + 1,
          updated_at = now()
        where id = $1 and status = 'open'
        returning status, version
      `, [dbText(order.id), processingAt, dbText(actor?.id) || null, dbText(actorName)]);

      if (lock.rowCount !== 1) {
        const current = await dbClient.query("select status from orders where id = $1", [dbText(order.id)]);
        return { ok: false, used: true, status: current.rows[0]?.status || "missing" };
      }

      applyFinalState(processingAt);
      await writeOrderRelational(dbClient, order, panel);
      await writePaymentRelational(dbClient, order, panel);
      await writeStatsRelational(dbClient, db, order);
      await writeRecentAuditLogsRelational(dbClient, db, order.id);
      return { ok: true, used: true };
    });
  } catch (error) {
    return { ok: false, used: true, error };
  }
}
async function persistOrderRelationalAsync(db, order, panel) {
  if (!postgresEnabled() || !order?.id) return false;
  return withPostgresTransaction(async dbClient => {
    await writeOrderRelational(dbClient, order, panel);
    await writePaymentRelational(dbClient, order, panel);
    await writeStatsRelational(dbClient, db, order);
    await writeRecentAuditLogsRelational(dbClient, db, order.id);
    return true;
  }).catch(error => {
    console.log(`Nao consegui espelhar pedido ${order.id} no Postgres: ${error.message}`);
    return false;
  });
}
function encryptPixKeyForDb(value) {
  const pixKey = dbText(value);
  const secret = process.env.PIX_ENCRYPTION_KEY || "";
  if (!pixKey || !secret) return null;

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(pixKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-256-gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}
async function persistPanelRelationalAsync(guildId, panel) {
  if (!postgresEnabled() || !panel?.id) return false;
  return withPostgresTransaction(async dbClient => {
    await upsertPanelRelational(dbClient, guildId, panel);
    return true;
  }).catch(error => {
    console.log(`Nao consegui espelhar painel ${panel.id} no Postgres: ${error.message}`);
    return false;
  });
}
async function persistStaffGuildRelationalAsync(guildId, staffGuild) {
  if (!postgresEnabled() || !staffGuild?.users) return false;
  return withPostgresTransaction(async dbClient => {
    await upsertGuildRelational(dbClient, guildId);
    for (const [userId, profile] of Object.entries(staffGuild.users || {})) {
      await dbClient.query(`
        insert into staff (guild_id, user_id, display_name, pix_key_encrypted, qr_code_url, note, online, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,now())
        on conflict (guild_id, user_id) do update set
          display_name = excluded.display_name,
          pix_key_encrypted = coalesce(excluded.pix_key_encrypted, staff.pix_key_encrypted),
          qr_code_url = excluded.qr_code_url,
          note = excluded.note,
          online = excluded.online,
          updated_at = now()
      `, [
        dbText(guildId, "default"),
        dbText(profile.userId || userId),
        dbText(profile.displayName),
        encryptPixKeyForDb(profile.pixKey),
        dbText(profile.qrCodeUrl),
        dbText(profile.note),
        Boolean(profile.online)
      ]);
    }
    return true;
  }).catch(error => {
    console.log(`Nao consegui espelhar staff ${guildId} no Postgres: ${error.message}`);
    return false;
  });
}
function ensureOrdersStore(db) {
  const store = db && typeof db === "object" ? db : {};
  if (!store.orders || typeof store.orders !== "object" || Array.isArray(store.orders)) store.orders = {};
  if (!store.tickets || typeof store.tickets !== "object" || Array.isArray(store.tickets)) store.tickets = {};
  if (!store.customers || typeof store.customers !== "object" || Array.isArray(store.customers)) store.customers = {};
  if (!store.sellers || typeof store.sellers !== "object" || Array.isArray(store.sellers)) store.sellers = {};
  if (!Array.isArray(store.auditLogs)) store.auditLogs = [];
  if (store.auditLogs.length > 1000) store.auditLogs = store.auditLogs.slice(-1000);

  for (const [id, order] of Object.entries(store.orders)) {
    if (!order || typeof order !== "object" || Array.isArray(order)) {
      delete store.orders[id];
      continue;
    }
    order.id = String(order.id || id);
    order.status = String(order.status || "open");
    order.items = Array.isArray(order.items) ? order.items.filter(Boolean) : [];
    order.createdAt = order.createdAt || new Date().toISOString();
    order.closedAt = order.closedAt || null;
    order.version = Number.isFinite(Number(order.version)) ? Number(order.version) : 0;
  }

  for (const [id, ticket] of Object.entries(store.tickets)) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
      delete store.tickets[id];
      continue;
    }
    ticket.id = String(ticket.id || id);
    ticket.status = String(ticket.status || "open");
    ticket.createdAt = ticket.createdAt || new Date().toISOString();
  }
  return store;
}
function ensureGuildStore(data) {
  const store = data && typeof data === "object" ? data : {};
  if (!store.guilds || typeof store.guilds !== "object" || Array.isArray(store.guilds)) store.guilds = {};
  return store;
}
function readPanels() {
  const data = ensureGuildStore(readJson(PANELS_FILE, { guilds: {} }));
  rememberJson(PANELS_FILE, data);
  return data;
}
function writePanels(data) { writeJson(PANELS_FILE, data); }
function readOrders() {
  const data = ensureOrdersStore(readJson(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {}, auditLogs: [] }));
  rememberJson(ORDERS_FILE, data);
  return data;
}
function writeOrders(data) { writeJson(ORDERS_FILE, ensureOrdersStore(data)); }
function readStaff() {
  const data = ensureGuildStore(readJson(STAFF_FILE, { guilds: {} }));
  rememberJson(STAFF_FILE, data);
  return data;
}
function writeStaff(data) { writeJson(STAFF_FILE, data); }
const ORDER_STATUS = {
  OPEN: "open",
  PROCESSING: "processing",
  CLOSED: "closed",
  CANCELLED: "cancelled",
  CANCELED: "canceled"
};
const ORDER_PROCESSING_STALE_MS = 10 * 60 * 1000;
function touchOrder(order) {
  order.version = (Number(order.version) || 0) + 1;
  order.updatedAt = new Date().toISOString();
  return order;
}
function isOrderProcessing(order) {
  return String(order?.status || "") === ORDER_STATUS.PROCESSING || orderActionLocks.has(String(order?.id || ""));
}
function claimOrderActionLock(order) {
  const id = String(order?.id || "");
  if (!id || orderActionLocks.has(id)) return false;
  orderActionLocks.add(id);
  return true;
}
function releaseOrderActionLock(order) {
  const id = String(order?.id || "");
  if (id) orderActionLocks.delete(id);
}
function isOrderProcessingStale(order) {
  if (!isOrderProcessing(order) || !order.processingStartedAt) return false;
  const started = Date.parse(order.processingStartedAt);
  return Number.isFinite(started) && Date.now() - started > ORDER_PROCESSING_STALE_MS;
}
function orderStatusLabel(status) {
  const value = String(status || ORDER_STATUS.OPEN);
  if (value === ORDER_STATUS.OPEN) return "Aberto";
  if (value === ORDER_STATUS.PROCESSING) return "Processando";
  if (value === ORDER_STATUS.CLOSED) return "Fechado";
  if (value === ORDER_STATUS.CANCELLED || value === ORDER_STATUS.CANCELED) return "Cancelado";
  return value;
}
function paymentStatusLabel(order) {
  if (order?.paymentStatus === "marked_paid" || order?.paidAt) {
    const by = order.paidByAdminId ? ` por <@${order.paidByAdminId}>` : "";
    return `Pago manualmente${by}`;
  }
  if (order?.paymentStatus === "proof_received" || order?.paymentProofSubmittedAt) return "Comprovante recebido";
  if (order?.assignedAdminId) return "Aguardando pagamento";
  return "Aguardando ADM";
}
function paymentTranscriptLabel(order) {
  if (order?.paymentStatus === "marked_paid" || order?.paidAt) return "Pago manualmente";
  if (order?.paymentStatus === "proof_received" || order?.paymentProofSubmittedAt) return "Comprovante recebido";
  if (order?.assignedAdminId) return "Aguardando pagamento";
  return "Aguardando ADM";
}
function uniqueMentionUsers(...values) {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}
function deliveryStatusLabel(order) {
  if (order?.deliveredAt) {
    const by = order.deliveredByAdminId ? ` por <@${order.deliveredByAdminId}>` : "";
    return `Entregue${by}`;
  }
  if (order?.paymentStatus === "marked_paid" || order?.paidAt) return "Pago, aguardando entrega";
  return "Aguardando pagamento";
}
function orderChecklist(order) {
  const done = value => value ? "x" : " ";
  const paid = order?.paymentStatus === "marked_paid" || order?.paidAt;
  return [
    `[x] Carrinho criado`,
    `[${done(order?.assignedAdminId)}] ADM assumiu`,
    `[${done(paid)}] Pagamento recebido`,
    `[${done(order?.deliveredAt)}] Produto entregue`,
    `[${done(order?.status === ORDER_STATUS.CLOSED)}] Compra finalizada`
  ].join("\n");
}
function canStartOrderProcessing(order) {
  return Boolean(order && String(order.status || "") === ORDER_STATUS.OPEN);
}
function recoverStaleProcessingOrder(db, order, context = null) {
  if (!db || !order || !isOrderProcessingStale(order)) return false;
  order.status = ORDER_STATUS.OPEN;
  order.recoveredFromProcessingAt = new Date().toISOString();
  order.recoveredProcessingStartedAt = order.processingStartedAt || "";
  delete order.processingStartedAt;
  delete order.processingByAdminId;
  delete order.processingByAdminName;
  touchOrder(order);
  appendAuditLog(db, context || {
    guildId: order.guildId,
    channelId: order.channelId,
    user: { id: client.user?.id || "bot", username: client.user?.username || "bot" }
  }, "order.processing_recovered", { order, recoveredProcessingStartedAt: order.recoveredProcessingStartedAt });
  db.orders[order.id] = order;
  return true;
}
function recoverStaleProcessingOrders(context = null) {
  const db = readOrders();
  let recovered = 0;
  for (const order of Object.values(db.orders || {})) {
    if (recoverStaleProcessingOrder(db, order, context)) recovered += 1;
  }
  if (recovered) writeOrders(db);
  return recovered;
}
function auditActor(context) {
  const user = actionUser(context) || {};
  return {
    actorId: user.id || "",
    actorName: context?.member?.displayName || user.username || ""
  };
}
function auditContext(context) {
  return {
    guildId: actionGuildId(context),
    channelId: context?.channel?.id || context?.channelId || ""
  };
}
function compactAuditValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return clampText(value, 300);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return depth > 1 ? `[${value.length} item(s)]` : value.slice(0, 20).map(item => compactAuditValue(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 1) return "[objeto]";
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, compactAuditValue(item, depth + 1)]));
  }
  return String(value);
}
function appendAuditLog(db, context, action, details = {}) {
  if (!db || typeof db !== "object") return null;
  if (!Array.isArray(db.auditLogs)) db.auditLogs = [];
  const actor = auditActor(context);
  const ctx = auditContext(context);
  const entry = {
    id: `audit_${Date.now()}_${sid()}`,
    action,
    ...ctx,
    ...actor,
    orderId: details.orderId || details.order?.id || "",
    targetUserId: details.targetUserId || details.order?.userId || "",
    details: compactAuditValue(details),
    createdAt: new Date().toISOString()
  };
  db.auditLogs.push(entry);
  if (db.auditLogs.length > 1000) db.auditLogs = db.auditLogs.slice(-1000);
  enqueueAuditLogEntryToPostgres(entry);
  return entry;
}
function writeAuditLog(context, action, details = {}) {
  const db = readOrders();
  appendAuditLog(db, context, action, details);
  writeOrders(db);
}
function changedFieldNames(oldValue = {}, newValue = {}, fields = []) {
  return fields.filter(field => String(oldValue?.[field] || "") !== String(newValue?.[field] || ""));
}
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
  persistStaffGuildRelationalAsync(guildId, staffGuild);
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
function priceCentsFromValue(value) {
  const amount = parsePrice(value);
  return amount === null ? null : Math.round(amount * 100);
}
function amountFromDetails(details) {
  if (details?.priceCents !== null && details?.priceCents !== undefined && details?.priceCents !== "") {
    const cents = Number(details.priceCents);
    if (Number.isFinite(cents)) return cents / 100;
  }
  return parsePrice(details?.price);
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
      touchOrder(saved);
      appendAuditLog(db, { guildId, channelId: channel.id, user: { id: profile.userId, username: profile.displayName || "ADM" } }, "order.auto_assigned", { order: saved, reason: "single_staff_online" });
      db.orders[order.id] = saved;
      writeOrders(db);
      persistOrderRelationalAsync(db, saved, panel);
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
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }).catch(() => null);
  const db = readOrders();
  const order = orderForAction(db, id, interaction);

  if (!order || order.status !== "open") {
    return actionReply(interaction, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return actionReply(interaction, { content: "Só ADM pode assumir compra.", ephemeral: true });
  }

  if (order.assignedAdminId) {
    return actionReply(interaction, { content: `Essa compra já foi assumida por <@${order.assignedAdminId}>.`, ephemeral: true });
  }

  await ensureStaffState(interaction.guild, interaction.channel);
  const profile = getStaffProfile(interaction.guildId, interaction.user.id);
  if (!profile?.pixKey) {
    return actionReply(interaction, { content: "Configure seu Pix primeiro com `!configpix`, `/configpix` ou no botão **Configurar meu Pix** do painel de atendimento.", ephemeral: true });
  }

  const online = onlineStaffProfiles(interaction.guildId);
  if (online.length > 0 && !profile.online) {
    return actionReply(interaction, { content: "Você está OFF. Clique em **Ficar ON** no painel de atendimento antes de assumir.", ephemeral: true });
  }

  order.assignedAdminId = interaction.user.id;
  order.assignedAdminName = profile.displayName || interaction.user.username;
  order.assignedAt = new Date().toISOString();
  touchOrder(order);
  appendAuditLog(db, interaction, "order.assigned", { order, staffUserId: interaction.user.id });
  db.orders[order.id] = order;
  writeOrders(db);

  const panel = getOrderPanel(order, actionGuildId(interaction));
  persistOrderRelationalAsync(db, order, panel);
  const targetChannel = order.channelId === interaction.channel?.id
    ? interaction.channel
    : await interaction.guild.channels.fetch(order.channelId).catch(() => null);
  if (!targetChannel?.isTextBased?.()) {
    return actionReply(interaction, { content: "Compra assumida, mas nao consegui achar o canal do carrinho para enviar o Pix.", ephemeral: true });
  }

  await targetChannel.send({
    content: `<@${order.userId}> ✅ Compra #${order.id} assumida por **${order.assignedAdminName}** (<@${interaction.user.id}>).`,
    embeds: [buildPixEmbed(order, panel, profile)],
    components: staffChoiceRows(order.id, true),
    allowedMentions: { users: uniqueMentionUsers(order.userId, interaction.user.id) }
  });

  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return actionReply(interaction, { content: "Compra assumida e Pix enviado.", ephemeral: true });
}
async function resendPix(interaction, id) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }).catch(() => null);
  const db = readOrders();
  const order = orderForAction(db, id, interaction);

  if (!order || order.status !== "open") {
    return actionReply(interaction, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return actionReply(interaction, { content: "Só ADM pode reenviar Pix.", ephemeral: true });
  }

  if (!order.assignedAdminId) {
    return actionReply(interaction, { content: "Essa compra ainda não foi assumida. Clique em **Assumir compra** primeiro.", ephemeral: true });
  }

  await ensureStaffState(interaction.guild, interaction.channel);
  const profile = getStaffProfile(interaction.guildId, order.assignedAdminId);
  if (!profile?.pixKey) {
    return actionReply(interaction, { content: "O ADM responsável não tem Pix configurado mais.", ephemeral: true });
  }

  const panel = getOrderPanel(order, actionGuildId(interaction));
  appendAuditLog(db, interaction, "order.pix_resent", { order, staffUserId: order.assignedAdminId });
  writeOrders(db);
  await interaction.channel.send({ embeds: [buildPixEmbed(order, panel, profile)] });
  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return actionReply(interaction, { content: "Pix reenviado.", ephemeral: true });
}
async function sendPixCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode enviar Pix do carrinho.");
  await message.delete().catch(() => null);

  const db = readOrders();
  const order = findOrderInChannel(db, message, false);
  if (!order) return message.channel.send("Nao encontrei carrinho neste chat.");
  if (order.status !== "open") return message.channel.send(`Esse carrinho esta ${order.status === "closed" ? "fechado" : "indisponivel"}.`);

  await ensureStaffState(message.guild, message.channel);
  const profile = getStaffProfile(message.guild.id, message.author.id);
  if (!profile?.pixKey) return message.channel.send("Configure seu Pix primeiro com `!configpix` ou `/configpix`.");

  if (order.assignedAdminId && order.assignedAdminId !== message.author.id) {
    return message.channel.send(`Essa compra ja foi assumida por <@${order.assignedAdminId}>.`);
  }

  if (!order.assignedAdminId) {
    order.assignedAdminId = message.author.id;
    order.assignedAdminName = profile.displayName || message.member?.displayName || message.author.username;
    order.assignedAt = new Date().toISOString();
    touchOrder(order);
    appendAuditLog(db, message, "order.assigned", { order, staffUserId: message.author.id, via: "pix_command" });
    db.orders[order.id] = order;
    writeOrders(db);
  }
  appendAuditLog(db, message, "order.pix_sent", { order, staffUserId: message.author.id, via: "pix_command" });
  writeOrders(db);

  const panel = getOrderPanel(order, message.guild.id);
  persistOrderRelationalAsync(db, order, panel);
  await message.channel.send({
    content: `<@${order.userId}> Pix enviado por **${order.assignedAdminName || profile.displayName || "ADM"}** (<@${message.author.id}>).`,
    embeds: [buildPixEmbed(order, panel, profile)],
    components: staffChoiceRows(order.id, true),
    allowedMentions: { users: uniqueMentionUsers(order.userId, message.author.id) }
  });
  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });
  return null;
}
async function finishCurrentCartCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode concluir compra.");
  const order = findOrderInChannel(readOrders(), message, true);
  if (!order) return message.reply("Nao encontrei carrinho aberto neste chat.");
  await message.delete().catch(() => null);
  return finishCart(message, order.id);
}
async function markPaidCurrentCartCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode marcar pagamento.");
  const order = findOrderInChannel(readOrders(), message, false);
  if (!order) return message.reply("Nao encontrei carrinho neste chat.");
  await message.delete().catch(() => null);
  return markOrderPaid(message, order.id);
}
async function deliverCurrentCartCommand(message, rawContent) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode entregar produto.");
  const order = findOrderInChannel(readOrders(), message, false);
  if (!order) return message.reply("Nao encontrei carrinho neste chat.");
  const prefix = config.prefix || "!";
  const deliveryText = String(rawContent || "").replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}entregar\\s*`, "i"), "").trim();
  if (!deliveryText) return message.reply("Use `!entregar key/link/mensagem` ou clique em **Entregar produto** no carrinho.");
  await message.delete().catch(() => null);
  return deliverOrder(message, order.id, deliveryText);
}
async function cancelCurrentCartCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode cancelar compra por comando.");
  const order = findOrderInChannel(readOrders(), message, true);
  if (!order) return message.reply("Nao encontrei carrinho aberto neste chat.");
  await message.delete().catch(() => null);
  return cancelCart(message, order.id);
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
    writeAuditLog(interaction, "staff.online_changed", { staffUserId: interaction.user.id, online: true });
    await refreshStaffPanel(interaction.guildId);
    await saveStaffBackup(interaction.guild, interaction.channel).catch(error => console.log(`Nao consegui salvar backup do Pix: ${error.message}`));
    return interaction.reply({ content: "Você está ON para receber vendas.", ephemeral: true });
  }

  if (action === "off") {
    saveStaffProfile(interaction.guildId, interaction.user.id, { online: false });
    writeAuditLog(interaction, "staff.online_changed", { staffUserId: interaction.user.id, online: false });
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

  const oldProfile = getStaffProfile(interaction.guildId, interaction.user.id) || {};
  saveStaffProfile(interaction.guildId, interaction.user.id, {
    displayName,
    pixKey,
    qrCodeUrl,
    note,
    online: false
  });
  const changedFields = changedFieldNames(oldProfile, { displayName, pixKey, qrCodeUrl, note }, ["displayName", "pixKey", "qrCodeUrl", "note"]);
  writeAuditLog(interaction, "staff.pix_changed", { staffUserId: interaction.user.id, changedFields });
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
        priceCents: priceCentsFromValue(price),
        description: preset.productDescription,
        stock: "infinito",
        imageUrl: ""
      };
    }

    return {
      id: "p" + random7(),
      name: item.name || "Produto",
      price: item.price || "R$ 0,00",
      priceCents: priceCentsFromValue(item.price || "R$ 0,00"),
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
  persistPanelRelationalAsync(guildId, panel);
}
function findProductForStock(store, guildId, panelId, scopeId, productId) {
  const guildStore = ensurePanelStore(store, guildId);
  const panels = Object.values(guildStore.panels || {});
  const panel = panels.find(item => item.id === panelId) ||
    guildStore.panels?.[scopeId] ||
    guildStore.panel;
  const productItem = panel?.products?.find(item => item.id === productId);
  return productItem && panel ? { panel, product: productItem } : null;
}
function orderStockIssues(guildId, order, fallbackPanel) {
  const store = readPanels();
  const requested = new Map();
  for (const item of order.items || []) {
    const details = orderItemDetails(item, fallbackPanel);
    const productId = details.sourceProductId || item.productId;
    const panelId = details.sourcePanelId || item.sourcePanelId || order.panelId || fallbackPanel?.id || "";
    const key = `${panelId}:${productId}`;
    const current = requested.get(key) || { panelId, productId, quantity: 0, details };
    current.quantity += Math.max(1, Number(item.quantity) || 1);
    requested.set(key, current);
  }

  const issues = [];
  for (const request of requested.values()) {
    const found = findProductForStock(store, guildId, request.panelId, order.panelScopeId || fallbackPanel?.scopeId || "default", request.productId);
    if (!found) continue;
    const stock = stockQuantityFromLabel(found.product.stock);
    if (stock !== null && stock < request.quantity) {
      issues.push({
        productName: found.product.name || request.details.name || "Produto",
        stock,
        requested: request.quantity
      });
    }
  }
  return issues;
}
function consumeOrderStock(guildId, order, fallbackPanel) {
  if (order.stockAdjustedAt) return [];
  const store = readPanels();
  const changes = [];

  for (const item of order.items || []) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const details = orderItemDetails(item, fallbackPanel);
    const productId = details.sourceProductId || item.productId;
    const panelId = details.sourcePanelId || item.sourcePanelId || order.panelId || fallbackPanel?.id || "";
    const found = findProductForStock(store, guildId, panelId, order.panelScopeId || fallbackPanel?.scopeId || "default", productId);
    if (!found) continue;

    const current = stockQuantityFromLabel(found.product.stock);
    if (current === null) continue;
    const next = Math.max(0, current - quantity);
    found.product.stock = formatStockLabel(next, found.product.stock);
    found.product.updatedAt = new Date().toISOString();
    changes.push({
      panelId: found.panel.id,
      panelTitle: found.panel.title,
      productId: found.product.id,
      productName: found.product.name,
      before: current,
      sold: quantity,
      after: next
    });
  }

  if (changes.length) {
    writePanels(store);
    for (const panel of new Set(changes.map(change => findProductForStock(store, guildId, change.panelId, "", change.productId)?.panel).filter(Boolean))) {
      persistPanelRelationalAsync(guildId, panel);
    }
  }

  order.stockAdjustedAt = new Date().toISOString();
  order.stockAdjustments = changes;
  return changes;
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
    priceCents: Number.isFinite(Number(p.priceCents)) ? Number(p.priceCents) : priceCentsFromValue(p.price),
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
    const value = amountFromDetails(product);
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
function orderCanBeUsed(order, openOnly = true) {
  return Boolean(order && (!openOnly || order.status === "open"));
}
function orderIdHintsFromContext(context) {
  const values = [
    context?.channel?.name,
    context?.channel?.topic,
    context?.message?.content,
    ...(context?.message?.embeds || []).flatMap(embed => [embed?.title, embed?.description])
  ].filter(Boolean).join(" ");
  return Array.from(new Set(String(values).match(/\b\d{7}\b/g) || []));
}
function findOrderInChannel(db, context, openOnly = true) {
  const guildId = actionGuildId(context);
  const channelId = context?.channel?.id || context?.channelId;
  if (!guildId || !channelId) return null;

  const byChannel = Object.values(db.orders || {}).find(order =>
    order.guildId === guildId &&
    order.channelId === channelId &&
    (!openOnly || order.status === "open")
  );
  if (byChannel) return byChannel;

  for (const hintId of orderIdHintsFromContext(context)) {
    const hinted = db.orders?.[hintId];
    if (hinted?.guildId === guildId && orderCanBeUsed(hinted, openOnly)) return hinted;
  }

  return null;
}
function orderForAction(db, id, context, openOnly = true) {
  const order = db.orders?.[id];
  if (orderCanBeUsed(order, openOnly)) return order;
  return findOrderInChannel(db, context, openOnly) || order || null;
}
function product(panel, id) { return (panel.products || []).find(p => p.id === id); }
function normalizeProductInput({ name, price, description, stock, imageUrl }) {
  const cleanImage = clampText(imageUrl, 500);
  const cleanPrice = clampText(price, 50, "R$ 0,00");
  return {
    name: clampText(name, 100, "Produto"),
    price: cleanPrice,
    priceCents: priceCentsFromValue(cleanPrice),
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
    priceCents: Number.isFinite(Number(p.priceCents)) ? Number(p.priceCents) : priceCentsFromValue(p.price),
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
    priceCents: Number.isFinite(Number(item.priceCents))
      ? Number(item.priceCents)
      : Number.isFinite(Number(current?.priceCents))
        ? Number(current.priceCents)
        : priceCentsFromValue(item.price || current?.price),
    description: item.description || current?.description || "",
    stock: item.stock || current?.stock || "infinito",
    type: item.type || current?.type || "product",
    imageUrl: item.imageUrl || current?.imageUrl || "",
    rewards: Array.isArray(item.rewards) ? item.rewards : current?.rewards,
    sourceProductId: item.sourceProductId || current?.id || item.productId,
    sourcePanelId: item.sourcePanelId || "",
    sourcePanelTitle: item.sourcePanelTitle || ""
  };
}
function orderTotals(order, panel) {
  const summary = (order.items || []).reduce((currentSummary, item) => {
    const details = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unit = amountFromDetails(details);

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
function cleanTranscriptText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .slice(0, 1800);
}
function transcriptFileName(order, status) {
  return `transcript-${status}-${String(order.id || "pedido").replace(/[^\w-]/g, "")}.txt`;
}
function orderTranscriptHeader(order, panel, status) {
  const totals = orderTotals(order, panel);
  const lines = [
    "DRAGON STORE - TRANSCRIPT DE PEDIDO",
    `Pedido: #${order.id}`,
    `Status: ${status}`,
    `Cliente: ${order.username || "cliente"} (${order.userId || "sem-id"})`,
    `Atendente: ${order.assignedAdminName || order.closedByAdminName || "nao assumido"} (${order.assignedAdminId || order.closedByAdminId || "sem-id"})`,
    `Pagamento: ${paymentTranscriptLabel(order)}`,
    `Total: ${totalLine(order, panel)}`,
    `Total numerico: ${money(totals.amount)}`,
    `Criado em: ${order.createdAt || ""}`,
    `Pago em: ${order.paidAt || ""}`,
    `Comprovante em: ${order.paymentProofSubmittedAt || ""}`,
    `Comprovante URL: ${order.paymentProofLatestUrl || ""}`,
    `Entregue em: ${order.deliveredAt || ""}`,
    `Entregue por: ${order.deliveredByAdminName || ""} (${order.deliveredByAdminId || ""})`,
    `Fechado em: ${order.closedAt || ""}`,
    `Cancelado em: ${order.cancelledAt || ""}`,
    `Canal: ${order.channelId || ""}`,
    "",
    "ITENS:",
    ...(order.items || []).map(item => {
      const details = orderItemDetails(item, panel);
      const quantity = Math.max(1, Number(item.quantity) || 1);
      return `- ${details.name} | ${details.price} | qtd ${quantity} | tipo ${details.type || "product"}`;
    }),
    ""
  ];
  if (Array.isArray(order.mysteryResults) && order.mysteryResults.length) {
    lines.push("CAIXAS PIX / SORTEIOS:");
    lines.push(mysteryResultsText(order.mysteryResults));
    lines.push("");
  }
  return lines.join("\n");
}
async function collectChannelTranscript(channel, limit = 80) {
  if (!channel?.messages?.fetch) return "Mensagens indisponiveis.";
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages) return "Nao foi possivel buscar mensagens do canal.";
  return [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(message => {
      const author = `${message.author?.tag || message.author?.username || "desconhecido"} (${message.author?.id || "sem-id"})`;
      const content = cleanTranscriptText(message.content);
      const embeds = (message.embeds || []).map(embed => [
        embed.title ? `[embed: ${cleanTranscriptText(embed.title)}]` : "",
        embed.description ? cleanTranscriptText(embed.description) : ""
      ].filter(Boolean).join(" ")).filter(Boolean).join(" ");
      const attachments = message.attachments?.size
        ? [...message.attachments.values()].map(file => file.url).join(", ")
        : "";
      return `[${new Date(message.createdTimestamp).toISOString()}] ${author}: ${[content, embeds, attachments ? `Anexos: ${attachments}` : ""].filter(Boolean).join(" | ") || "(sem texto)"}`;
    })
    .join("\n");
}
async function buildOrderTranscriptAttachment(channel, order, panel, status) {
  const header = orderTranscriptHeader(order, panel, status);
  const messages = await collectChannelTranscript(channel);
  const text = `${header}\nMENSAGENS RECENTES DO CARRINHO:\n${messages}\n`;
  return new AttachmentBuilder(Buffer.from(text, "utf8"), { name: transcriptFileName(order, status) });
}
function completionChannelId() {
  return String(process.env.COMPLETION_CHANNEL_ID || config.completion?.channelId || DEFAULT_COMPLETION_CHANNEL_ID).trim();
}
function completionFeedEnabled() {
  return config.completion?.enabled !== false && process.env.COMPLETION_FEED_ENABLED !== "false";
}
function completionTranscriptEnabled() {
  return config.completion?.transcriptEnabled === true || process.env.COMPLETION_TRANSCRIPT_ENABLED === "true";
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
async function sendCompletionReceipt(guild, order, panel, sourceChannel = null) {
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

  const transcript = sourceChannel && completionTranscriptEnabled()
    ? await buildOrderTranscriptAttachment(sourceChannel, order, panel, "finalizado").catch(error => {
        console.log(`Nao consegui gerar transcript da compra ${order.id}: ${error.message}`);
        return null;
      })
    : null;

  await channel.send({
    content: `Compra finalizada! <@${order.userId}> - ${products}`,
    embeds: [embed],
    files: transcript ? [transcript] : [],
    allowedMentions: { users: [order.userId] }
  });
  return true;
}
async function sendCancellationNotice(guild, order, panel, actor, sourceChannel = null) {
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

  const transcript = sourceChannel
    ? await buildOrderTranscriptAttachment(sourceChannel, order, panel, "cancelado").catch(error => {
        console.log(`Nao consegui gerar transcript do cancelamento ${order.id}: ${error.message}`);
        return null;
      })
    : null;

  await channel.send({
    content: `<@${order.userId}> compra cancelada.`,
    embeds: [embed],
    files: transcript ? [transcript] : [],
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
    writeAuditLog(interaction, "panel.reset", { scopeId: s.scopeId, panelId: resetPanel.id });
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
  let auditAction = "panel.updated";
  let auditDetails = { scopeId: s.scopeId, panelId: panel.id, field };
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
    writeAuditLog(interaction, "panel.linked", { scopeId: s.scopeId, panelId: recovered.id, productCount: recovered.products.length, sourceChannelId: ch.id, sourceMessageId: msg.id });
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
    const newProduct = panel.products[panel.products.length - 1];
    auditAction = "product.created";
    auditDetails = { ...auditDetails, productId: newProduct.id, productName: newProduct.name };
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
    const newProduct = panel.products[panel.products.length - 1];
    auditAction = "product.created";
    auditDetails = { ...auditDetails, productId: newProduct.id, productName: newProduct.name, type: "mystery_box", rewardCount: newProduct.rewards.length };
  }
  if (field === "edit") {
    const target = product(panel, productId);
    if (!target) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });
    const wasMysteryBox = isMysteryBox(target);
    const before = { ...target };

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
    auditAction = "product.updated";
    auditDetails = {
      ...auditDetails,
      productId: target.id,
      productName: target.name,
      changedFields: changedFieldNames(before, target, ["name", "price", "description", "stock", "imageUrl", "type", "rewards"])
    };
  }
  if (field === "rewards") {
    const target = product(panel, productId);
    if (!target) return interaction.reply({ content: "Produto nao encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

    target.type = "mystery_box";
    target.rewards = parseRewardLines(interaction.fields.getTextInputValue("rewards"));
    auditAction = "product.rewards_updated";
    auditDetails = { ...auditDetails, productId: target.id, productName: target.name, rewardCount: target.rewards.length };
  }
  savePanel(s.guildId, panel, s.scopeId);
  writeAuditLog(interaction, auditAction, auditDetails);
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
  const removedProducts = panel.products
    .filter(p => removeSet.has(p.id))
    .map(p => ({ id: p.id, name: p.name, price: p.price }));
  panel.products = panel.products.filter(p => !removeSet.has(p.id));
  const removed = before - panel.products.length;

  savePanel(s.guildId, panel, s.scopeId);
  writeAuditLog(interaction, "product.removed", { scopeId: s.scopeId, panelId: panel.id, removed, products: removedProducts });
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
  writeAuditLog(interaction, "panel.preset_applied", { scopeId: s.scopeId, panelId: panel.id, preset: presetKey, productCount: panel.products.length });
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
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
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
  persistOrderRelationalAsync(db, order, panel);

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
    components: [productSelect(panel, `cartadd:${id}`), ...cartActionRows(id)],
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
    const unit = amountFromDetails(p);
    const subtotal = unit === null
      ? ""
      : discountPercent > 0
        ? ` = ${money(roundCurrency(unit * quantity * (1 - discountPercent / 100)))} (de ${money(roundCurrency(unit * quantity))})`
        : ` = ${money(roundCurrency(unit * quantity))}`;
    const source = p.sourcePanelTitle ? ` | ${p.sourcePanelTitle}` : "";
    return `• ${productIcon(p)} **${p.name}** — ${p.price} x${quantity}${subtotal}${source}`;
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
  const statusLabel = orderStatusLabel(order.status);
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
      { name: "Pagamento", value: paymentStatusLabel(order), inline: true },
      { name: "Entrega", value: deliveryStatusLabel(order), inline: true },
      { name: "Atendente", value: order.assignedAdminId ? `<@${order.assignedAdminId}>` : "Ainda não assumido", inline: true },
      { name: "Itens", value: String(totals.quantity), inline: true },
      { name: "Total estimado", value: totalLine(order, panel), inline: true }
    )
    .setTimestamp();

  const discountText = discountLine(order);
  if (discountText) embed.addFields({ name: "Desconto", value: discountText, inline: false });
  embed.addFields({ name: "Checklist", value: `\`\`\`\n${orderChecklist(order)}\n\`\`\``, inline: false });
  if (order.paymentProofSubmittedAt) {
    embed.addFields({
      name: "Comprovante",
      value: proofSubmittedAtText(order),
      inline: true
    });
  }
  if (firstImage) embed.setThumbnail(firstImage);
  return embed;
}
function cartButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`call:${orderId}`).setLabel("Chamar ADM").setEmoji("📣").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`view:${orderId}`).setLabel("Ver carrinho").setEmoji("🧾").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`paid:${orderId}`).setLabel("Marcar pago").setEmoji("💵").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`finish:${orderId}`).setLabel("Finalizar compra").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel:${orderId}`).setLabel("Cancelar compra").setEmoji("✖️").setStyle(ButtonStyle.Danger)
  );
}
function proofButtonRow(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`proof:${orderId}`).setLabel("Enviar comprovante").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`deliver:${orderId}`).setLabel("Entregar produto").setStyle(ButtonStyle.Primary)
  );
}
function cartActionRows(orderId) {
  return [cartButtons(orderId), proofButtonRow(orderId)];
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
    "`/configds`, `!configds`, `!painel`, `!loja` ou `!setup` - abre o configurador da loja no canal.",
    "`/setup-atendimento` ou `!atendimento` - cria/atualiza o painel ON/OFF dos ADMs.",
    "`/configpix` ou `!configpix` - configura Pix do ADM.",
    "`/salvarpix` ou `!salvarpix` - salva backup do Pix e painel de atendimento.",
    "`/setup-ticket` - envia o painel de ticket.",
    "`/setupsucess` ou `!setupsucess` - define feed de vendas concluidas e cargo cliente.",
    "`/status-loja` ou `!status-loja` - mostra resumo da loja.",
    "`/pedidos` ou `!pedidos` - lista pedidos abertos e permite assumir o proximo.",
    "`/diagnostico` ou `!diagnostico` - mostra saude do bot, KV, Pix, paineis e carrinhos."
  ];
  const salesCommands = [
    "`/addcar` ou `!addcar [pesquisa]` - busca produtos de todos os paineis do servidor e pergunta a quantidade antes de adicionar ao carrinho.",
    "`!pix` ou `!assumir` - assume o carrinho atual e envia o Pix do ADM.",
    "`/pago`, `!pago` ou `!marcarpago` - marca o pagamento manual do carrinho atual.",
    "`/entregar` ou `!entregar key/link/mensagem` - salva a entrega manual e envia para o cliente.",
    "`!concluircompra` ou `!concluir` - conclui o carrinho atual.",
    "`!cancelarcompra` ou `!cancelar` - cancela e apaga o carrinho atual.",
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
function guildOpenOrders(guildId) {
  return Object.values(readOrders().orders || {})
    .filter(order => (!order.guildId || order.guildId === guildId) && order.status === ORDER_STATUS.OPEN)
    .sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""));
}
function orderQueueLine(order, index) {
  const panel = getOrderPanel(order, order.guildId);
  const assigned = order.assignedAdminId ? `<@${order.assignedAdminId}>` : "sem ADM";
  const createdAt = Date.parse(order.createdAt || "");
  const created = Number.isFinite(createdAt) ? `<t:${Math.floor(createdAt / 1000)}:R>` : "sem data";
  return [
    `**${index + 1}. #${order.id}** - <@${order.userId}> - ${totalLine(order, panel)}`,
    `Canal: <#${order.channelId}> | ${paymentStatusLabel(order)} | ${deliveryStatusLabel(order)} | ${assigned} | ${created}`
  ].join("\n");
}
function openOrdersEmbed(guildId) {
  const orders = guildOpenOrders(guildId);
  const unassigned = orders.filter(order => !order.assignedAdminId).length;
  const lines = orders.slice(0, 10).map(orderQueueLine);
  return new EmbedBuilder()
    .setTitle("Pedidos abertos")
    .setDescription(lines.length ? lines.join("\n\n") : "Nenhum pedido aberto agora.")
    .setColor(0x28f6a1)
    .addFields(
      { name: "Fila", value: `${orders.length} aberto(s), ${unassigned} sem ADM`, inline: true },
      { name: "Ordem", value: "Mais antigos primeiro", inline: true }
    )
    .setFooter({ text: "Use o canal mencionado para abrir o carrinho. O botao assume o pedido mais antigo sem ADM." })
    .setTimestamp();
}
function openOrdersRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("orders:next").setLabel("Assumir proximo").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("orders:refresh").setLabel("Atualizar").setStyle(ButtonStyle.Secondary)
    )
  ];
}
async function showOpenOrders(context) {
  if (!isAdmin(context.member)) return actionReply(context, { content: "So ADM pode ver pedidos abertos.", ephemeral: true });
  return actionReply(context, {
    embeds: [openOrdersEmbed(actionGuildId(context))],
    components: openOrdersRows(),
    ephemeral: true
  });
}
async function handleOpenOrdersButton(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode mexer na fila de pedidos.")) return;
  const [, action] = interaction.customId.split(":");
  if (action === "refresh") {
    return interaction.update({ embeds: [openOrdersEmbed(interaction.guildId)], components: openOrdersRows() });
  }
  const next = guildOpenOrders(interaction.guildId).find(order => !order.assignedAdminId);
  if (!next) {
    return interaction.reply({ content: "Nao tem pedido aberto sem ADM agora.", ephemeral: true });
  }
  return assumeOrder(interaction, next.id);
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
const PERMISSION_LABELS = new Map(Object.entries(PermissionFlagsBits).map(([name, value]) => [value, name]));
function permissionName(permission) {
  return String(PERMISSION_LABELS.get(permission) || permission)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ");
}
function channelPermissionNames(channel, label = "") {
  if (String(label).startsWith("categoria")) return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageChannels
  ];
  if (channel?.isTextBased?.()) return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory
  ];
  return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels];
}
async function discordPermissionWarnings(guild, panels = [], staff = null) {
  const warnings = [];
  if (!guild) return ["Servidor Discord indisponivel no contexto do comando."];
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) return ["Nao consegui carregar o membro do bot para validar permissoes."];

  const basePermissions = [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages
  ];
  const missingBase = basePermissions.filter(permission => !me.permissions.has(permission));
  if (missingBase.length) warnings.push(`Bot sem permissao global: ${missingBase.map(permissionName).join(", ")}.`);

  const roleIds = [
    ["cargo ADM", config.adminRoleId],
    ["cargo cliente", configuredCustomerRoleId(guild.id)],
    ["cargo premium/revendedor", resellerRoleId()]
  ].filter(([, roleId]) => roleId);
  for (const [label, roleId] of roleIds) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      warnings.push(`${label} (${roleId}) nao existe ou o bot nao consegue ver.`);
      continue;
    }
    if ((label === "cargo cliente" || label === "cargo premium/revendedor") && role.comparePositionTo(me.roles.highest) >= 0) {
      warnings.push(`Cargo do bot precisa ficar acima do ${label} (${role.name}) para aplicar automaticamente.`);
    }
  }

  const channelTargets = [
    ["categoria de carrinhos", config.categories?.cartOpen],
    ["categoria de fechados", config.categories?.closed],
    ["categoria de tickets", config.categories?.ticketOpen],
    ["canal do painel de ticket", config.ticketPanel?.channelId],
    ["canal de vendas concluidas", completionChannelId()],
    ["canal de cancelamentos", cancellationChannelId()],
    ["canal de avaliacoes", reviewConfig().channelId],
    ["painel de atendimento", staff?.panelChannelId],
    ...panels.flatMap(panel => [
      [`painel publicado ${panel.title || panel.id}`, panel.publishedChannelId],
      [`canal alvo ${panel.title || panel.id}`, panel.channelId]
    ])
  ];

  const checked = new Set();
  for (const [label, channelId] of channelTargets) {
    if (!channelId || checked.has(channelId)) continue;
    checked.add(channelId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      warnings.push(`${label} (${channelId}) nao existe ou o bot nao consegue ver.`);
      continue;
    }
    if (String(label).startsWith("categoria") && channel.type !== ChannelType.GuildCategory) {
      warnings.push(`${label} (<#${channelId}>) nao e uma categoria; criacao/movimento de carrinhos pode falhar.`);
    }
    const perms = channel.permissionsFor(me);
    if (!perms) {
      warnings.push(`Nao consegui ler permissoes do bot em ${label} (<#${channelId}>).`);
      continue;
    }
    const missing = channelPermissionNames(channel, label).filter(permission => !perms.has(permission));
    if (missing.length) warnings.push(`Bot sem ${missing.map(permissionName).join(", ")} em ${label} (<#${channelId}>).`);
  }

  return warnings;
}
async function buildDiagnosticsEmbed(guild) {
  const guildId = guild?.id || String(guild || "");
  const panelStore = readPanels();
  const guildStore = ensurePanelStore(panelStore, guildId);
  const panels = allPublicPanels(guildStore);
  const ordersDb = readOrders();
  const staff = getStaffGuild(guildId);
  const staffProfiles = Object.values(staff.users || {});
  const guildOrders = Object.values(ordersDb.orders || {}).filter(order => !order.guildId || order.guildId === guildId);
  const openOrders = guildOrders.filter(order => order.status === "open");
  const processingOrders = guildOrders.filter(order => isOrderProcessing(order));
  const closedOrders = guildOrders.filter(order => order.status === "closed");
  const cancelledOrders = guildOrders.filter(order => ["cancelled", "canceled"].includes(String(order.status)));
  const productsCount = panels.reduce((sum, panel) => sum + (panel.products || []).length, 0);
  const publishedCount = panels.filter(panel => panel.publishedChannelId && panel.publishedMessageId).length;
  const staffWithPix = staffProfiles.filter(profile => profile.pixKey).length;
  const onlineStaff = staffProfiles.filter(profile => profile.online && profile.pixKey).length;
  const auditCount = (ordersDb.auditLogs || []).filter(entry => !entry.guildId || entry.guildId === guildId).length;
  const warnings = [];

  if (!postgresEnabled()) warnings.push("DATABASE_URL ausente: finalizacao transacional, auditoria relacional e ranking em banco ficam limitados ao JSON/KV.");
  if (!kvEnabled() && !postgresEnabled()) warnings.push("KV/Postgres nao configurados: deploy pode perder JSON local em host read-only.");
  if (!process.env.PUBLIC_STORE_API_TOKEN?.trim()) warnings.push("PUBLIC_STORE_API_TOKEN ausente: site nao consegue ler API publica do bot.");
  if (!productsCount) warnings.push("Nenhum produto salvo nos paineis do bot.");
  if (!publishedCount) warnings.push("Nenhum painel publicado salvo/vinculado.");
  if (!staffWithPix) warnings.push("Nenhum ADM com Pix configurado.");
  if (!onlineStaff) warnings.push("Nenhum ADM ON com Pix.");
  if (!staff.backupMessageId) warnings.push("Backup do Pix/painel ainda nao salvo no Discord.");
  const staleProcessingOrders = processingOrders.filter(isOrderProcessingStale);
  if (staleProcessingOrders.length) warnings.push(`${staleProcessingOrders.length} carrinho(s) preso(s) em processing ha mais de 10 minutos.`);
  warnings.push(...await discordPermissionWarnings(guild, panels, staff));

  const persistenceParts = [
    postgresEnabled() ? `Postgres ativo (${BOT_DB_PREFIX})` : "",
    kvEnabled() ? `KV ativo (${BOT_KV_PREFIX})` : ""
  ].filter(Boolean);
  const persistenceLine = persistenceParts.length ? persistenceParts.join("\n") : "JSON local/memoria";
  const staffPanelLine = staff.panelChannelId && staff.panelMessageId
    ? `<#${staff.panelChannelId}> / \`${staff.panelMessageId}\``
    : "Nao vinculado";
  const warningLine = warnings.length ? warnings.map(item => `- ${item}`).join("\n") : "Nenhum alerta critico detectado.";

  return new EmbedBuilder()
    .setTitle("Diagnostico Dragon Store")
    .setColor(warnings.length ? 0xf1c40f : 0x28f6a1)
    .addFields(
      { name: "Persistencia", value: persistenceLine, inline: true },
      { name: "Paineis", value: `${panels.length} painel(is)\n${productsCount} produto(s)\n${publishedCount} publicado(s)`, inline: true },
      { name: "Carrinhos", value: `${openOrders.length} aberto(s)\n${processingOrders.length} processando\n${closedOrders.length} fechado(s)\n${cancelledOrders.length} cancelado(s)`, inline: true },
      { name: "Atendimento", value: `${staffWithPix} ADM(s) com Pix\n${onlineStaff} ADM(s) ON\nPainel: ${staffPanelLine}`, inline: false },
      { name: "Auditoria", value: `${auditCount} evento(s) recentes salvos`, inline: true },
      { name: "Site/API", value: `Token publico: ${process.env.PUBLIC_STORE_API_TOKEN?.trim() ? "configurado" : "faltando"}\nScan paineis: ${process.env.PUBLIC_STORE_SCAN_CHANNELS === "false" ? "manual" : "ativo"}\nInvite: ${publicDiscordInviteUrl(process.env.DISCORD_INVITE_URL)}`, inline: false },
      { name: "Alertas", value: warningLine.slice(0, 1024), inline: false }
    )
    .setFooter({ text: "Use !salvarpix depois de configurar Pix/painel e publique/vincule paineis pelo !configds." })
    .setTimestamp();
}
async function sendDiagnosticsCommand(context) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode ver diagnostico do bot.", ephemeral: true });
  }
  return actionReply(context, { embeds: [await buildDiagnosticsEmbed(context.guild)], ephemeral: true });
}
async function openCart(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const [, panelId] = interaction.customId.split(":");
  let panel = getPanelById(interaction.guildId, panelId);
  if (!panel || !product(panel, interaction.values[0])) {
    panel = await recoverPanelFromPublishedMessage(
      interaction.message,
      interaction.guildId,
      panel?.scopeId || scopeIdFromPanelId(panelId, interaction.channelId)
    ) || panel;
  }
  if (!panel) return actionReply(interaction, { content: "Painel antigo. Use `!configds`, clique em **Vincular painel** e cole o link desta mensagem.", ephemeral: true });
  const p = product(panel, interaction.values[0]);
  if (!p) return actionReply(interaction, { content: "Produto não encontrado.", ephemeral: true });
  if (!productHasStock(p, 1)) return actionReply(interaction, { content: stockUnavailableMessage(p, 1), ephemeral: true });
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
  persistOrderRelationalAsync(db, order, panel);
  const intro = new EmbedBuilder().setTitle(`🛒 Carrinho aberto #${id}`).setDescription([config.messages.cartWelcome, discount ? discountLine(order) : ""].filter(Boolean).join("\n\n")).setColor(parseColor(panel.color)).addFields({ name: "Cliente", value: `<@${interaction.user.id}>`, inline: true }, { name: "ID da compra", value: id, inline: true });
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [intro, productInfoEmbed(p, panel, "Produto inicial"), cartEmbed(order, panel)], components: [productSelect(panel, `cartadd:${id}`), ...cartActionRows(id)] });
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

  return actionReply(interaction, { content: `Carrinho criado: ${ch}`, ephemeral: true });
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
  await interaction.deferReply({ ephemeral: true });

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
  persistOrderRelationalAsync(db, order, panel);

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
    components: [productSelect(panel, `cartadd:${id}`), ...cartActionRows(id)]
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

  return actionReply(interaction, { content: `Carrinho criado: ${ch}`, ephemeral: true });
}
async function addCart(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }).catch(() => null);
  const [, id] = interaction.customId.split(":");
  const db = readOrders(); const order = orderForAction(db, id, interaction, false);
  if (!order) return actionReply(interaction, { content: "Carrinho inexistente.", ephemeral: true });
  if (isOrderProcessing(order)) {
    return actionReply(interaction, { content: "Essa compra ja esta sendo finalizada. Aguarde alguns segundos.", ephemeral: true });
  }
  if (order.status === ORDER_STATUS.CLOSED) {
    return actionReply(interaction, { content: `Compra #${order.id} ja foi finalizada.`, ephemeral: true });
  }
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(interaction, { content: `Compra #${order.id} ja foi cancelada.`, ephemeral: true });
  }
  if (!canStartOrderProcessing(order)) return actionReply(interaction, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Você não pode alterar esse carrinho.", ephemeral: true });
  const panel = getOrderPanel(order, actionGuildId(interaction)); const p = product(panel, interaction.values[0]);
  if (!p) return actionReply(interaction, { content: "Produto não encontrado.", ephemeral: true });
  if (!productHasStock(p, 1)) return actionReply(interaction, { content: stockUnavailableMessage(p, 1), ephemeral: true });
  await resetSelectMessage(interaction, { components: [productSelect(panel, `cartadd:${order.id}`), ...cartActionRows(order.id)] });
  const item = order.items.find(i => i.productId === p.id);
  if (item) item.quantity += 1; else order.items.push(orderItemFromProduct(p));
  touchOrder(order);
  appendAuditLog(db, interaction, "order.item_added", { order, productId: p.id, productName: p.name, quantity: 1, source: "cart_select" });
  db.orders[order.id] = order; writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
  await actionReply(interaction, { content: `Adicionado: ${productIcon(p)} **${p.name}** — ${p.price}`, ephemeral: true });
  return interaction.channel.send({ embeds: [productInfoEmbed(p, panel, "Produto adicionado"), cartEmbed(order, panel)] });
}
function canEditOrder(member, userId, order) {
  return Boolean(order && (userId === order.userId || isAdmin(member)));
}
function rememberAddCartSession(session) {
  session.expiresAt = Date.now() + ADD_CART_SESSION_TTL_MS;
  addCartSessions.set(session.id, session);
  setTimeout(() => {
    const current = addCartSessions.get(session.id);
    if (current?.expiresAt && current.expiresAt <= Date.now()) addCartSessions.delete(session.id);
  }, ADD_CART_SESSION_TTL_MS + 1000);
  return session;
}
function getAddCartSession(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const session = addCartSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) addCartSessions.delete(sessionId);
    return null;
  }
  return session;
}
function addCartSessionAllowed(context, session, order) {
  const user = actionUser(context);
  if (!user || user.id !== session.userId) return false;
  return canEditOrder(context.member, user.id, order);
}
function addCartCatalogForGuild(guildId) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const panels = allPublicPanels(guildStore)
    .filter(panel => Array.isArray(panel.products) && panel.products.length);
  const entries = [];

  panels.forEach((panel, panelIndex) => {
    panel.products.forEach((productItem, productIndex) => {
      entries.push({
        key: `c${entries.length}`,
        panelId: String(panel.id || `panel-${panelIndex}`),
        scopeId: String(panel.scopeId || ""),
        panelTitle: String(panel.title || `Painel ${panelIndex + 1}`),
        panelColor: panel.color || "#9b00ff",
        productId: String(productItem.id || `p${productIndex}`),
        product: { ...productItem }
      });
    });
  });

  return entries;
}
function addCartCatalogEntry(session, key) {
  return (session.catalog || []).find(entry => entry.key === key) || null;
}
function orderItemFromCatalogEntry(entry) {
  const item = orderItemFromProduct(entry.product);
  item.productId = entry.key;
  item.sourceProductId = entry.productId;
  item.sourcePanelId = entry.panelId;
  item.sourcePanelTitle = entry.panelTitle;
  return item;
}
function addCartMatches(session, query = "") {
  const words = plainText(query).split(/\s+/).filter(Boolean);
  const entries = Array.isArray(session?.catalog) ? session.catalog : [];
  if (!words.length) return entries;
  return entries.filter(entry => {
    const p = entry.product || {};
    const haystack = plainText([entry.panelTitle, p.name, p.price, p.description, p.stock].filter(Boolean).join(" "));
    return words.every(word => haystack.includes(word));
  });
}
function addCartProductLines(session) {
  const matches = addCartMatches(session, session.query);
  if (!matches.length) return "Nenhum produto encontrado com essa pesquisa.";
  const lines = matches.slice(0, 15).map((entry, index) => {
    const p = entry.product;
    return `\`${index + 1}.\` ${productIcon(p)} **${p.name || "Produto"}** - ${p.price || "valor a combinar"} | ${entry.panelTitle} | Estoque: ${p.stock || "infinito"}`;
  });
  if (matches.length > 15) lines.push(`...mais ${matches.length - 15} produto(s). Use **Pesquisar** para filtrar.`);
  return lines.join("\n");
}
function addCartOptionDescription(entry) {
  const p = entry.product || {};
  return [
    String(p.price || "valor a combinar"),
    String(entry.panelTitle || "Painel"),
    `Estoque: ${String(p.stock || "infinito")}`
  ].join(" | ").slice(0, 100);
}
function addCartProductSelect(session) {
  const matches = addCartMatches(session, session.query).slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`addcarpick:${session.id}:${sid()}`)
    .setPlaceholder("Selecione o produto para adicionar")
    .setMinValues(1)
    .setMaxValues(1);

  if (!matches.length) {
    menu
      .setDisabled(true)
      .addOptions([{ label: "Nenhum produto encontrado", value: "none", description: "Clique em Pesquisar ou Limpar filtro." }]);
  } else {
    menu.addOptions(matches.map(entry => ({
      label: `${productIcon(entry.product)} ${String(entry.product.name || "Produto").slice(0, 96)}`,
      description: addCartOptionDescription(entry),
      value: entry.key
    })));
  }

  return new ActionRowBuilder().addComponents(menu);
}
function addCartButtons(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`addcar:${session.id}:search`).setLabel("Pesquisar").setEmoji("🔎").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`addcar:${session.id}:clear`).setLabel("Limpar").setEmoji("🧹").setStyle(ButtonStyle.Secondary).setDisabled(!session.query),
    new ButtonBuilder().setCustomId(`addcar:${session.id}:refresh`).setLabel("Atualizar").setEmoji("♻️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`addcar:${session.id}:close`).setLabel("Fechar").setEmoji("✖️").setStyle(ButtonStyle.Danger)
  );
}
function addCartPanelPayload(session, order, panel) {
  const matches = addCartMatches(session, session.query);
  const totalProducts = Array.isArray(session.catalog) ? session.catalog.length : 0;
  const embed = new EmbedBuilder()
    .setTitle(`Adicionar item ao carrinho #${order.id}`)
    .setDescription([
      session.query ? `Pesquisa atual: **${session.query}**` : "Mostrando produtos de todos os paineis configurados neste servidor.",
      "",
      addCartProductLines(session)
    ].join("\n").slice(0, 4096))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${order.userId}>`, inline: true },
      { name: "Encontrados", value: `${matches.length}/${totalProducts}`, inline: true },
      { name: "Total atual", value: totalLine(order, panel), inline: true }
    )
    .setFooter({ text: "Selecione um produto. Depois o bot pede a quantidade." })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [addCartProductSelect(session), addCartButtons(session)]
  };
}
function addCartSearchModal(session) {
  return new ModalBuilder()
    .setCustomId(`addcarsearch:${session.id}`)
    .setTitle("Pesquisar produto")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("query")
          .setLabel("Nome, preco ou palavra-chave")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(false)
          .setValue(String(session.query || "").slice(0, 100))
      )
    );
}
function addCartQuantityModal(session, entry) {
  const p = entry.product || {};
  return new ModalBuilder()
    .setCustomId(`addcarqty:${session.id}:${entry.key}`)
    .setTitle("Quantidade")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel(`Quantidade de ${String(p.name || "Produto").slice(0, 30)}`)
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(4)
          .setPlaceholder("Ex: 1")
          .setValue("1")
          .setRequired(true)
      )
    );
}
function parseCartQuantity(value) {
  const match = String(value || "").match(/\d{1,4}/);
  if (!match) return null;
  const quantity = Number.parseInt(match[0], 10);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return Math.min(999, quantity);
}
async function refreshAddCartMessage(context, session, order, panel) {
  const channel = context.channel;
  if (!channel?.messages?.fetch || !session.messageId) return false;
  const message = await channel.messages.fetch(session.messageId).catch(() => null);
  if (!message) return false;
  await message.edit(addCartPanelPayload(session, order, panel)).catch(() => null);
  return true;
}
async function startAddCartFlow(context, initialQuery = "", options = {}) {
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }

  const db = readOrders();
  const order = findOrderInChannel(db, context, true);
  const user = actionUser(context);
  if (!order) {
    return actionReply(context, { content: "Nao encontrei carrinho aberto neste chat. Use dentro do canal do carrinho.", ephemeral: true });
  }
  if (!canEditOrder(context.member, user.id, order)) {
    return actionReply(context, { content: "Voce nao pode alterar esse carrinho.", ephemeral: true });
  }

  const panel = getOrderPanel(order, actionGuildId(context));
  const catalog = addCartCatalogForGuild(actionGuildId(context));
  if (!catalog.length) {
    return actionReply(context, { content: "Nao encontrei produtos em nenhum painel configurado neste servidor. Use `!configds` para publicar produtos primeiro.", ephemeral: true });
  }

  const session = rememberAddCartSession({
    id: sid(),
    guildId: actionGuildId(context),
    channelId: context.channel.id,
    orderId: order.id,
    userId: user.id,
    query: clampText(initialQuery, 100),
    catalog
  });
  const sent = await context.channel.send(addCartPanelPayload(session, order, panel));
  session.messageId = sent.id;
  addCartSessions.set(session.id, session);
  if (options.confirm === false) return sent;
  return actionReply(context, { content: `Lista de produtos aberta para o carrinho #${order.id}.`, ephemeral: true });
}
async function sendAddCartCommand(message, initialQuery = "") {
  await message.delete().catch(() => null);
  return startAddCartFlow(message, initialQuery, { confirm: false });
}
async function handleAddCartButton(interaction) {
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `!addcar` novamente.", ephemeral: true });

  const [, , action] = interaction.customId.split(":");
  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  const panel = getOrderPanel(order, interaction.guildId);
  if (action === "search") return interaction.showModal(addCartSearchModal(session));
  if (action === "clear") {
    session.query = "";
    rememberAddCartSession(session);
    await interaction.update(addCartPanelPayload(session, order, panel));
    return;
  }
  if (action === "refresh") {
    session.catalog = addCartCatalogForGuild(interaction.guildId);
    rememberAddCartSession(session);
    await interaction.update(addCartPanelPayload(session, order, panel));
    return;
  }
  if (action === "close") {
    await interaction.deferUpdate().catch(() => null);
    addCartSessions.delete(session.id);
    await interaction.message.delete().catch(() => null);
  }
}
async function handleAddCartSearchSubmit(interaction) {
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `!addcar` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  session.query = clampText(interaction.fields.getTextInputValue("query"), 100);
  rememberAddCartSession(session);
  await interaction.deferReply({ ephemeral: true });
  const panel = getOrderPanel(order, interaction.guildId);
  await refreshAddCartMessage(interaction, session, order, panel);
  return interaction.editReply({
    content: session.query ? `Pesquisa aplicada: **${session.query}**.` : "Pesquisa limpa. Mostrando todos os produtos.",
  });
}
async function handleAddCartPick(interaction) {
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `!addcar` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  const entry = addCartCatalogEntry(session, interaction.values[0]);
  if (!entry) return interaction.reply({ content: "Produto nao encontrado nessa lista. Clique em Atualizar e tente de novo.", ephemeral: true });
  return interaction.showModal(addCartQuantityModal(session, entry));
}
async function handleAddCartQuantitySubmit(interaction) {
  const parts = interaction.customId.split(":");
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `!addcar` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  const quantity = parseCartQuantity(interaction.fields.getTextInputValue("quantity"));
  if (!quantity) return interaction.reply({ content: "Quantidade invalida. Use um numero maior que zero.", ephemeral: true });

  const panel = getOrderPanel(order, interaction.guildId);
  const entry = addCartCatalogEntry(session, parts[2]);
  if (!entry) return interaction.reply({ content: "Produto nao encontrado nessa lista. Clique em Atualizar e tente de novo.", ephemeral: true });
  const p = entry.product || {};
  if (!productHasStock(p, quantity)) return interaction.reply({ content: stockUnavailableMessage(p, quantity), ephemeral: true });
  await interaction.deferReply({ ephemeral: true });

  const item = order.items.find(current => current.productId === entry.key);
  if (item) item.quantity = Math.min(9999, (Number(item.quantity) || 1) + quantity);
  else {
    const next = orderItemFromCatalogEntry(entry);
    next.quantity = quantity;
    order.items.push(next);
  }

  touchOrder(order);
  appendAuditLog(db, interaction, "order.item_added", {
    order,
    productId: entry.sourceProductId || entry.productId,
    productName: p.name,
    sourcePanelId: entry.panelId,
    sourcePanelTitle: entry.panelTitle,
    quantity,
    source: "addcar"
  });
  db.orders[order.id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
  rememberAddCartSession(session);
  await refreshAddCartMessage(interaction, session, order, panel);
  await interaction.editReply({ content: `Adicionado: ${productIcon(p)} **${p.name || "Produto"}** x${quantity}.\nTotal atualizado: **${totalLine(order, panel)}**` });
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
  if (context.isRepliable?.()) {
    if (context.deferred && !context.replied) {
      const { ephemeral, ...editablePayload } = payload || {};
      return context.editReply(editablePayload);
    }
    if (context.replied) return context.followUp(payload);
    return context.reply(payload);
  }
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
async function markOrderPaid(context, id) {
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode marcar pagamento.", ephemeral: true });
  }

  const guildId = actionGuildId(context);
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order) return actionReply(context, { content: "Carrinho inexistente.", ephemeral: true });
  if (isOrderProcessing(order)) return actionReply(context, { content: "Essa compra esta sendo finalizada agora.", ephemeral: true });
  if (order.status === ORDER_STATUS.CLOSED) return actionReply(context, { content: "Essa compra ja foi finalizada.", ephemeral: true });
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(context, { content: "Essa compra ja foi cancelada.", ephemeral: true });
  }
  if (order.status !== ORDER_STATUS.OPEN) {
    return actionReply(context, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  }
  if (order.paymentStatus === "marked_paid" || order.paidAt) {
    return actionReply(context, { content: `Pagamento ja marcado por ${order.paidByAdminId ? `<@${order.paidByAdminId}>` : "um ADM"}.`, ephemeral: true });
  }

  const actor = actionUser(context);
  const panel = getOrderPanel(order, guildId);
  const totals = orderTotals(order, panel);
  const now = new Date().toISOString();
  order.paymentStatus = "marked_paid";
  order.paidAt = now;
  order.paidByAdminId = actor.id;
  order.paidByAdminName = context.member?.displayName || actor.username;
  order.paidAmount = totals.amount;
  order.paidGrossAmount = totals.grossAmount;
  order.paidDiscountAmount = totals.discountAmount;
  touchOrder(order);
  appendAuditLog(db, context, "order.payment_marked_paid", {
    order,
    paidAmount: order.paidAmount,
    grossAmount: order.paidGrossAmount,
    discountAmount: order.paidDiscountAmount
  });
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);

  await context.channel.send({
    content: `<@${order.userId}> Pagamento do pedido #${order.id} marcado como recebido por **${order.paidByAdminName || "ADM"}**.`,
    embeds: [cartEmbed(order, panel)],
    allowedMentions: { users: [order.userId] }
  }).catch(() => null);

  return actionReply(context, { content: `Pagamento do carrinho #${order.id} marcado como recebido (${money(totals.amount)}).`, ephemeral: true });
}
function proofSubmittedAtText(order) {
  const timestamp = new Date(order.paymentProofSubmittedAt || "").getTime();
  if (!Number.isFinite(timestamp)) return "recebido";
  return `recebido <t:${Math.floor(timestamp / 1000)}:R>`;
}
function deliveryModal(order) {
  return new ModalBuilder()
    .setCustomId(`deliverymodal:${order.id}`)
    .setTitle(`Entrega #${order.id}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("delivery")
          .setLabel("Mensagem de entrega")
          .setPlaceholder("Cole key, link, conta ou instrucoes de entrega.")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(2)
          .setMaxLength(1800)
          .setRequired(true)
      )
    );
}
async function requestDelivery(interaction, id) {
  const db = readOrders();
  const order = orderForAction(db, id, interaction, false);
  if (!order) return interaction.reply({ content: "Carrinho inexistente.", ephemeral: true });
  if (!isAdmin(interaction.member)) return interaction.reply({ content: "So ADM pode entregar produto.", ephemeral: true });
  if (isOrderProcessing(order)) return interaction.reply({ content: "Essa compra esta sendo finalizada agora.", ephemeral: true });
  if (order.status === ORDER_STATUS.CLOSED) return interaction.reply({ content: "Essa compra ja foi finalizada.", ephemeral: true });
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) return interaction.reply({ content: "Essa compra ja foi cancelada.", ephemeral: true });
  if (order.status !== ORDER_STATUS.OPEN) return interaction.reply({ content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  if (order.deliveredAt) return interaction.reply({ content: "Esse pedido ja foi marcado como entregue.", ephemeral: true });
  if (order.paymentStatus !== "marked_paid" && !order.paidAt) {
    return interaction.reply({ content: "Marque o pagamento como recebido antes de entregar.", ephemeral: true });
  }
  return interaction.showModal(deliveryModal(order));
}
async function deliverOrder(context, id, deliveryText) {
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode entregar produto.", ephemeral: true });
  }

  const guildId = actionGuildId(context);
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order) return actionReply(context, { content: "Carrinho inexistente.", ephemeral: true });
  if (isOrderProcessing(order)) return actionReply(context, { content: "Essa compra esta sendo finalizada agora.", ephemeral: true });
  if (order.status === ORDER_STATUS.CLOSED) return actionReply(context, { content: "Essa compra ja foi finalizada.", ephemeral: true });
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(context, { content: "Essa compra ja foi cancelada.", ephemeral: true });
  }
  if (order.status !== ORDER_STATUS.OPEN) {
    return actionReply(context, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  }
  if (order.deliveredAt) {
    return actionReply(context, { content: `Pedido ja entregue por ${order.deliveredByAdminId ? `<@${order.deliveredByAdminId}>` : "um ADM"}.`, ephemeral: true });
  }
  if (order.paymentStatus !== "marked_paid" && !order.paidAt) {
    return actionReply(context, { content: "Marque o pagamento como recebido antes de entregar.", ephemeral: true });
  }

  const actor = actionUser(context);
  const deliveryMessage = clampText(deliveryText, 1800, "Produto entregue.");
  const panel = getOrderPanel(order, guildId);
  const now = new Date().toISOString();
  order.deliveredAt = now;
  order.deliveredByAdminId = actor.id;
  order.deliveredByAdminName = context.member?.displayName || actor.username;
  order.deliveryMessage = deliveryMessage;
  touchOrder(order);
  appendAuditLog(db, context, "order.delivered", {
    order,
    deliveredBy: actor.id,
    deliveryPreview: deliveryMessage.slice(0, 120)
  });
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);

  const publicDelivery = clampText(deliveryMessage, 1500, "Produto entregue.");
  await context.channel.send({
    content: `<@${order.userId}> Produto entregue no pedido #${order.id} por **${order.deliveredByAdminName || "ADM"}**.\n\n||${publicDelivery}||`,
    embeds: [cartEmbed(order, panel)],
    allowedMentions: { users: [order.userId] }
  }).catch(() => null);

  const dmSent = await sendSafeDM(order.userId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Produto entregue")
        .setDescription(`Pedido #${order.id}\n\n${deliveryMessage}`.slice(0, 4096))
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  const dmText = dmSent ? "Tambem enviei no privado do cliente." : "Nao consegui enviar DM; a entrega ficou registrada no carrinho.";
  return actionReply(context, { content: `Entrega salva no pedido #${order.id}. ${dmText}`, ephemeral: true });
}
async function requestPaymentProof(interaction, id) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);
  }

  const db = readOrders();
  const order = orderForAction(db, id, interaction, false);
  if (!order) return actionReply(interaction, { content: "Carrinho inexistente.", ephemeral: true });
  if (isOrderProcessing(order)) return actionReply(interaction, { content: "Essa compra esta sendo finalizada agora.", ephemeral: true });
  if (order.status === ORDER_STATUS.CLOSED) return actionReply(interaction, { content: "Essa compra ja foi finalizada.", ephemeral: true });
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(interaction, { content: "Essa compra ja foi cancelada.", ephemeral: true });
  }
  if (order.status !== ORDER_STATUS.OPEN) {
    return actionReply(interaction, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  }
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) {
    return actionReply(interaction, { content: "Sem permissao para solicitar comprovante neste carrinho.", ephemeral: true });
  }

  const targetUserId = order.userId;
  const key = imageUploadKey(actionGuildId(interaction), interaction.channel.id, targetUserId);
  paymentProofUploads.set(key, {
    orderId: order.id,
    guildId: actionGuildId(interaction),
    channelId: interaction.channel.id,
    userId: targetUserId,
    requestedById: interaction.user.id,
    expiresAt: Date.now() + PROOF_UPLOAD_TTL_MS
  });

  if (interaction.user.id === targetUserId) {
    return actionReply(interaction, {
      content: "Envie o print do comprovante aqui neste carrinho nos proximos 2 minutos.",
      ephemeral: true
    });
  }

  await interaction.channel.send({
    content: `<@${targetUserId}> envie o print do comprovante aqui neste carrinho nos proximos 2 minutos.`,
    allowedMentions: { users: [targetUserId] }
  }).catch(() => null);

  return actionReply(interaction, { content: `Solicitei o comprovante para <@${targetUserId}>.`, ephemeral: true });
}
async function cancelCart(interaction, id) {
  if (interaction.isRepliable?.() && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);
  }
  const actor = actionUser(interaction);
  const guildId = actionGuildId(interaction);
  const db = readOrders(); const order = orderForAction(db, id, interaction, false);
  if (!order) return actionReply(interaction, { content: "Carrinho inexistente.", ephemeral: true });
  if (recoverStaleProcessingOrder(db, order, interaction)) writeOrders(db);
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(interaction, { content: "Esse carrinho ja foi cancelado.", ephemeral: true });
  }
  if (order.status === ORDER_STATUS.CLOSED) {
    return actionReply(interaction, { content: "Esse carrinho ja foi finalizado.", ephemeral: true });
  }
  if (isOrderProcessing(order)) {
    return actionReply(interaction, { content: "Esse carrinho esta sendo processado agora. Aguarde alguns segundos.", ephemeral: true });
  }
  if (order.status !== ORDER_STATUS.OPEN) return actionReply(interaction, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  if (actor.id !== order.userId && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Sem permissao para cancelar esse carrinho.", ephemeral: true });

  const panel = getOrderPanel(order, guildId);
  const now = new Date().toISOString();
  order.status = ORDER_STATUS.CANCELLED;
  order.cancelledAt = now;
  order.closedAt = now;
  order.cancelledById = actor.id;
  order.cancelledByName = interaction.member?.displayName || actor.username;
  touchOrder(order);
  appendAuditLog(db, interaction, "order.cancelled", { order, reason: "manual_cancel" });
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);
  await sendCancellationNotice(interaction.guild, order, panel, actor, interaction.channel).catch(error => {
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

  await interaction.channel.setName(interaction.channel.name.includes("aberto") ? interaction.channel.name.replace("aberto", "cancelado") : `carrinho-${safeName(order.username)}-cancelado-${order.id}`).catch(() => null);
  if (config.categories.closed) await interaction.channel.setParent(config.categories.closed, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  scheduleCartDeletion(order);
  await interaction.channel.send({ content: `<@${order.userId}> Compra #${order.id} cancelada. Este canal sera apagado automaticamente em 3 dias.`, embeds: [cartEmbed(order, panel)] }).catch(() => null);
  await actionReply(interaction, { content: `Carrinho #${order.id} cancelado e movido para fechados.`, ephemeral: true });
}
async function finishCart(interaction, id, options = {}) {
  if (interaction.isRepliable?.() && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);
  }
  const actor = actionUser(interaction);
  const guildId = actionGuildId(interaction);
  const db = readOrders(); const order = orderForAction(db, id, interaction, false);
  if (!order) return actionReply(interaction, { content: "Carrinho inexistente.", ephemeral: true });
  if (recoverStaleProcessingOrder(db, order, interaction)) writeOrders(db);
  if (isOrderProcessing(order)) {
    return actionReply(interaction, { content: "Essa compra ja esta sendo finalizada. Aguarde alguns segundos.", ephemeral: true });
  }
  if (order.status === ORDER_STATUS.CLOSED) {
    return actionReply(interaction, { content: `Compra #${order.id} ja foi finalizada.`, ephemeral: true });
  }
  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    return actionReply(interaction, { content: `Compra #${order.id} ja foi cancelada.`, ephemeral: true });
  }
  if (!canStartOrderProcessing(order)) return actionReply(interaction, { content: `Carrinho em estado ${orderStatusLabel(order.status)}.`, ephemeral: true });
  if (config.settings.finalizeCartOnlyAdmins && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Só admin finaliza. Clique em **Chamar ADM**.", ephemeral: true });
  if (!Array.isArray(order.items) || !order.items.length) {
    return actionReply(interaction, { content: "Esse carrinho ainda esta vazio. Adicione um produto antes de finalizar.", ephemeral: true });
  }
  const panel = getOrderPanel(order, guildId);
  const stockIssues = orderStockIssues(guildId, order, panel);
  if (stockIssues.length) {
    return actionReply(interaction, {
      content: `Nao da para finalizar por falta de estoque:\n${stockIssues.map(issue => `- ${issue.productName}: ${issue.stock} disponivel, ${issue.requested} solicitado`).join("\n")}`,
      ephemeral: true
    });
  }
  let mysteryResults = [];
  const applyFinalState = processingAt => {
    order.status = ORDER_STATUS.PROCESSING;
    order.processingStartedAt = processingAt;
    order.processingByAdminId = actor.id;
    order.processingByAdminName = interaction.member?.displayName || actor.username;
    touchOrder(order);
    appendAuditLog(db, interaction, "order.finalize_started", { order, itemCount: order.items.length, requestReview: Boolean(options.requestReview) });

    mysteryResults = Array.isArray(order.mysteryResults) && order.mysteryResults.length
      ? order.mysteryResults
      : rollMysteryBoxes(order, panel);
    if (mysteryResults.length) order.mysteryResults = mysteryResults;
    if (order.paymentStatus !== "marked_paid" && !order.paidAt) {
      const paidTotals = orderTotals(order, panel);
      order.paymentStatus = "marked_paid";
      order.paidAt = processingAt;
      order.paidByAdminId = actor.id;
      order.paidByAdminName = interaction.member?.displayName || actor.username;
      order.paidAmount = paidTotals.amount;
      order.paidGrossAmount = paidTotals.grossAmount;
      order.paidDiscountAmount = paidTotals.discountAmount;
      appendAuditLog(db, interaction, "order.payment_auto_marked_paid", {
        order,
        paidAmount: order.paidAmount,
        reason: "finalize_without_manual_paid_step"
      });
    }
    const stockAdjustments = consumeOrderStock(guildId, order, panel);
    if (stockAdjustments.length) {
      appendAuditLog(db, interaction, "order.stock_consumed", { order, stockAdjustments });
    }
    if (!order.deliveredAt) {
      order.deliveredAt = processingAt;
      order.deliveredByAdminId = actor.id;
      order.deliveredByAdminName = interaction.member?.displayName || actor.username;
      order.deliveryMessage = order.deliveryMessage || "Entrega confirmada na finalizacao manual.";
      appendAuditLog(db, interaction, "order.delivery_auto_marked", {
        order,
        reason: "finalize_without_manual_delivery_step"
      });
    }
    order.status = ORDER_STATUS.CLOSED;
    order.closedAt = new Date().toISOString();
    order.closedByAdminId = actor.id;
    order.closedByAdminName = interaction.member?.displayName || actor.username;
    order.finalizedFromProcessingAt = processingAt;
    delete order.processingStartedAt;
    delete order.processingByAdminId;
    delete order.processingByAdminName;
    touchOrder(order);
    recordCustomerSpend(db, order, panel);
    appendAuditLog(db, interaction, "order.finalized", {
      order,
      totalAmount: order.spentAmount,
      grossAmount: order.grossAmount,
      discountAmount: order.discountAmount,
      mysteryRolls: mysteryResults.length
    });
    db.orders[order.id] = order;
  };

  if (!claimOrderActionLock(order)) {
    return actionReply(interaction, { content: "Essa compra ja esta sendo finalizada. Aguarde alguns segundos.", ephemeral: true });
  }

  try {
  const postgresFinalize = await finalizeOrderWithPostgres(db, order, panel, interaction, applyFinalState);
  if (!postgresFinalize.ok) {
    if (postgresFinalize.error) {
      return actionReply(interaction, {
        content: `Nao consegui travar essa compra no banco transacional: ${postgresFinalize.error.message}. Tente de novo em alguns segundos.`,
        ephemeral: true
      });
    }
    return actionReply(interaction, {
      content: `Essa compra ja esta em estado ${orderStatusLabel(postgresFinalize.status)} no banco transacional.`,
      ephemeral: true
    });
  }
  if (!postgresFinalize.used) applyFinalState(new Date().toISOString());
  writeOrders(db);
  await interaction.channel.setName(interaction.channel.name.includes("aberto") ? interaction.channel.name.replace("aberto", "fechado") : `carrinho-${safeName(order.username)}-fechado-${order.id}`).catch(() => null);
  if (config.categories.closed) await interaction.channel.setParent(config.categories.closed, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  const roleGranted = await grantCustomerRole(interaction.guild, order.userId);
  await sendCompletionReceipt(interaction.guild, order, panel, interaction.channel).catch(error => console.log(`Nao consegui enviar recibo da venda ${order.id}: ${error.message}`));
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
  } finally {
    releaseOrderActionLock(order);
  }
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
async function handlePaymentProofUpload(message) {
  const key = imageUploadKey(message.guild.id, message.channel.id, message.author.id);
  const pending = paymentProofUploads.get(key);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    paymentProofUploads.delete(key);
    await message.reply("O tempo para enviar o comprovante expirou. Clique em **Enviar comprovante** de novo.").catch(() => null);
    return false;
  }

  const attachment = message.attachments.find(isImageAttachment);
  if (!attachment) {
    if (message.attachments.size) {
      await message.reply("Recebi um anexo, mas ele nao parece ser imagem. Envie PNG, JPG, WEBP ou GIF.").catch(() => null);
      return true;
    }
    return false;
  }

  const db = readOrders();
  const order = db.orders?.[pending.orderId];
  if (!order || order.guildId !== message.guild.id || order.channelId !== message.channel.id || order.userId !== message.author.id) {
    paymentProofUploads.delete(key);
    await message.reply("Nao consegui vincular esse comprovante ao carrinho. Clique em **Enviar comprovante** novamente.").catch(() => null);
    return true;
  }
  if (isOrderProcessing(order)) {
    paymentProofUploads.delete(key);
    await message.reply("Essa compra esta sendo finalizada agora. Aguarde alguns segundos.").catch(() => null);
    return true;
  }
  if (order.status === ORDER_STATUS.CLOSED || order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.CANCELED) {
    paymentProofUploads.delete(key);
    await message.reply("Esse carrinho ja foi fechado. O comprovante nao foi alterado.").catch(() => null);
    return true;
  }
  if (order.status !== ORDER_STATUS.OPEN) {
    await message.reply(`Carrinho em estado ${orderStatusLabel(order.status)}. O comprovante nao foi salvo.`).catch(() => null);
    return true;
  }

  const panel = getOrderPanel(order, message.guild.id);
  const now = new Date().toISOString();
  const proof = {
    url: attachment.url,
    proxyUrl: attachment.proxyURL || attachment.proxyUrl || "",
    name: attachment.name || "comprovante",
    contentType: attachment.contentType || "",
    size: attachment.size || 0,
    messageId: message.id,
    submittedAt: now,
    submittedById: message.author.id,
    requestedById: pending.requestedById || ""
  };
  if (!Array.isArray(order.paymentProofs)) order.paymentProofs = [];
  order.paymentProofs.push(proof);
  order.paymentProofSubmittedAt = now;
  order.paymentProofLatestUrl = attachment.url;
  if (!order.paymentStatus || order.paymentStatus === "pending") order.paymentStatus = "proof_received";
  touchOrder(order);
  appendAuditLog(db, message, "order.payment_proof_uploaded", {
    order,
    attachmentUrl: attachment.url,
    attachmentName: attachment.name,
    messageId: message.id
  });
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);
  paymentProofUploads.delete(key);

  await message.reply("Comprovante recebido e salvo no pedido. A equipe vai conferir o pagamento.").catch(() => null);
  await message.channel.send({
    content: `<@&${config.adminRoleId}> comprovante enviado no pedido #${order.id} por <@${order.userId}>.`,
    embeds: [cartEmbed(order, panel)],
    components: [cartButtons(order.id)],
    allowedMentions: { roles: [config.adminRoleId], users: [order.userId] }
  }).catch(() => null);
  return true;
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
  writeAuditLog(message, pending.target === "product" ? "product.image_updated" : "panel.image_updated", {
    scopeId: s.scopeId,
    panelId: panel.id,
    target: pending.target,
    productId: pending.productId || "",
    imageMessageId: savedImage.messageId || "",
    imageUrl: savedImage.url
  });
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

function statusVoiceChannelId() {
  return String(process.env.STATUS_VOICE_CHANNEL_ID || config.statusVoice?.channelId || DEFAULT_STATUS_VOICE_CHANNEL_ID).trim();
}
function statusVoiceEnabled() {
  return config.statusVoice?.enabled !== false && process.env.STATUS_VOICE_ENABLED !== "false";
}
function scheduleStatusVoiceReconnect(delayMs = 30000) {
  if (statusVoiceReconnectTimer || !statusVoiceEnabled()) return;
  statusVoiceReconnectTimer = setTimeout(() => {
    statusVoiceReconnectTimer = null;
    connectStatusVoiceChannel().catch(error => {
      console.log(`Nao consegui reconectar na call de status: ${error.message}`);
      scheduleStatusVoiceReconnect();
    });
  }, delayMs);
}
function watchStatusVoiceConnection(connection) {
  if (connection.__dragonStoreStatusWatcher) return;
  connection.__dragonStoreStatusWatcher = true;
  connection.on("stateChange", (_, state) => {
    if (state.status === VoiceConnectionStatus.Destroyed || state.status === VoiceConnectionStatus.Disconnected) {
      scheduleStatusVoiceReconnect(state.status === VoiceConnectionStatus.Disconnected ? 10000 : 30000);
    }
  });
  connection.on("error", error => {
    console.log(`Erro na call de status: ${error.message}`);
    scheduleStatusVoiceReconnect(15000);
  });
}
async function connectStatusVoiceChannel() {
  if (!statusVoiceEnabled()) return null;
  const channelId = statusVoiceChannelId();
  if (!channelId) return null;

  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
    console.log(`Call de status ${channelId} nao encontrada ou nao e canal de voz.`);
    return null;
  }

  const botMember = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null);
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (permissions && !permissions.has(PermissionFlagsBits.Connect)) {
    console.log(`Sem permissao para entrar na call de status ${channel.name || channel.id}.`);
    return null;
  }

  const existing = getVoiceConnection(channel.guild.id);
  const existingChannelId = existing?.joinConfig?.channelId;
  const reusableStatuses = new Set([
    VoiceConnectionStatus.Ready,
    VoiceConnectionStatus.Signalling,
    VoiceConnectionStatus.Connecting
  ]);
  if (existing && existingChannelId === channel.id && reusableStatuses.has(existing.state.status)) {
    watchStatusVoiceConnection(existing);
    return existing;
  }
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    existing.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true
  });
  watchStatusVoiceConnection(connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    console.log(`Bot entrou na call de status: ${channel.name || channel.id}`);
  } catch (error) {
    console.log(`Nao consegui confirmar entrada na call de status ${channel.name || channel.id}: ${error.message}`);
    connection.destroy();
    scheduleStatusVoiceReconnect(30000);
  }
  return connection;
}

client.once("ready", async () => {
  console.log(`Bot online como ${client.user.tag}`);
  await connectStatusVoiceChannel().catch(error => {
    console.log(`Nao consegui entrar na call de status: ${error.message}`);
    scheduleStatusVoiceReconnect();
  });
  const recoveredProcessing = recoverStaleProcessingOrders();
  if (recoveredProcessing) console.log(`${recoveredProcessing} carrinho(s) preso(s) em processing foram reabertos automaticamente.`);
  for (const guild of client.guilds.cache.values()) {
    await ensureStaffState(guild, null).catch(error => {
      console.log(`Nao consegui recuperar atendimento em ${guild.id}: ${error.message}`);
    });
    await refreshStaffPanel(guild.id).catch(() => null);
    const panelStore = readPanels();
    const guildStore = ensurePanelStore(panelStore, guild.id);
    const permissionWarnings = await discordPermissionWarnings(guild, allPublicPanels(guildStore), getStaffGuild(guild.id)).catch(error => [`Falha ao validar permissoes: ${error.message}`]);
    if (permissionWarnings.length) {
      console.log(`Alertas de permissao em ${guild.name || guild.id}:\n- ${permissionWarnings.join("\n- ")}`);
    }
  }
  scheduleExistingClosedCarts();
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (await handlePaymentProofUpload(message)) return;
  if (await handlePendingImageUpload(message)) return;
  const rawContent = message.content.trim();
  const content = rawContent.toLowerCase();
  const plainContent = content.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const prefix = config.prefix || "!";

  if (content === `${config.prefix || "!"}help`) {
    return sendHelpCommand(message);
  }

  if ([`${config.prefix || "!"}configds`, `${config.prefix || "!"}painel`, `${config.prefix || "!"}loja`, `${config.prefix || "!"}setup`].includes(content)) {
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

  if ([`${config.prefix || "!"}pix`, `${config.prefix || "!"}assumir`].includes(content)) {
    return sendPixCommand(message);
  }

  if ([`${config.prefix || "!"}concluircompra`, `${config.prefix || "!"}concluir`, `${config.prefix || "!"}finalizarcompra`, `${config.prefix || "!"}finalizar`].includes(content)) {
    return finishCurrentCartCommand(message);
  }

  if ([`${config.prefix || "!"}pago`, `${config.prefix || "!"}marcarpago`, `${config.prefix || "!"}pagamento`].includes(content)) {
    return markPaidCurrentCartCommand(message);
  }

  if (content.startsWith(`${config.prefix || "!"}entregar`)) {
    return deliverCurrentCartCommand(message, rawContent);
  }

  if ([`${config.prefix || "!"}cancelarcompra`, `${config.prefix || "!"}cancelar`].includes(content)) {
    return cancelCurrentCartCommand(message);
  }

  const addCartCommand = [`${prefix}addcar`, `${prefix}addcart`, `${prefix}adicionar`]
    .find(command => content === command || content.startsWith(`${command} `));
  if (addCartCommand) {
    return sendAddCartCommand(message, rawContent.slice(addCartCommand.length).trim());
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
  if ([`${config.prefix || "!"}diagnostico`, `${config.prefix || "!"}diagnóstico`, `${config.prefix || "!"}diag`].includes(content)) {
    await message.delete().catch(() => null);
    return sendDiagnosticsCommand(message);
  }
  if (content === `${config.prefix || "!"}pedidos`) {
    await message.delete().catch(() => null);
    return showOpenOrders(message);
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

client.on("interactionCreate", interaction => {
  handleInteraction(interaction).catch(error => handleInteractionError(interaction, error));
});

async function handleInteraction(interaction) {
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
      if (interaction.commandName === "pedidos") return showOpenOrders(interaction);
      if (interaction.commandName === "diagnostico") return sendDiagnosticsCommand(interaction);
      if (interaction.commandName === "pago") {
        const order = findOrderInChannel(readOrders(), interaction, false);
        if (!order) return actionReply(interaction, { content: "Nao encontrei carrinho neste canal.", ephemeral: true });
        return markOrderPaid(interaction, order.id);
      }
      if (interaction.commandName === "entregar") {
        const order = findOrderInChannel(readOrders(), interaction, false);
        if (!order) return actionReply(interaction, { content: "Nao encontrei carrinho neste canal.", ephemeral: true });
        return requestDelivery(interaction, order.id);
      }
      if (interaction.commandName === "addcar") {
        return startAddCartFlow(interaction, interaction.options.getString("pesquisa") || "");
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
      if (interaction.customId.startsWith("addcar:")) return handleAddCartButton(interaction);
      if (interaction.customId.startsWith("rank:")) {
        const [, period, page] = interaction.customId.split(":");
        return showSpendRanking(interaction, period, Number(page) || 0);
      }
      if (interaction.customId.startsWith("orders:")) return handleOpenOrdersButton(interaction);
      if (interaction.customId.startsWith("quickbuy:")) {
        const [, panelId] = interaction.customId.split(":");
        return handleQuickBuyButton(interaction, panelId);
      }
      if (interaction.customId === "openticket") return openTicket(interaction);
      const [act, id] = interaction.customId.split(":");
      if (act === "call") return callAdmin(interaction, id, "order");
      if (act === "view") return viewCart(interaction, id);
      if (act === "paid") return markOrderPaid(interaction, id);
      if (act === "proof") return requestPaymentProof(interaction, id);
      if (act === "deliver") return requestDelivery(interaction, id);
      if (act === "finish") return finishCart(interaction, id);
      if (act === "cancel") return cancelCart(interaction, id);
      if (act === "assume") return assumeOrder(interaction, id);
      if (act === "sendpix") return resendPix(interaction, id);
      if (act === "tcall") return callAdmin(interaction, id, "ticket");
      if (act === "tclose") return closeTicket(interaction, id);
    }
    if (interaction.isModalSubmit() && interaction.customId === "pixmodal") return handlePixModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("addcarsearch:")) return handleAddCartSearchSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("addcarqty:")) return handleAddCartQuantitySubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("quickmodal:")) return handleQuickOrderSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("deliverymodal:")) {
      const [, id] = interaction.customId.split(":");
      return deliverOrder(interaction, id, interaction.fields.getTextInputValue("delivery"));
    }
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
      if (interaction.customId.startsWith("addcarpick:")) return handleAddCartPick(interaction);
    }
}

async function handleInteractionError(interaction, err) {
  console.error(err);
  const payload = { content: `Erro: \`${err.message}\``, ephemeral: true };
  await actionReply(interaction, payload).catch(() => null);
}

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("DISCORD_TOKEN não configurado.");
  process.exit(1);
}
function shutdown(signal) {
  console.log(`${signal} recebido; salvando persistencia pendente antes de sair.`);
  drainPersistentWriteQueues()
    .finally(() => closePostgresPool())
    .finally(() => process.exit(0));
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
async function boot() {
  await hydratePersistentFiles();
  await client.login(token);
}
boot().catch(error => {
  console.error("Falha ao iniciar bot:", error);
  process.exit(1);
});
