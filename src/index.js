require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { Pool } = require("pg");
const { buildPostgresPoolOptions, postgresTargetSummary } = require("./postgresConfig");
const oauthConfig = require("./config");
const instanceConfig = require("./instanceConfig");
const { countVerifiedUsers } = require("./verifiedStore");
const { createOAuthServer, pullVerifiedUsersToBackup } = require("./oauthServer");
const { createServerBackup, restoreServerBackup, validateServerBackup } = require("./serverBackup");
const { currentSetupSummary, provisionStoreSetup } = require("./storeSetup");
const { QUICK_PANEL_TEMPLATE, parseQuickPanelTemplate } = require("./quickPanelTemplate");
const {
  PAYMENT_METHOD,
  automaticPaymentRecoveryAvailable,
  calculateServerCart,
  isAmbiguousPaymentProviderFailure,
  paymentProviderHttpStatus,
  resolvePaymentMethod
} = require("./paymentPolicy");
const { isAuthorizedOwner, parseOwnerIds } = require("./securityPolicy");
const { createPixOrder, getPagBankOrder, normalizeCustomer, pagBankConfig, pagBankReady, paidPixCharge, validatePaidPixNotification, verifyWebhookSignature } = require("./pagBank");
const { createMercadoPagoPix, getMercadoPagoPayment, mercadoPagoConfig, mercadoPagoReady, validateApprovedMercadoPagoPayment, verifyMercadoPagoSignature } = require("./mercadoPago");
const {
  downloadAndValidateProof,
  findLatestProofAttachment,
  proofMaxBytes,
  safeProofFilename,
  validateProofMetadata
} = require("./proofAttachment");
const {
  ntfyReady,
  sendAutomaticPaymentNotification,
  sendManualProofNotification,
  sendNtfyTestNotification
} = require("./services/notificationService");
const {
  inactivityMs,
  initializeActivity,
  isInactive,
  isManualInactivityCandidate,
  manualPaymentConfirmationMode,
  manualNotificationCooldownMs,
  manualNotificationRemaining,
  markHumanActivity,
  paymentChoiceAvailability,
  recordManualNotification
} = require("./orderLifecycle");
const {
  STOCK_MODE,
  STOCK_STATUS,
  addStock,
  clearAvailableStock,
  decryptStockValue,
  disableStockItem,
  encryptionKey: validateStockEncryptionKey,
  listStock,
  markOrderStockSold,
  releaseOrderStock,
  reserveStock,
  reservedStockForOrder,
  setStockMode,
  stockSummary
} = require("./stockStore");
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
const INSTANCE_FILE_SUFFIX = instanceConfig.STORE_INSTANCE_ID === "primary" ? "" : `.${instanceConfig.STORE_INSTANCE_ID}`;
const STAFF_BACKUP_FILE = `dragon-store-staff-backup${INSTANCE_FILE_SUFFIX}.json`;

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, "..", "data");
const PANELS_FILE = path.join(DATA_DIR, `panels${INSTANCE_FILE_SUFFIX}.json`);
const ORDERS_FILE = path.join(DATA_DIR, `orders${INSTANCE_FILE_SUFFIX}.json`);
const STAFF_FILE = path.join(DATA_DIR, `staff${INSTANCE_FILE_SUFFIX}.json`);
const SITE_ANALYTICS_FILE = path.join(DATA_DIR, `site-analytics${INSTANCE_FILE_SUFFIX}.json`);
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const BOT_KV_PREFIX = instanceConfig.isolatedStoragePrefix(process.env.BOT_KV_PREFIX);
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "";
const BOT_DB_PREFIX = instanceConfig.isolatedStoragePrefix(process.env.BOT_DB_PREFIX || BOT_KV_PREFIX);
const KV_FILE_KEYS = {
  [PANELS_FILE]: `${BOT_KV_PREFIX}:panels`,
  [ORDERS_FILE]: `${BOT_KV_PREFIX}:orders`,
  [STAFF_FILE]: `${BOT_KV_PREFIX}:staff`,
  [SITE_ANALYTICS_FILE]: `${BOT_KV_PREFIX}:site-analytics`
};
const DB_FILE_KEYS = {
  [PANELS_FILE]: `${BOT_DB_PREFIX}:panels`,
  [ORDERS_FILE]: `${BOT_DB_PREFIX}:orders`,
  [STAFF_FILE]: `${BOT_DB_PREFIX}:staff`,
  [SITE_ANALYTICS_FILE]: `${BOT_DB_PREFIX}:site-analytics`
};
const memoryJsonStore = new Map();
const kvWriteQueues = new Map();
const postgresWriteQueues = new Map();
let postgresPool = null;
let postgresStoreReady = false;

function errorSummary(error) {
  if (!error) return { message: "Erro desconhecido" };
  return {
    message: String(error.message || error).slice(0, 500),
    code: error.code ?? undefined,
    status: error.status ?? undefined,
    method: error.method ?? undefined
  };
}

process.on("unhandledRejection", error => {
  console.error("Erro async nao tratado:", errorSummary(error));
});
process.on("uncaughtException", error => {
  console.error("Erro fatal nao tratado:", errorSummary(error));
  drainPersistentWriteQueues().finally(() => closePostgresPool()).finally(() => process.exit(1));
});

ensureDataDir();
ensureJsonFile(PANELS_FILE, { guilds: {} });
ensureJsonFile(ORDERS_FILE, { orders: {}, tickets: {}, customers: {}, sellers: {}, auditLogs: [] });
ensureJsonFile(STAFF_FILE, { guilds: {} });
ensureJsonFile(SITE_ANALYTICS_FILE, { events: [] });

const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates];
if (process.env.ENABLE_MESSAGE_CONTENT_INTENT !== "false") gatewayIntents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents: gatewayIntents });
const oauthHttp = createOAuthServer(client, handleHttpRequest, handlePagBankWebhook, handleMercadoPagoWebhook);
client.on("error", error => {
  console.error("Erro do client Discord:", errorSummary(error));
});
client.on("shardError", error => {
  console.error("Erro de shard Discord:", errorSummary(error));
});

const sessions = new Map();
const addCartSessions = new Map();
const imageUploads = new Map();
const paymentProofUploads = new Map();
const cartDeleteTimers = new Map();
const ticketDeleteTimers = new Map();
const publicPanelScanCache = new Map();
const orderActionLocks = new Set();
const automaticNotificationLocks = new Set();
const ticketInactivityLocks = new Set();
const statusVoiceReconnectTimers = new Map();
const serverRestoreSessions = new Map();
const stockAdminSessions = new Map();
const IMAGE_UPLOAD_TTL_MS = 3 * 60 * 1000;
const PROOF_UPLOAD_TTL_MS = 2 * 60 * 1000;
const MAX_SAVED_IMAGE_BYTES = 8 * 1024 * 1024;
const ADD_CART_SESSION_TTL_MS = 10 * 60 * 1000;
const SERVER_RESTORE_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SERVER_BACKUP_BYTES = 8 * 1024 * 1024;
const CONFIG_SESSION_TTL_MS = 14 * 60 * 1000;
const EPHEMERAL_CLEANUP_INTERVAL_MS = 60 * 1000;
const MERCADOPAGO_RECONCILE_INTERVAL_MS = Math.max(10, Math.min(300, Number(process.env.MERCADOPAGO_RECONCILE_INTERVAL_SECONDS) || 20)) * 1000;
const MERCADOPAGO_RECONCILE_BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.MERCADOPAGO_RECONCILE_BATCH_SIZE) || 15));
const MERCADOPAGO_SETTLEMENT_GRACE_MS = Math.max(1, Math.min(60, Number(process.env.MERCADOPAGO_SETTLEMENT_GRACE_MINUTES) || 5)) * 60 * 1000;
const MERCADOPAGO_ERROR_GRACE_MS = Math.max(5, Math.min(180, Number(process.env.MERCADOPAGO_ERROR_GRACE_MINUTES) || 30)) * 60 * 1000;
const INACTIVITY_SWEEP_INTERVAL_MS = Math.max(60, Math.min(3600, Number(process.env.CART_INACTIVITY_SWEEP_SECONDS) || 300)) * 1000;
const mercadoPagoLastChecks = new Map();
const mercadoPagoLastErrorLogs = new Map();

function sweepExpiredEntries(map, now = Date.now()) {
  let removed = 0;
  for (const [key, value] of map.entries()) {
    if (Number(value?.expiresAt || 0) > 0 && Number(value.expiresAt) <= now) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}
function cleanupEphemeralState() {
  const now = Date.now();
  return sweepExpiredEntries(sessions, now) +
    sweepExpiredEntries(addCartSessions, now) +
    sweepExpiredEntries(imageUploads, now) +
    sweepExpiredEntries(paymentProofUploads, now) +
    sweepExpiredEntries(serverRestoreSessions, now) +
    sweepExpiredEntries(stockAdminSessions, now);
}
function ephemeralStateStats() {
  return {
    configSessions: sessions.size,
    addCartSessions: addCartSessions.size,
    imageUploads: imageUploads.size,
    paymentProofUploads: paymentProofUploads.size,
    restoreSessions: serverRestoreSessions.size,
    stockAdminSessions: stockAdminSessions.size,
    actionLocks: orderActionLocks.size
  };
}
const ephemeralCleanupTimer = setInterval(cleanupEphemeralState, EPHEMERAL_CLEANUP_INTERVAL_MS);
ephemeralCleanupTimer.unref?.();
let paymentExpirySweepRunning = false;
async function sweepExpiredPayments() {
  if (paymentExpirySweepRunning) return;
  paymentExpirySweepRunning = true;
  try {
    const db = readOrders();
    const now = Date.now();
    for (const order of Object.values(db.orders || {})) {
      if (order.status !== ORDER_STATUS.OPEN || order.paymentState !== PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT) continue;
      const expiresAt = Date.parse(order.paymentExpiresAt || "");
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
      if (order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX && order.mercadoPagoPaymentId) {
        try {
          const result = await reconcileMercadoPagoOrder(order, "mercadopago_expiry_check");
          if (result.ok || result.processing) continue;
          if (now < expiresAt + MERCADOPAGO_SETTLEMENT_GRACE_MS) continue;
        } catch (error) {
          logMercadoPagoReconcileError(order, error, "expiracao");
          if (now < expiresAt + MERCADOPAGO_ERROR_GRACE_MS) continue;
        }
      }
      if (!claimOrderActionLock(order)) continue;
      try {
        if (order.stockReservedAt && postgresEnabled()) await releaseOrderStock(getPostgresPool(), order.id);
        order.paymentState = PAYMENT_STATE.EXPIRED;
        order.paymentExpiredAt = new Date().toISOString();
        delete order.stockReservedAt;
        touchOrder(order);
        appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: client.user?.id || "bot", username: "bot" } }, "order.payment_expired", { order });
        const panel = getOrderPanel(order, order.guildId);
        await persistPaymentOrder(db, order, panel);
        const guild = client.guilds.cache.get(order.guildId);
        const channel = guild ? await guild.channels.fetch(order.channelId).catch(() => null) : null;
        if (channel?.isTextBased()) {
          await channel.send({ content: `<@${order.userId}> o pagamento do pedido #${order.id} expirou e a reserva foi liberada.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
          await refreshCartMessage(guild, order, panel, channel);
        }
      } finally {
        releaseOrderActionLock(order);
      }
    }
  } finally {
    paymentExpirySweepRunning = false;
  }
}
const paymentExpiryTimer = setInterval(() => sweepExpiredPayments().catch(error => console.error("Falha ao expirar pagamentos:", errorSummary(error))), 60_000);
paymentExpiryTimer.unref?.();
let mercadoPagoReconcileSweepRunning = false;
function logMercadoPagoReconcileError(order, error, source) {
  const key = String(order?.id || "unknown");
  const now = Date.now();
  if (now - Number(mercadoPagoLastErrorLogs.get(key) || 0) < 5 * 60 * 1000) return;
  mercadoPagoLastErrorLogs.set(key, now);
  console.warn(`Mercado Pago ${source}: consulta do pedido #${key} falhou: ${errorSummary(error).message}`);
}
async function sweepPendingMercadoPagoPayments() {
  if (mercadoPagoReconcileSweepRunning || !client.isReady() || !mercadoPagoReady()) return;
  mercadoPagoReconcileSweepRunning = true;
  try {
    const now = Date.now();
    const pending = Object.values(readOrders().orders || {})
      .filter(order => order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX && order.mercadoPagoPaymentId)
      .filter(order => [PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT, PAYMENT_STATE.EXPIRED, PAYMENT_STATE.CANCELED, PAYMENT_STATE.DELIVERING].includes(order.paymentState) ||
        (order.paymentState === PAYMENT_STATE.PAID && Number(order.paymentSnapshot?.automaticUnits) > 0 && !order.automaticStockDeliveredAt));
    const activeIds = new Set(pending.map(order => String(order.id)));
    for (const key of mercadoPagoLastChecks.keys()) if (!activeIds.has(key)) mercadoPagoLastChecks.delete(key);
    for (const key of mercadoPagoLastErrorLogs.keys()) if (!activeIds.has(key)) mercadoPagoLastErrorLogs.delete(key);
    const candidates = pending
      .filter(order => {
        const lastCheck = Number(mercadoPagoLastChecks.get(String(order.id)) || 0);
        const expiresAt = Date.parse(order.paymentExpiresAt || "");
        const withinRecoveryWindow = !Number.isFinite(expiresAt) || now <= expiresAt + 24 * 60 * 60 * 1000;
        return withinRecoveryWindow && now - lastCheck >= MERCADOPAGO_RECONCILE_INTERVAL_MS;
      })
      .sort((a, b) => Number(mercadoPagoLastChecks.get(String(a.id)) || 0) - Number(mercadoPagoLastChecks.get(String(b.id)) || 0))
      .slice(0, MERCADOPAGO_RECONCILE_BATCH_SIZE);

    for (const order of candidates) {
      mercadoPagoLastChecks.set(String(order.id), Date.now());
      try {
        const result = await reconcileMercadoPagoOrder(order, "mercadopago_poll");
        if (result.ok && !result.duplicate && !result.processing) {
          console.log(`Mercado Pago: pedido #${order.id} confirmado automaticamente por reconciliacao.`);
        }
      } catch (error) {
        logMercadoPagoReconcileError(order, error, "reconciliacao automatica");
      }
    }
  } finally {
    mercadoPagoReconcileSweepRunning = false;
  }
}
const mercadoPagoReconcileTimer = setInterval(() => sweepPendingMercadoPagoPayments().catch(error => console.error("Falha na reconciliacao Mercado Pago:", errorSummary(error))), MERCADOPAGO_RECONCILE_INTERVAL_MS);
mercadoPagoReconcileTimer.unref?.();

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
  if (file === SITE_ANALYTICS_FILE) return Array.isArray(data.events) && data.events.length > 0;
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
function getPostgresPool() {
  if (!postgresEnabled()) return null;
  if (!postgresPool) {
    const options = buildPostgresPoolOptions(DATABASE_URL);
    const target = postgresTargetSummary(DATABASE_URL, options);
    console.log(`Postgres: ${target.host}:${target.port}/${target.database} | TLS ${target.tls} | negociacao ${target.negotiation}`);
    postgresPool = new Pool(options);
  }
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
    [STAFF_FILE, { guilds: {} }],
    [SITE_ANALYTICS_FILE, { events: [] }]
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
  if (value === ORDER_STATUS.EXPIRED_INACTIVITY) return "expired";
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
async function automaticProductHasStock(guildId, panel, productItem, quantity = 1) {
  if (productItem?.stockMode !== STOCK_MODE.AUTOMATIC) return true;
  if (!panel?.id) return false;
  if (stockRuntimeError()) return false;
  await withPostgresTransaction(client => upsertPanelRelational(client, guildId, panel));
  const summary = await stockSummary(getPostgresPool(), dbProductId(panel.id, productItem.id), guildId);
  return summary.AVAILABLE >= Math.max(1, Number(quantity) || 1);
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
        stock_label, stock_quantity, type, image_url, rewards, stock_mode, active, updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,true,now())
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
        stock_mode = excluded.stock_mode,
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
      dbJson(Array.isArray(productItem.rewards) ? productItem.rewards : [], []),
      productItem.stockMode === STOCK_MODE.AUTOMATIC ? STOCK_MODE.AUTOMATIC : STOCK_MODE.MANUAL
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
      payment_method, payment_state, total_cents_snapshot, pagbank_order_id,
      pagbank_reference_id, pagbank_charge_id, payment_expires_at, created_at, updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
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
      payment_method = excluded.payment_method,
      payment_state = excluded.payment_state,
      total_cents_snapshot = excluded.total_cents_snapshot,
      pagbank_order_id = excluded.pagbank_order_id,
      pagbank_reference_id = excluded.pagbank_reference_id,
      pagbank_charge_id = excluded.pagbank_charge_id,
      payment_expires_at = excluded.payment_expires_at,
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
    dbText(order.paymentMethod) || null,
    dbText(order.paymentState) || null,
    Number.isSafeInteger(order.totalCentsSnapshot) ? order.totalCentsSnapshot : null,
    dbText(order.pagBankOrderId) || null,
    dbText(order.pagBankReferenceId) || null,
    dbText(order.pagBankChargeId) || null,
    order.paymentExpiresAt || null,
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
      payment_method = $21,
      payment_state = $22,
      total_cents_snapshot = $23,
      pagbank_order_id = $24,
      pagbank_reference_id = $25,
      pagbank_charge_id = $26,
      payment_expires_at = $27,
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
    order.cancelledAt || null,
    dbText(order.paymentMethod) || null,
    dbText(order.paymentState) || null,
    Number.isSafeInteger(order.totalCentsSnapshot) ? order.totalCentsSnapshot : null,
    dbText(order.pagBankOrderId) || null,
    dbText(order.pagBankReferenceId) || null,
    dbText(order.pagBankChargeId) || null,
    order.paymentExpiresAt || null
  ]);
  await dbClient.query(`
    update orders set
      last_interaction_at = $2,
      manual_payment_notification_sent_at = $3,
      manual_payment_notification_sent_by = $4,
      automatic_payment_notification_key = $5,
      manually_approved_by = $6,
      manually_approved_at = $7
    where id = $1
  `, [
    dbText(order.id),
    order.lastInteractionAt || order.updatedAt || order.createdAt || new Date().toISOString(),
    order.manualPaymentNotificationSentAt || null,
    dbText(order.manualPaymentNotificationSentBy) || null,
    dbText(order.automaticPaymentNotificationKey) || null,
    dbText(order.manuallyApprovedBy) || null,
    order.manuallyApprovedAt || null
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
  const method = order.paymentMethod === PAYMENT_METHOD.PAGBANK_PIX ? "pix_pagbank" : order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? "pix_mercadopago" : "pix_manual";
  const markedAt = order.paidAt || order.paymentProofSubmittedAt || order.closedAt || new Date().toISOString();
  await upsertGuildRelational(dbClient, order.guildId || "default");
  await dbClient.query(`
    insert into payments (
      external_id, order_id, guild_id, status, amount_cents, method,
      staff_user_id, proof_attachment_url, marked_paid_at, created_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
    on conflict (external_id) do update set
      status = excluded.status,
      amount_cents = excluded.amount_cents,
      method = excluded.method,
      staff_user_id = excluded.staff_user_id,
      proof_attachment_url = excluded.proof_attachment_url,
      marked_paid_at = excluded.marked_paid_at
  `, [
    `payment_${dbText(order.id)}_${method}`,
    dbText(order.id),
    dbText(order.guildId, "default"),
    status,
    dbCents(amount),
    method,
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
        insert into staff (guild_id, user_id, display_name, pix_key_encrypted, pix_key_type, pix_city, qr_code_url, note, online, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
        on conflict (guild_id, user_id) do update set
          display_name = excluded.display_name,
          pix_key_encrypted = coalesce(excluded.pix_key_encrypted, staff.pix_key_encrypted),
          pix_key_type = excluded.pix_key_type,
          pix_city = excluded.pix_city,
          qr_code_url = excluded.qr_code_url,
          note = excluded.note,
          online = excluded.online,
          updated_at = now()
      `, [
        dbText(guildId, "default"),
        dbText(profile.userId || userId),
        dbText(profile.displayName),
        encryptPixKeyForDb(profile.pixKey),
        dbText(profile.pixKeyType),
        dbText(profile.pixCity),
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
  if (!store.webOrders || typeof store.webOrders !== "object" || Array.isArray(store.webOrders)) store.webOrders = {};
  if (!store.customers || typeof store.customers !== "object" || Array.isArray(store.customers)) store.customers = {};
  if (!store.sellers || typeof store.sellers !== "object" || Array.isArray(store.sellers)) store.sellers = {};
  if (!store.manualNotificationRateLimits || typeof store.manualNotificationRateLimits !== "object" || Array.isArray(store.manualNotificationRateLimits)) store.manualNotificationRateLimits = {};
  const rateLimitCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(store.manualNotificationRateLimits)) {
    const timestamp = Date.parse(String(value || ""));
    if (!Number.isFinite(timestamp) || timestamp < rateLimitCutoff) delete store.manualNotificationRateLimits[key];
  }
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
    initializeActivity(order);
  }

  for (const [id, ticket] of Object.entries(store.tickets)) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
      delete store.tickets[id];
      continue;
    }
    ticket.id = String(ticket.id || id);
    ticket.status = String(ticket.status || "open");
    ticket.createdAt = ticket.createdAt || new Date().toISOString();
    initializeActivity(ticket);
  }

  for (const [id, webOrder] of Object.entries(store.webOrders)) {
    if (!webOrder || typeof webOrder !== "object" || Array.isArray(webOrder)) {
      delete store.webOrders[id];
      continue;
    }
    webOrder.id = String(webOrder.id || id).toUpperCase();
    webOrder.items = Array.isArray(webOrder.items) ? webOrder.items.filter(Boolean) : [];
    webOrder.status = String(webOrder.status || "pending_discord");
    webOrder.createdAt = webOrder.createdAt || new Date().toISOString();
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
  CANCELED: "canceled",
  EXPIRED_INACTIVITY: "expired_inactivity"
};
const PAYMENT_STATE = Object.freeze({
  AWAITING_MANUAL_PAYMENT: "AWAITING_MANUAL_PAYMENT",
  MANUAL_PAYMENT_UNDER_REVIEW: "MANUAL_PAYMENT_UNDER_REVIEW",
  MANUAL_PAYMENT_APPROVED: "MANUAL_PAYMENT_APPROVED",
  MANUAL_PAYMENT_REJECTED: "MANUAL_PAYMENT_REJECTED",
  AWAITING_PAGBANK_PAYMENT: "AWAITING_PAGBANK_PAYMENT",
  PAID: "PAID",
  DELIVERING: "DELIVERING",
  DELIVERED: "DELIVERED",
  PAID_DELIVERY_PENDING: "PAID_DELIVERY_PENDING",
  EXPIRED: "EXPIRED",
  CANCELED: "CANCELED"
});
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
  if (value === ORDER_STATUS.EXPIRED_INACTIVITY) return "Expirado por inatividade";
  return value;
}
function paymentStatusLabel(order) {
  if (order?.paymentState === PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT) {
    return order?.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? "Aguardando Pix Mercado Pago" : "Aguardando Pix PagBank";
  }
  if (order?.paymentState === PAYMENT_STATE.AWAITING_MANUAL_PAYMENT) return "Aguardando Pix manual";
  if (order?.paymentState === PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW) return "Comprovante em analise";
  if (order?.paymentState === PAYMENT_STATE.MANUAL_PAYMENT_REJECTED) return "Pagamento recusado";
  if ([PAYMENT_STATE.PAID, PAYMENT_STATE.MANUAL_PAYMENT_APPROVED, PAYMENT_STATE.DELIVERING, PAYMENT_STATE.DELIVERED, PAYMENT_STATE.PAID_DELIVERY_PENDING].includes(order?.paymentState)) return "Pagamento confirmado";
  if (order?.paymentState === PAYMENT_STATE.EXPIRED) return "Pagamento expirado";
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
  if (order?.paymentState === PAYMENT_STATE.PAID_DELIVERY_PENDING) return "Pago, entrega pendente";
  if (order?.paymentState === PAYMENT_STATE.DELIVERING) return "Entregando";
  if (order?.paymentState === PAYMENT_STATE.DELIVERED) return "Entregue automaticamente";
  if (order?.deliveredAt) {
    const by = order.deliveredByAdminId ? ` por <@${order.deliveredByAdminId}>` : "";
    return `Entregue${by}`;
  }
  if (order?.paymentStatus === "marked_paid" || order?.paidAt) return "Pago, aguardando entrega";
  return "Aguardando pagamento";
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
    const sensitiveField = /token|secret|password|pixkey|pixcopypaste|qrcode|deliverymessage|deliverypreview|encrypted|auth.?tag|proof.*url/i;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !sensitiveField.test(key))
      .slice(0, 30)
      .map(([key, item]) => [key, compactAuditValue(item, depth + 1)]));
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
    customerRoleId: "",
    serverConfig: {}
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
  db.guilds[guildId] = { ...defaultStaffGuild(), ...staffGuild, users: staffGuild.users || {}, serverConfig: staffGuild.serverConfig || {} };
  writeStaff(db);
  persistStaffGuildRelationalAsync(guildId, db.guilds[guildId]);
}
function serverConfig(guildId) {
  return getStaffGuild(guildId).serverConfig || {};
}
function saveServerConfig(guildId, patch) {
  const staff = getStaffGuild(guildId);
  staff.serverConfig = {
    ...(staff.serverConfig || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  saveStaffGuild(guildId, staff);
  return staff.serverConfig;
}
function pagBankAutomaticEnabled(guildId) {
  return serverConfig(guildId).pagBankAutomaticEnabled !== false;
}
function automaticPaymentProvider(guildId) {
  const saved = String(serverConfig(guildId).paymentProvider || process.env.PAYMENT_PROVIDER || "").trim().toLowerCase();
  if (["mercadopago", "mercado_pago", "mp"].includes(saved)) return "mercadopago";
  if (["manual", "pix_manual"].includes(saved)) return "manual";
  return pagBankAutomaticEnabled(guildId) ? "pagbank" : "manual";
}
function storePaymentMethod(guildId, amountCents) {
  if (amountCents < 100) return PAYMENT_METHOD.MANUAL_PIX;
  const provider = automaticPaymentProvider(guildId);
  if (provider === "mercadopago") return PAYMENT_METHOD.MERCADOPAGO_PIX;
  if (provider === "pagbank") return PAYMENT_METHOD.PAGBANK_PIX;
  return PAYMENT_METHOD.MANUAL_PIX;
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
function resellerRoleId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).resellerRoleId : "";
  return String(saved || process.env.RESELLER_ROLE_ID || legacyStoreValue(config.resellerRoleId, DEFAULT_RESELLER_ROLE_ID)).trim();
}
function resellerDiscountPercent(guildId = "") {
  const saved = guildId ? serverConfig(guildId).resellerDiscountPercent : undefined;
  const value = Number.parseFloat(String(saved ?? process.env.RESELLER_DISCOUNT_PERCENT ?? config.resellerDiscountPercent ?? 10).replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(90, value);
}
function memberHasRole(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}
function discountForMember(member) {
  const roleId = resellerRoleId(member?.guild?.id || "");
  const percent = resellerDiscountPercent(member?.guild?.id || "");
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
function legacyStoreValue(value, fallback = "") {
  return instanceConfig.STORE_INSTANCE_ID === "primary" ? (value || fallback) : "";
}
function adminRoleId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).adminRoleId : "";
  return String(saved || process.env.ADMIN_ROLE_ID || legacyStoreValue(config.adminRoleId)).trim();
}
function categoryId(guildId, key) {
  const saved = guildId ? serverConfig(guildId)[`${key}CategoryId`] : "";
  const envKey = `${String(key).replace(/([A-Z])/g, "_$1").toUpperCase()}_CATEGORY_ID`;
  return String(saved || process.env[envKey] || legacyStoreValue(config.categories?.[key])).trim();
}
function ticketPanelChannelId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).ticketPanelChannelId : "";
  return String(saved || process.env.TICKET_PANEL_CHANNEL_ID || legacyStoreValue(config.ticketPanel?.channelId)).trim();
}
function isAdmin(member) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.roles?.cache?.has(adminRoleId(member?.guild?.id || ""))
  );
}
function botOwnerIds() {
  return parseOwnerIds(process.env.BOT_OWNER_IDS);
}
function isBotOwner(userOrId) {
  const id = typeof userOrId === "string" ? userOrId : userOrId?.id;
  return isAuthorizedOwner(id, process.env.BOT_OWNER_IDS);
}
async function requireBotOwner(context, message = "Somente um proprietario autorizado pode usar esta funcao.") {
  const actor = actionUser(context);
  if (isBotOwner(actor)) return true;
  writeAuditLog(context, "security.owner_access_denied", { target: context.customId || context.commandName || "owner_action" });
  await actionReply(context, { content: message, ephemeral: true });
  return false;
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
  for (const key of ["panelChannelId", "panelMessageId", "successChannelId", "customerRoleId", "serverConfig"]) {
    if (key === "serverConfig") {
      if (current.serverConfig && Object.keys(current.serverConfig).length) merged.serverConfig = current.serverConfig;
      continue;
    }
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
          .setCustomId("pixMeta")
          .setLabel("Tipo da chave | Cidade")
          .setPlaceholder("Email | Sao Paulo")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(false)
          .setValue([current.pixKeyType, current.pixCity].filter(Boolean).join(" | ").slice(0, 120))
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
    .setTitle("💸 Pagamento Pix manual")
    .setDescription(
      `**Atendente:** ${profile.displayName || "ADM"} (<@${profile.userId}>)\n` +
      `**ID da compra:** \`${order.id}\`\n\n` +
      `**Valor exato:** ${order.totalCentsSnapshot ? money(order.totalCentsSnapshot / 100) : totalLine(order, panel)}\n\n` +
      `**Chave Pix:**\n\`${profile.pixKey}\`\n\n` +
      `${profile.pixKeyType ? `**Tipo:** ${profile.pixKeyType}\n` : ""}` +
      `${profile.pixCity ? `**Cidade:** ${profile.pixCity}\n\n` : ""}` +
      `**Resumo:**\n${cartText(order, panel)}\n\n` +
      `${profile.note || "Envie o comprovante aqui no carrinho."}\n\nO pagamento sera verificado manualmente.`
    )
    .setColor(parseColor(panel.color))
    .setTimestamp();

  if (profile.qrCodeUrl && validUrl(profile.qrCodeUrl)) embed.setImage(profile.qrCodeUrl);
  return embed;
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

    await refreshCartMessage(channel.guild, order, panel, channel);
    return true;
  }
  return false;
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

  const online = onlineStaffProfiles(interaction.guildId);
  if (online.length > 0 && profile && !profile.online) {
    return actionReply(interaction, { content: "Você está OFF. Clique em **Ficar ON** no painel de atendimento antes de assumir.", ephemeral: true });
  }

  order.assignedAdminId = interaction.user.id;
  order.assignedAdminName = profile?.displayName || interaction.member?.displayName || interaction.user.username;
  order.assignedAt = new Date().toISOString();
  touchOrder(order);
  appendAuditLog(db, interaction, "order.assigned", { order, staffUserId: interaction.user.id });
  db.orders[order.id] = order;
  writeOrders(db);

  const panel = getOrderPanel(order, actionGuildId(interaction));
  await persistOrderRelationalAsync(db, order, panel);
  await refreshCartMessage(interaction.guild, order, panel, interaction.channel);
  await interaction.channel.send({
    content: `<@${order.userId}> sua compra foi assumida por <@${interaction.user.id}>. Escolha a forma de pagamento no botao **Gerar pagamento**.`,
    allowedMentions: { users: [order.userId, interaction.user.id] }
  }).catch(() => null);
  return actionReply(interaction, { content: "Compra assumida. O cliente ja pode escolher a forma de pagamento.", ephemeral: true });
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

  const panel = getOrderPanel(order, actionGuildId(interaction));
  if ([PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX].includes(order.paymentMethod) && (order.pagBankPixCopyPaste || order.mercadoPagoPixCopyPaste)) {
    const paymentPayload = await buildPagBankPaymentPayload(order, panel);
    const provider = order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? "Mercado Pago" : "PagBank";
    appendAuditLog(db, interaction, "order.pix_resent", { order, paymentMethod: PAYMENT_METHOD.PAGBANK_PIX });
    writeOrders(db);
    await interaction.channel.send({ content: `<@${order.userId}> Pix ${provider} reenviado no carrinho.`, ...paymentPayload, allowedMentions: { users: [order.userId] } });
    await sendSafeDM(order.userId, paymentPayload);
    return actionReply(interaction, { content: `Pix ${provider} reenviado no carrinho.`, ephemeral: true });
  }

  await ensureStaffState(interaction.guild, interaction.channel);
  const profile = manualPaymentProfile(order);
  if (!profile?.pixKey) {
    return actionReply(interaction, { content: "Nao existe uma chave Pix manual configurada para este pedido.", ephemeral: true });
  }

  appendAuditLog(db, interaction, "order.pix_resent", { order, staffUserId: order.assignedAdminId });
  await sendOrRefreshManualPaymentMessage(interaction.channel, order, panel, profile);
  touchOrder(order);
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);
  const dmSent = await sendSafeDM(order.userId, { embeds: [manualPaymentEmbed(order, panel, profile)] });

  return actionReply(interaction, { content: dmSent ? "Pix atualizado no carrinho e reenviado por DM." : "Pix atualizado no carrinho.", ephemeral: true });
}
async function sendPixCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode enviar Pix do carrinho.");
  await message.delete().catch(() => null);

  const db = readOrders();
  const order = findOrderInChannel(db, message, false);
  if (!order) return message.channel.send("Nao encontrei carrinho neste chat.");
  if (order.status !== "open") return message.channel.send(`Esse carrinho esta ${order.status === "closed" ? "fechado" : "indisponivel"}.`);
  if ([PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX].includes(order.paymentMethod)) return startOrderPayment(message, order.id);

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
  order.paymentPreference = "manual";
  appendAuditLog(db, message, "order.pix_sent", { order, staffUserId: message.author.id, via: "pix_command" });
  writeOrders(db);

  const panel = getOrderPanel(order, message.guild.id);
  persistOrderRelationalAsync(db, order, panel);
  return startOrderPayment(message, order.id);
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
    if (!await requireBotOwner(interaction, "Somente BOT_OWNER_IDS pode configurar a chave Pix.")) return;
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
  if (!await requireBotOwner(interaction, "Somente BOT_OWNER_IDS pode configurar a chave Pix.")) return;
  await ensureStaffState(interaction.guild, interaction.channel);

  const displayName = interaction.fields.getTextInputValue("displayName").trim();
  const pixKey = interaction.fields.getTextInputValue("pixKey").trim();
  const [pixKeyType = "", pixCity = ""] = interaction.fields.getTextInputValue("pixMeta").split("|").map(value => value.trim());
  const qrCodeUrl = interaction.fields.getTextInputValue("qrCodeUrl").trim();
  const note = interaction.fields.getTextInputValue("note").trim();

  if (qrCodeUrl && !validUrl(qrCodeUrl)) {
    return interaction.reply({ content: "Link de QR Code inválido. Use http/https ou deixe vazio.", ephemeral: true });
  }

  const oldProfile = getStaffProfile(interaction.guildId, interaction.user.id) || {};
  saveStaffProfile(interaction.guildId, interaction.user.id, {
    displayName,
    pixKey,
    pixKeyType,
    pixCity,
    qrCodeUrl,
    note,
    online: false
  });
  const changedFields = changedFieldNames(oldProfile, { displayName, pixKey, pixKeyType, pixCity, qrCodeUrl, note }, ["displayName", "pixKey", "pixKeyType", "pixCity", "qrCodeUrl", "note"]);
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
    if (found.product.stockMode === STOCK_MODE.AUTOMATIC) continue;
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
    if (found.product.stockMode === STOCK_MODE.AUTOMATIC) continue;

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
    stock: p.stockMode === STOCK_MODE.AUTOMATIC ? "disponibilidade automatica" : String(p.stock || "infinito"),
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
    ticketChannelId: ticketPanelChannelId(guildId),
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(payload));
}
function publicApiAuthorized(req) {
  const expectedToken = process.env.PUBLIC_STORE_API_TOKEN?.trim();
  if (!expectedToken) return { ok: false, status: 503, error: "PUBLIC_STORE_API_TOKEN nao configurado no bot." };
  if (String(req.headers.authorization || "") !== `Bearer ${expectedToken}`) {
    return { ok: false, status: 401, error: "Nao autorizado." };
  }
  return { ok: true };
}
function readHttpJsonBody(req, maxBytes = 32 * 1024) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        reject(new Error("Payload muito grande."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });
}
function publicWebOrderCode(db) {
  let code = "";
  do {
    const time = Date.now().toString(36).slice(-5).toUpperCase();
    const random = crypto.randomBytes(2).toString("hex").toUpperCase();
    code = `SS-${time}-${random}`;
  } while (db.webOrders?.[code]);
  return code;
}
function publicWebOrderResponse(order) {
  return {
    id: order.id,
    status: order.status,
    items: order.items,
    totalCents: order.totalCents,
    total: money(Number(order.totalCents || 0) / 100),
    createdAt: order.createdAt,
    expiresAt: order.expiresAt
  };
}
async function createPublicWebOrder(input) {
  const requestedItems = Array.isArray(input?.items) ? input.items.slice(0, 25) : [];
  if (!requestedItems.length) throw new Error("Adicione pelo menos um produto ao pedido.");

  const catalog = await publicStorePayload();
  const products = new Map((catalog.categories || [])
    .flatMap(category => (category.products || []).map(productItem => [String(productItem.id), { ...productItem, categoryId: category.id, categoryTitle: category.title }])));
  for (const productItem of catalog.products || []) {
    if (!products.has(String(productItem.id))) products.set(String(productItem.id), productItem);
  }

  const quantities = new Map();
  for (const item of requestedItems) {
    const productId = String(item?.productId || "").slice(0, 160);
    const quantity = Math.min(100, Math.max(1, Number.parseInt(String(item?.quantity || 1), 10) || 1));
    if (!products.has(productId)) throw new Error("Um dos produtos nao existe mais no catalogo. Atualize a pagina.");
    quantities.set(productId, Math.min(100, (quantities.get(productId) || 0) + quantity));
  }
  const totalUnits = [...quantities.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (totalUnits > 100) throw new Error("O pedido pode ter no maximo 100 unidades.");

  const items = [...quantities.entries()].map(([productId, quantity]) => {
    const productItem = products.get(productId);
    const hasStoredPrice = productItem.priceCents !== null && productItem.priceCents !== undefined && productItem.priceCents !== "";
    const priceCents = hasStoredPrice && Number.isFinite(Number(productItem.priceCents))
      ? Math.max(0, Math.round(Number(productItem.priceCents)))
      : priceCentsFromValue(productItem.price);
    if (!Number.isFinite(priceCents)) throw new Error(`${productItem.name} esta sem preco numerico.`);
    return {
      productId,
      name: clampText(productItem.name, 100, "Produto"),
      price: clampText(productItem.price, 40, money(priceCents / 100)),
      priceCents,
      quantity,
      subtotalCents: priceCents * quantity,
      categoryId: clampText(productItem.categoryId, 100),
      categoryTitle: clampText(productItem.categoryTitle, 100)
    };
  });

  const db = readOrders();
  const now = Date.now();
  for (const [id, order] of Object.entries(db.webOrders || {})) {
    if (Date.parse(order.createdAt || "") < now - 7 * 24 * 60 * 60 * 1000) delete db.webOrders[id];
  }
  const requestKey = String(input?.requestKey || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const existing = requestKey
    ? Object.values(db.webOrders).find(order => order.requestKey === requestKey && order.guildId === (process.env.PUBLIC_STORE_GUILD_ID?.trim() || process.env.GUILD_ID?.trim()))
    : null;
  if (existing) return publicWebOrderResponse(existing);

  const id = publicWebOrderCode(db);
  const createdAt = new Date(now).toISOString();
  const order = {
    id,
    requestKey,
    guildId: process.env.PUBLIC_STORE_GUILD_ID?.trim() || process.env.GUILD_ID?.trim() || "default",
    status: "pending_discord",
    source: "website",
    items,
    totalUnits,
    totalCents: items.reduce((sum, item) => sum + item.subtotalCents, 0),
    createdAt,
    expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString()
  };
  db.webOrders[id] = order;
  writeOrders(db);
  await flushPersistentFile(ORDERS_FILE);
  return publicWebOrderResponse(order);
}
function readSiteAnalyticsStore() {
  const data = readJson(SITE_ANALYTICS_FILE, { events: [] });
  return { events: Array.isArray(data?.events) ? data.events.slice(-5000) : [] };
}
async function recordPublicAnalyticsEvent(input) {
  const allowedTypes = new Set(["page_view", "category_click", "product_click", "order_created"]);
  const type = String(input?.type || "");
  if (!allowedTypes.has(type)) throw new Error("Tipo de evento invalido.");
  const event = {
    id: crypto.randomUUID(),
    type,
    visitorId: clampText(input?.visitorId, 120, "anonimo"),
    path: clampText(input?.path, 300),
    productId: clampText(input?.productId, 120),
    productName: clampText(input?.productName, 160),
    categoryId: clampText(input?.categoryId, 120),
    categoryTitle: clampText(input?.categoryTitle, 160),
    orderId: clampText(input?.orderId, 40),
    createdAt: new Date().toISOString()
  };
  const store = readSiteAnalyticsStore();
  store.events.push(event);
  store.events = store.events.slice(-5000);
  writeJson(SITE_ANALYTICS_FILE, store);
  return event;
}
async function handleHttpRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.PUBLIC_STORE_CORS_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/public-store") {
    try {
      return sendHttpJson(res, 200, await publicStorePayload());
    } catch (error) {
      console.error("Erro na API publica da loja:", errorSummary(error));
      return sendHttpJson(res, 500, { error: "Nao foi possivel carregar a loja." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/public-orders") {
    const auth = publicApiAuthorized(req);
    if (!auth.ok) return sendHttpJson(res, auth.status, { error: auth.error });
    try {
      const input = await readHttpJsonBody(req);
      return sendHttpJson(res, 201, await createPublicWebOrder(input));
    } catch (error) {
      const message = clampText(error?.message, 300, "Nao foi possivel criar o pedido.");
      return sendHttpJson(res, /nao existe|sem preco|pelo menos|maximo|invalido|grande/i.test(message) ? 400 : 500, { error: message });
    }
  }

  if (url.pathname === "/api/public-analytics" && ["GET", "POST"].includes(req.method)) {
    const auth = publicApiAuthorized(req);
    if (!auth.ok) return sendHttpJson(res, auth.status, { error: auth.error });
    try {
      if (req.method === "GET") return sendHttpJson(res, 200, readSiteAnalyticsStore());
      const input = await readHttpJsonBody(req, 16 * 1024);
      const event = await recordPublicAnalyticsEvent(input);
      return sendHttpJson(res, 201, { ok: true, id: event.id });
    } catch (error) {
      return sendHttpJson(res, 400, { error: clampText(error?.message, 200, "Evento invalido.") });
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Bot online");
}
function verificationPanelPayload() {
  const startUrl = oauthConfig.oauthStartUrl();
  const ready = Boolean(startUrl && oauthConfig.CLIENT_ID && oauthConfig.CLIENT_SECRET && oauthConfig.REDIRECT_URI);
  const embed = new EmbedBuilder()
    .setTitle("Verificacao Dragon Store")
    .setDescription([
      "Clique no botao abaixo para liberar seu acesso com seguranca.",
      "",
      "**Ao verificar, voce libera acesso ao servidor e autoriza ser adicionado ao servidor reserva oficial caso este servidor caia ou mude.**",
      "",
      "A verificacao usa OAuth2 oficial do Discord e solicita apenas `identify` e `guilds.join`."
    ].join("\n"))
    .setColor(parseColor("#28f6a1"))
    .addFields(
      { name: "Acesso", value: "Cargo cliente aplicado automaticamente.", inline: true },
      { name: "Reserva oficial", value: "Entrada autorizada em caso de troca/queda.", inline: true },
      { name: "Privacidade", value: "Tokens ficam salvos apenas no backend do bot.", inline: false }
    )
    .setFooter({ text: ready ? "Verificacao rapida pelo Discord" : "OAuth2 ainda nao configurado no .env" })
    .setTimestamp();

  const button = new ButtonBuilder()
    .setLabel(ready ? "Verificar" : "OAuth indisponivel")
    .setStyle(ready ? ButtonStyle.Link : ButtonStyle.Secondary)
    .setEmoji("✅")
    .setDisabled(!ready);
  if (ready) button.setURL(startUrl);
  else button.setCustomId("oauth:not-ready");

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}
async function sendVerificationPanel(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode enviar o painel de verificacao.");
  await message.delete().catch(() => null);
  return message.channel.send(verificationPanelPayload());
}
async function sendVerifiedCount(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode ver a contagem de verificados.");
  await message.delete().catch(() => null);
  const count = countVerifiedUsers();
  const embed = new EmbedBuilder()
    .setTitle("Usuarios verificados")
    .setDescription(`Total de pessoas verificadas: **${count}**`)
    .setColor(parseColor("#33d6ff"))
    .setTimestamp();
  return message.channel.send({ embeds: [embed] });
}
async function pullBackupCommand(message) {
  if (!isAdmin(message.member)) return message.reply("So ADM pode puxar usuarios para o servidor reserva.");
  await message.delete().catch(() => null);
  const loading = await message.channel.send("Puxando usuarios verificados para o servidor reserva...");
  try {
    const summary = await pullVerifiedUsersToBackup();
    const embed = new EmbedBuilder()
      .setTitle("Backup de verificados")
      .setDescription(`Processo concluido para **${summary.total}** usuario(s) verificado(s).`)
      .setColor(parseColor(summary.failed ? "#ffb020" : "#28f6a1"))
      .addFields(
        { name: "Adicionados com sucesso", value: String(summary.added), inline: true },
        { name: "Ja estavam no servidor", value: String(summary.already), inline: true },
        { name: "Falharam", value: String(summary.failed), inline: true }
      )
      .setFooter({ text: "Tokens expirados sao renovados automaticamente antes da tentativa." })
      .setTimestamp();
    if (summary.failures?.length) {
      embed.addFields({
        name: "Primeiras falhas",
        value: summary.failures.slice(0, 5).map(item => `\`${item.discord_id}\`: ${item.reason}`).join("\n").slice(0, 1024),
        inline: false
      });
    }
    return loading.edit({ content: "", embeds: [embed] });
  } catch (error) {
    return loading.edit(`Nao consegui puxar backup: ${error.message}`);
  }
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
    stockMode: p.stockMode === STOCK_MODE.AUTOMATIC ? STOCK_MODE.AUTOMATIC : STOCK_MODE.MANUAL,
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
    stockMode: item.stockMode || current?.stockMode || STOCK_MODE.MANUAL,
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
function serverOrderSnapshot(order) {
  const calculated = calculateServerCart(order?.items, cartItem => {
    const sourcePanelId = cartItem.sourcePanelId || order.panelId;
    const sourcePanel = getPanelById(order.guildId, sourcePanelId);
    const sourceProductId = cartItem.sourceProductId || cartItem.productId;
    const sourceProduct = sourcePanel && product(sourcePanel, sourceProductId);
    if (!sourceProduct) return null;
    const priceCents = Number.isFinite(Number(sourceProduct.priceCents))
      ? Math.round(Number(sourceProduct.priceCents))
      : priceCentsFromValue(sourceProduct.price);
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error(`${sourceProduct.name} esta sem preco valido.`);
    return {
      productId: sourceProduct.id,
      sourcePanelId: sourcePanel.id,
      sourceProductId: sourceProduct.id,
      name: sourceProduct.name,
      price: sourceProduct.price,
      priceCents,
      stockMode: sourceProduct.stockMode === STOCK_MODE.AUTOMATIC ? STOCK_MODE.AUTOMATIC : STOCK_MODE.MANUAL
    };
  }, orderDiscountPercent(order));
  const automatic = calculated.items.filter(item => item.stockMode === STOCK_MODE.AUTOMATIC).map(item => ({
    productId: dbProductId(item.sourcePanelId, item.sourceProductId),
    panel: getPanelById(order.guildId, item.sourcePanelId),
    quantity: item.quantity,
    name: item.name
  }));
  const hash = crypto.createHash("sha256").update(JSON.stringify({
    items: calculated.items,
    grossCents: calculated.grossCents,
    discountCents: calculated.discountCents,
    totalCents: calculated.totalCents
  })).digest("hex");
  return { ...calculated, automatic, automaticUnits: automatic.reduce((sum, item) => sum + item.quantity, 0), hash };
}
function paymentStarted(order) {
  return Boolean(order?.paymentMethod || order?.paymentState || order?.totalCentsSnapshot);
}
function paymentReference(order) {
  return `${instanceConfig.STORE_INSTANCE_ID}-${String(order.guildId).slice(-12)}-${order.id}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 64);
}
async function reserveAutomaticStockForOrder(order, panel, snapshot) {
  if (!snapshot.automatic.length || order.stockReservedAt) return [];
  if (!postgresEnabled()) throw new Error("Estoque automatico exige DATABASE_URL configurada.");
  validateStockEncryptionKey(process.env.STOCK_ENCRYPTION_KEY);
  return withPostgresTransaction(async dbClient => {
    const uniquePanels = new Map([[panel.id, panel], ...snapshot.automatic.map(item => [item.panel.id, item.panel])]);
    for (const sourcePanel of uniquePanels.values()) await upsertPanelRelational(dbClient, order.guildId, sourcePanel);
    await insertOrderRelationalIfMissing(dbClient, order, panel);
    await syncOrderItemsRelational(dbClient, order, panel);
    const ids = [];
    for (const item of snapshot.automatic) {
      ids.push(...await reserveStock(dbClient, {
        productId: item.productId,
        guildId: order.guildId,
        orderId: order.id,
        quantity: item.quantity
      }));
    }
    return ids;
  });
}
async function persistPaymentOrder(db, order, panel) {
  db.orders[order.id] = order;
  writeOrders(db);
  await flushPersistentFile(ORDERS_FILE);
  await persistOrderRelationalAsync(db, order, panel);
}
function manualPaymentProfile(order) {
  if (order.assignedAdminId) {
    const assigned = getStaffProfile(order.guildId, order.assignedAdminId);
    if (assigned?.pixKey) return assigned;
  }
  const online = onlineStaffProfiles(order.guildId);
  if (online.length === 1) return online[0];
  const pixKey = String(process.env.MANUAL_PIX_KEY || "").trim();
  if (!pixKey) return null;
  return {
    userId: client.user?.id || "loja",
    displayName: String(process.env.MANUAL_PIX_RECEIVER || "Loja").trim(),
    pixKey,
    pixKeyType: String(process.env.MANUAL_PIX_KEY_TYPE || "").trim(),
    pixCity: "",
    qrCodeUrl: String(process.env.MANUAL_PIX_QR_IMAGE_URL || "").trim(),
    note: "Envie uma imagem ou um arquivo PDF do comprovante neste carrinho."
  };
}
function buildManualPaymentEmbed(order, snapshot, profile, panel) {
  const embed = new EmbedBuilder()
    .setTitle("Pagamento manual")
    .setDescription([
      `**Valor:** ${money(snapshot.totalCents / 100)}`,
      `**Pedido:** \`${order.id}\``,
      `**Produtos:** ${snapshot.items.map(item => `${item.name} x${item.quantity}`).join(", ").slice(0, 900)}`,
      `**Recebedor:** ${profile.displayName || "Loja"}`,
      profile.pixKeyType ? `**Tipo da chave:** ${profile.pixKeyType}` : "",
      profile.pixCity ? `**Cidade:** ${profile.pixCity}` : "",
      `**Chave Pix:**\n\`${profile.pixKey}\``,
      "Envie o valor exato para a chave acima e depois mande o comprovante neste ticket.",
      "O pagamento sera verificado manualmente por um proprietario autorizado."
    ].filter(Boolean).join("\n\n"))
    .setColor(parseColor(panel.color))
    .setTimestamp();
  if (profile.qrCodeUrl && validUrl(profile.qrCodeUrl)) embed.setImage(profile.qrCodeUrl);
  return embed;
}
function manualPaymentConfirmationAllowed(order) {
  return manualPaymentConfirmationMode(order) !== "disabled";
}
function manualPaymentActionRows(order) {
  const mode = manualPaymentConfirmationMode(order);
  const label = mode === "replacement"
    ? "Enviei novo comprovante"
    : order.manualPaymentNotificationSentAt
      ? "Comprovante enviado"
      : "Ja fiz o pagamento";
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`manualconfirm:${order.id}`)
        .setLabel(label)
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!manualPaymentConfirmationAllowed(order))
    )
  ];
}
function manualPaymentEmbed(order, panel, profile) {
  return order.paymentSnapshot?.items?.length
    ? buildManualPaymentEmbed(order, order.paymentSnapshot, profile, panel)
    : buildPixEmbed(order, panel, profile);
}
async function sendOrRefreshManualPaymentMessage(channel, order, panel, profile) {
  const payload = {
    content: `<@${order.userId}> pagamento manual do pedido #${order.id}:`,
    embeds: [manualPaymentEmbed(order, panel, profile)],
    components: manualPaymentActionRows(order),
    allowedMentions: { users: [order.userId] }
  };
  const existing = order.manualPaymentMessageId
    ? await channel.messages.fetch(order.manualPaymentMessageId).catch(() => null)
    : null;
  const message = existing ? await existing.edit(payload) : await channel.send(payload);
  order.manualPaymentMessageId = message.id;
  return message;
}
async function refreshManualPaymentMessage(order, channel) {
  if (!order || !channel?.messages?.fetch) return false;
  let message = order.manualPaymentMessageId
    ? await channel.messages.fetch(order.manualPaymentMessageId).catch(() => null)
    : null;
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    message = recent ? [...recent.values()].find(candidate =>
      candidate.author?.id === client.user?.id &&
      candidate.embeds?.some(embed =>
        ["Pagamento manual", "💸 Pagamento Pix manual"].includes(String(embed.title || "")) &&
        String(embed.description || "").includes(String(order.id))
      )
    ) : null;
  }
  if (!message) return false;
  order.manualPaymentMessageId = message.id;
  await message.edit({ components: manualPaymentActionRows(order) }).catch(() => null);
  return true;
}
function buildPagBankPaymentEmbed(order, panel) {
  const mercadoPago = order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX;
  const expires = Math.floor(Date.parse(order.paymentExpiresAt) / 1000);
  const embed = new EmbedBuilder()
    .setTitle(mercadoPago ? "Pix automatico Mercado Pago" : "Pix automatico PagBank")
    .setDescription([
      `**Valor:** ${money(order.totalCentsSnapshot / 100)}`,
      `**Pedido:** \`${order.id}\``,
      `**ID ${mercadoPago ? "Mercado Pago" : "PagBank"}:** \`${mercadoPago ? order.mercadoPagoPaymentId : order.pagBankOrderId}\``,
      Number.isFinite(expires) ? `**Expira:** <t:${expires}:R>` : "",
      "**Pix copia e cola:**",
      `\`${String(mercadoPago ? order.mercadoPagoPixCopyPaste : order.pagBankPixCopyPaste || "").slice(0, 900)}\``,
      `A entrega so e liberada depois da confirmacao oficial do ${mercadoPago ? "Mercado Pago" : "PagBank"}.`
    ].filter(Boolean).join("\n\n"))
    .setColor(parseColor(panel.color))
    .setTimestamp();
  if (validUrl(order.pagBankQrCodeImageUrl)) embed.setImage(order.pagBankQrCodeImageUrl);
  return embed;
}
async function buildPagBankPaymentPayload(order, panel) {
  const embed = buildPagBankPaymentEmbed(order, panel);
  try {
    const attachment = await QRCode.toBuffer(String(order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? order.mercadoPagoPixCopyPaste : order.pagBankPixCopyPaste || ""), {
      type: "png",
      width: 512,
      margin: 2,
      errorCorrectionLevel: "M"
    });
    embed.setImage("attachment://pagbank-pix.png");
    return { embeds: [embed], files: [{ attachment, name: "pagbank-pix.png" }] };
  } catch {
    return { embeds: [embed] };
  }
}
function pagBankCustomerModal(orderId) {
  return new ModalBuilder()
    .setCustomId(`paycustomer:${orderId}`)
    .setTitle("Dados para o Pix automatico")
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Nome completo").setPlaceholder("Ex: Maria da Silva").setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("email").setLabel("E-mail").setPlaceholder("seuemail@exemplo.com").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("taxId").setLabel("CPF/CNPJ privado exigido pelo provedor").setPlaceholder("Nao sera exibido no canal").setStyle(TextInputStyle.Short).setMinLength(11).setMaxLength(18).setRequired(true))
    );
}
function automaticPaymentMethodForGuild(guildId) {
  const provider = automaticPaymentProvider(guildId);
  if (provider === "mercadopago") return PAYMENT_METHOD.MERCADOPAGO_PIX;
  if (provider === "pagbank") return PAYMENT_METHOD.PAGBANK_PIX;
  return null;
}
function automaticPaymentConfigured(guildId) {
  const method = automaticPaymentMethodForGuild(guildId);
  if (method === PAYMENT_METHOD.MERCADOPAGO_PIX) return postgresEnabled() && mercadoPagoReady();
  if (method === PAYMENT_METHOD.PAGBANK_PIX) return postgresEnabled() && pagBankReady();
  return false;
}
function selectedPaymentMethod(order, totalCents) {
  if (order.paymentPreference === "manual") return PAYMENT_METHOD.MANUAL_PIX;
  if (order.paymentPreference === "automatic") {
    if (totalCents < 100) return null;
    return automaticPaymentMethodForGuild(order.guildId);
  }
  return storePaymentMethod(order.guildId, totalCents);
}
function paymentMethodChoicePayload(order, panel) {
  const snapshot = serverOrderSnapshot(order);
  const availability = paymentChoiceAvailability(snapshot.totalCents, automaticPaymentConfigured(order.guildId));
  const automaticMethod = automaticPaymentMethodForGuild(order.guildId);
  const providerName = automaticMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? "Mercado Pago" : automaticMethod === PAYMENT_METHOD.PAGBANK_PIX ? "PagBank" : "indisponivel";
  const embed = new EmbedBuilder()
    .setTitle("Escolha como pagar")
    .setDescription([
      `**Total do pedido:** ${money(snapshot.totalCents / 100)}`,
      "",
      "**PIX Automatico**",
      `Identificado e aprovado automaticamente pelo ${providerName}. Solicita dados privados, incluindo CPF/CNPJ.`,
      "",
      "**PIX Manual**",
      "Use a chave ou QR Code da loja e envie uma imagem ou PDF do comprovante.",
      availability.reason ? `\n${availability.reason}` : ""
    ].filter(Boolean).join("\n"))
    .setColor(parseColor(panel.color));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`payauto:${order.id}`)
      .setLabel("PIX Automatico - precisa CPF")
      .setEmoji("⚡")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!availability.automatic),
    new ButtonBuilder()
      .setCustomId(`paymanual:${order.id}`)
      .setLabel("PIX Manual")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!availability.manual)
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}
async function showPaymentMethodChoice(context, id) {
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.status !== ORDER_STATUS.OPEN) return actionReply(context, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  const actor = actionUser(context);
  if (actor.id !== order.userId && !isAdmin(context.member)) return actionReply(context, { content: "Voce nao pode escolher o pagamento deste carrinho.", ephemeral: true });
  if (paymentStarted(order)) return startOrderPayment(context, order.id);
  if (!order.items?.length) return actionReply(context, { content: "Adicione um produto antes de escolher o pagamento.", ephemeral: true });
  try {
    return actionReply(context, paymentMethodChoicePayload(order, getOrderPanel(order, order.guildId)));
  } catch (error) {
    return actionReply(context, { content: error.message, ephemeral: true });
  }
}
async function selectPaymentMethod(context, id, preference) {
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.status !== ORDER_STATUS.OPEN) return actionReply(context, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  const actor = actionUser(context);
  if (actor.id !== order.userId && !isAdmin(context.member)) return actionReply(context, { content: "Somente o cliente pode escolher a forma de pagamento.", ephemeral: true });
  if (paymentStarted(order)) return actionReply(context, { content: `O pagamento ja esta em ${paymentStatusLabel(order)}.`, ephemeral: true });
  const panel = getOrderPanel(order, order.guildId);
  const snapshot = serverOrderSnapshot(order);
  const availability = paymentChoiceAvailability(snapshot.totalCents, automaticPaymentConfigured(order.guildId));
  if (preference === "automatic" && !availability.automatic) return actionReply(context, { content: availability.reason, ephemeral: true });
  if (preference !== "automatic" && preference !== "manual") return actionReply(context, { content: "Forma de pagamento invalida.", ephemeral: true });
  order.paymentPreference = preference;
  touchOrder(order);
  db.orders[order.id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel).catch(error => {
    console.warn(`Nao consegui espelhar a escolha de pagamento do pedido #${order.id}: ${errorSummary(error).message}`);
  });
  return startOrderPayment(context, order.id);
}
let lastPagBankDiagnostic = null;
function safePagBankFailure(error, order) {
  let config;
  try {
    config = pagBankConfig();
  } catch {
    config = { environment: String(process.env.PAGBANK_ENV || "sandbox").trim(), baseUrl: "https://invalid.local", token: "" };
  }
  const details = error?.pagBank || { status: 0, errors: [{ code: "", description: error?.message || "Falha desconhecida", parameterName: "" }] };
  lastPagBankDiagnostic = {
    at: new Date().toISOString(),
    environment: config.environment,
    host: new URL(config.baseUrl).host,
    tokenPresent: Boolean(config.token),
    tokenLength: config.token.length,
    endpoint: `${config.baseUrl}/orders`,
    status: details.status || 0,
    errors: details.errors || [],
    orderId: String(order?.id || "")
  };
  const lines = lastPagBankDiagnostic.errors.map(item => `codigo=${item.code || "n/a"} parametro=${item.parameterName || "n/a"} descricao=${item.description || "n/a"}`).join(" | ");
  console.warn(`PagBank request recusada: HTTP=${lastPagBankDiagnostic.status || "n/a"} ambiente=${config.environment} pedido=${lastPagBankDiagnostic.orderId} ${lines}`);
}
async function handleAutomaticPaymentCreationFailure(context, db, order, panel, method, error) {
  if (method === PAYMENT_METHOD.PAGBANK_PIX) safePagBankFailure(error, order);
  else console.warn(`Mercado Pago: falha ao criar cobranca do pedido #${order.id}: ${errorSummary(error).message}`);

  const httpStatus = paymentProviderHttpStatus(error);
  const auditEvent = method === PAYMENT_METHOD.MERCADOPAGO_PIX
    ? "order.mercadopago_create_failed"
    : "order.pagbank_create_failed";

  if (isAmbiguousPaymentProviderFailure(error)) {
    order.paymentCreationUncertainAt = new Date().toISOString();
    touchOrder(order);
    appendAuditLog(db, context, auditEvent, { order, httpStatus });
    await persistPaymentOrder(db, order, panel);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    return actionReply(context, {
      content: "Nao consegui confirmar a resposta do provedor. Use **Tentar pagamento** para reutilizar a mesma cobranca com seguranca ou cancele o carrinho. Nao faca outro Pix enquanto a cobranca nao aparecer.",
      ephemeral: true
    });
  }

  if (order.stockReservedAt) await releaseOrderStock(getPostgresPool(), order.id).catch(() => null);
  delete order.paymentMethod;
  delete order.paymentState;
  delete order.totalCentsSnapshot;
  delete order.paymentSnapshot;
  delete order.paymentExpiresAt;
  delete order.paymentCreationUncertainAt;
  delete order.stockReservedAt;
  delete order.pagBankReferenceId;
  delete order.pagBankIdempotencyKey;
  delete order.mercadoPagoReferenceId;
  delete order.mercadoPagoIdempotencyKey;
  delete order.paymentPreference;
  touchOrder(order);
  appendAuditLog(db, context, auditEvent, { order, httpStatus });
  await persistPaymentOrder(db, order, panel);
  await refreshCartMessage(context.guild, order, panel, context.channel);
  return actionReply(context, {
    content: "O provedor recusou a criacao do Pix. Confira os dados e tente novamente; voce tambem pode escolher Pix manual ou cancelar o carrinho.",
    ephemeral: true
  });
}
async function startOrderPayment(context, id, customerInput = null) {
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.status !== ORDER_STATUS.OPEN) return actionReply(context, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  const actor = actionUser(context);
  if (actor.id !== order.userId && !isAdmin(context.member)) return actionReply(context, { content: "Voce nao pode gerar pagamento para este carrinho.", ephemeral: true });
  const panel = getOrderPanel(order, order.guildId);
  let customer = null;
  const automaticMethods = [PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX];
  const hasAutomaticPix = order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? order.mercadoPagoPixCopyPaste : order.pagBankPixCopyPaste;
  const intendedMethod = order.paymentMethod || selectedPaymentMethod(order, serverOrderSnapshot(order).totalCents);
  const needsPagBankCustomer = (automaticMethods.includes(order.paymentMethod) && !hasAutomaticPix) ||
    (!paymentStarted(order) && automaticMethods.includes(intendedMethod));
  if (needsPagBankCustomer) {
    if (actor.id !== order.userId) return actionReply(context, { content: "O cliente precisa clicar em Gerar pagamento e informar os dados exigidos pelo provedor Pix.", ephemeral: true });
    if (!customerInput) {
      if (typeof context.showModal === "function") return context.showModal(pagBankCustomerModal(order.id));
      return actionReply(context, { content: "Clique no botao Gerar pagamento do carrinho para preencher seus dados em privado.", ephemeral: true });
    }
    try {
      customer = normalizeCustomer(customerInput);
    } catch (error) {
      return actionReply(context, { content: error.message, ephemeral: true });
    }
  }
  if (context.isRepliable?.() && !context.deferred && !context.replied) await context.deferReply({ ephemeral: true });
  if (automaticMethods.includes(order.paymentMethod) && hasAutomaticPix) {
    const paymentPayload = await buildPagBankPaymentPayload(order, panel);
    await context.channel.send({ content: `<@${order.userId}> cobrança Pix do pedido #${order.id}:`, ...paymentPayload, allowedMentions: { users: [order.userId] } });
    const provider = order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX ? "Mercado Pago" : "PagBank";
    return actionReply(context, { content: `Cobranca ${provider} reenviada no carrinho.`, ephemeral: true });
  }
  if (order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX && order.paymentState === PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT && order.mercadoPagoReferenceId && order.mercadoPagoIdempotencyKey) {
    if (!claimOrderActionLock(order)) return actionReply(context, { content: "A cobranca ja esta sendo recuperada.", ephemeral: true });
    try {
      const payment = await createMercadoPagoPix({ referenceId: order.mercadoPagoReferenceId, idempotencyKey: order.mercadoPagoIdempotencyKey, amountCents: order.totalCentsSnapshot, expiresAt: order.paymentExpiresAt, description: `Pedido ${order.id}`, customer });
      order.mercadoPagoPaymentId = payment.paymentId;
      order.mercadoPagoPixCopyPaste = payment.copyPaste;
      order.paymentExpiresAt = payment.expiresAt;
      delete order.paymentCreationUncertainAt;
      touchOrder(order);
      await persistPaymentOrder(db, order, panel);
      const paymentPayload = await buildPagBankPaymentPayload(order, panel);
      await context.channel.send({ content: `<@${order.userId}> pagamento do pedido #${order.id}:`, ...paymentPayload, allowedMentions: { users: [order.userId] } });
      return actionReply(context, { content: "Cobranca Mercado Pago recuperada.", ephemeral: true });
    } catch (error) {
      return handleAutomaticPaymentCreationFailure(context, db, order, panel, PAYMENT_METHOD.MERCADOPAGO_PIX, error);
    } finally { releaseOrderActionLock(order); }
  }
  if (order.paymentMethod === PAYMENT_METHOD.PAGBANK_PIX && order.paymentState === PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT && order.pagBankReferenceId && order.pagBankIdempotencyKey) {
    if (!claimOrderActionLock(order)) return actionReply(context, { content: "A cobranca ja esta sendo recuperada.", ephemeral: true });
    try {
      const charge = await createPixOrder({
        referenceId: order.pagBankReferenceId,
        idempotencyKey: order.pagBankIdempotencyKey,
        amountCents: order.totalCentsSnapshot,
        expiresAt: order.paymentExpiresAt,
        items: order.paymentSnapshot?.items || [],
        customer
      });
      order.pagBankOrderId = charge.pagBankOrderId;
      order.pagBankPixCopyPaste = charge.copyPaste;
      order.pagBankQrCodeImageUrl = charge.qrCodeImageUrl;
      order.paymentExpiresAt = charge.expiresAt || order.paymentExpiresAt;
      delete order.paymentCreationUncertainAt;
      touchOrder(order);
      appendAuditLog(db, context, "order.pagbank_qr_recovered", { order, pagBankOrderId: order.pagBankOrderId });
      await persistPaymentOrder(db, order, panel);
      const paymentPayload = await buildPagBankPaymentPayload(order, panel);
      await context.channel.send({ content: `<@${order.userId}> pagamento do pedido #${order.id}:`, ...paymentPayload, allowedMentions: { users: [order.userId] } });
      return actionReply(context, { content: "Cobranca PagBank recuperada com a mesma chave de idempotencia.", ephemeral: true });
    } catch (error) {
      return handleAutomaticPaymentCreationFailure(context, db, order, panel, PAYMENT_METHOD.PAGBANK_PIX, error);
    } finally {
      releaseOrderActionLock(order);
    }
  }
  if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX && [PAYMENT_STATE.AWAITING_MANUAL_PAYMENT, PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW].includes(order.paymentState)) {
    const profile = manualPaymentProfile(order);
    if (!profile?.pixKey) return actionReply(context, { content: "O recebedor Pix deste pedido nao esta mais configurado.", ephemeral: true });
    await sendOrRefreshManualPaymentMessage(context.channel, order, panel, profile);
    touchOrder(order);
    await persistPaymentOrder(db, order, panel);
    return actionReply(context, { content: "Pix manual reenviado no carrinho.", ephemeral: true });
  }
  if (paymentStarted(order)) return actionReply(context, { content: `O pagamento deste pedido ja esta em ${paymentStatusLabel(order)}.`, ephemeral: true });
  if (!claimOrderActionLock(order)) return actionReply(context, { content: "O pagamento deste pedido ja esta sendo gerado.", ephemeral: true });
  try {
    const snapshot = serverOrderSnapshot(order);
    const method = selectedPaymentMethod(order, snapshot.totalCents);
    if (!method) {
      delete order.paymentPreference;
      touchOrder(order);
      await persistPaymentOrder(db, order, panel);
      return actionReply(context, { content: "O Pix automatico esta disponivel somente a partir de R$ 1,00. Escolha Pix manual.", ephemeral: true });
    }
    if (method === PAYMENT_METHOD.PAGBANK_PIX && (!postgresEnabled() || !pagBankReady())) {
      return actionReply(context, { content: "Pix PagBank ainda nao esta configurado com Postgres, PAGBANK_TOKEN e PAGBANK_WEBHOOK_URL.", ephemeral: true });
    }
    if (method === PAYMENT_METHOD.MERCADOPAGO_PIX && (!postgresEnabled() || !mercadoPagoReady())) {
      return actionReply(context, { content: "Pix Mercado Pago incompleto: configure Postgres, MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_URL.", ephemeral: true });
    }
    const profile = method === PAYMENT_METHOD.MANUAL_PIX ? manualPaymentProfile(order) : null;
    if (method === PAYMENT_METHOD.MANUAL_PIX && !profile?.pixKey) {
      return actionReply(context, { content: "Nenhum recebedor Pix esta definido. Um ADM deve usar `!pix` neste carrinho ou configurar MANUAL_PIX_KEY.", ephemeral: true });
    }

    order.paymentMethod = method;
    order.totalCentsSnapshot = snapshot.totalCents;
    order.paymentSnapshot = { items: snapshot.items, grossCents: snapshot.grossCents, discountCents: snapshot.discountCents, totalCents: snapshot.totalCents, automaticUnits: snapshot.automaticUnits, hash: snapshot.hash };
    if (automaticMethods.includes(method)) order.paymentExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    else delete order.paymentExpiresAt;
    order.paymentState = automaticMethods.includes(method) ? PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT : PAYMENT_STATE.AWAITING_MANUAL_PAYMENT;
    const reservedIds = await reserveAutomaticStockForOrder(order, panel, snapshot);
    if (reservedIds.length) order.stockReservedAt = new Date().toISOString();
    touchOrder(order);
    appendAuditLog(db, context, "order.payment_started", { order, paymentMethod: method, amountCents: snapshot.totalCents, automaticUnits: snapshot.automaticUnits });
    await persistPaymentOrder(db, order, panel);

    if (method === PAYMENT_METHOD.MANUAL_PIX) {
      await sendOrRefreshManualPaymentMessage(context.channel, order, panel, profile);
      touchOrder(order);
      await persistPaymentOrder(db, order, panel);
      await sendSafeDM(order.userId, { embeds: [manualPaymentEmbed(order, panel, profile)] });
      await refreshCartMessage(context.guild, order, panel, context.channel);
      return actionReply(context, { content: "Pix manual enviado no carrinho.", ephemeral: true });
    }

    if (method === PAYMENT_METHOD.MERCADOPAGO_PIX) {
      order.mercadoPagoReferenceId = paymentReference(order);
      order.mercadoPagoIdempotencyKey = crypto.randomUUID();
    } else {
      order.pagBankReferenceId = paymentReference(order);
      order.pagBankIdempotencyKey = crypto.randomUUID();
    }
    await persistPaymentOrder(db, order, panel);
    try {
      const charge = method === PAYMENT_METHOD.MERCADOPAGO_PIX ? await createMercadoPagoPix({
        referenceId: order.mercadoPagoReferenceId,
        idempotencyKey: order.mercadoPagoIdempotencyKey,
        amountCents: snapshot.totalCents,
        expiresAt: order.paymentExpiresAt,
        description: `Pedido ${order.id}`,
        customer
      }) : await createPixOrder({
        referenceId: order.pagBankReferenceId,
        idempotencyKey: order.pagBankIdempotencyKey,
        amountCents: snapshot.totalCents,
        expiresAt: order.paymentExpiresAt,
        items: snapshot.items,
        customer
      });
      if (method === PAYMENT_METHOD.MERCADOPAGO_PIX) {
        order.mercadoPagoPaymentId = charge.paymentId;
        order.mercadoPagoPixCopyPaste = charge.copyPaste;
      } else {
        order.pagBankOrderId = charge.pagBankOrderId;
        order.pagBankPixCopyPaste = charge.copyPaste;
        order.pagBankQrCodeImageUrl = charge.qrCodeImageUrl;
      }
      delete order.paymentCreationUncertainAt;
      order.paymentExpiresAt = charge.expiresAt || order.paymentExpiresAt;
      touchOrder(order);
      appendAuditLog(db, context, method === PAYMENT_METHOD.MERCADOPAGO_PIX ? "order.mercadopago_qr_created" : "order.pagbank_qr_created", { order, amountCents: snapshot.totalCents, providerPaymentId: order.mercadoPagoPaymentId || order.pagBankOrderId });
      await persistPaymentOrder(db, order, panel);
    } catch (error) {
      return handleAutomaticPaymentCreationFailure(context, db, order, panel, method, error);
    }
    const paymentPayload = await buildPagBankPaymentPayload(order, panel);
    await context.channel.send({ content: `<@${order.userId}> pagamento do pedido #${order.id}:`, ...paymentPayload, allowedMentions: { users: [order.userId] } });
    await sendSafeDM(order.userId, paymentPayload);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    return actionReply(context, { content: `Pix ${method === PAYMENT_METHOD.MERCADOPAGO_PIX ? "Mercado Pago" : "PagBank"} gerado e enviado no carrinho.`, ephemeral: true });
  } finally {
    releaseOrderActionLock(order);
  }
}
async function handlePagBankCustomerSubmit(interaction) {
  const [, orderId] = interaction.customId.split(":");
  return startOrderPayment(interaction, orderId, {
    name: interaction.fields.getTextInputValue("name"),
    email: interaction.fields.getTextInputValue("email"),
    taxId: interaction.fields.getTextInputValue("taxId")
  });
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
function closedCartDeleteSeconds(order = null) {
  if (String(order?.status || "") === ORDER_STATUS.EXPIRED_INACTIVITY) {
    const inactive = Number(process.env.INACTIVE_CART_DELETE_SECONDS ?? 10);
    return Number.isFinite(inactive) && inactive >= 0 ? inactive : 10;
  }
  if ([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELED].includes(String(order?.status || ""))) {
    const cancelled = Number(process.env.CANCELLED_CART_DELETE_SECONDS ?? 10);
    return Number.isFinite(cancelled) && cancelled >= 0 ? cancelled : 10;
  }
  const configured = Number(process.env.CLOSED_CART_DELETE_SECONDS ?? config.settings?.deleteClosedCartAfterSeconds ?? 90 * 60);
  if (!Number.isFinite(configured)) return 90 * 60;
  return Math.min(2 * 60 * 60, Math.max(60 * 60, configured));
}
function closedCartDeleteLabel(order = null) {
  const seconds = closedCartDeleteSeconds(order);
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} segundo(s)`;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minuto(s)`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return `${hours} hora(s)`;
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return `${wholeHours}h${String(minutes).padStart(2, "0")}`;
}
function isFinishedCart(order) {
  return ["closed", "cancelled", "canceled", ORDER_STATUS.EXPIRED_INACTIVITY].includes(String(order?.status || ""));
}
async function deleteClosedCartChannel(order) {
  if (!order?.guildId || !order?.channelId || !isFinishedCart(order)) return;

  try {
    const guild = await client.guilds.fetch(order.guildId);
    const channel = await guild.channels.fetch(order.channelId).catch(() => null);
    if (channel?.deletable) await channel.delete(`Carrinho ${order.id} encerrado ha ${closedCartDeleteLabel(order)}`);
  } catch (error) {
    console.log(`Nao consegui apagar carrinho ${order.id}: ${error.message}`);
  } finally {
    cartDeleteTimers.delete(order.id);
  }
}
function scheduleCartDeletion(order) {
  if (!order?.id || !order.channelId || !isFinishedCart(order)) return false;
  if (cartDeleteTimers.has(order.id)) clearTimeout(cartDeleteTimers.get(order.id));

  const seconds = closedCartDeleteSeconds(order);
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
function scheduleInactiveTicketDeletion(ticket) {
  if (!ticket?.id || !ticket.channelId || ticket.status !== ORDER_STATUS.EXPIRED_INACTIVITY) return false;
  if (ticketDeleteTimers.has(ticket.id)) clearTimeout(ticketDeleteTimers.get(ticket.id));
  const seconds = Math.max(0, Number(process.env.INACTIVE_CART_DELETE_SECONDS ?? 10) || 10);
  const closedAt = Date.parse(ticket.closedAt || new Date().toISOString());
  const delay = Math.max(1000, closedAt + seconds * 1000 - Date.now());
  const timer = setTimeout(async () => {
    ticketDeleteTimers.delete(ticket.id);
    const guild = client.guilds.cache.get(ticket.guildId);
    const channel = guild ? await guild.channels.fetch(ticket.channelId).catch(() => null) : null;
    if (channel?.deletable) await channel.delete(`Ticket ${ticket.id} expirado por inatividade`).catch(() => null);
  }, Math.min(delay, 2_147_483_647));
  ticketDeleteTimers.set(ticket.id, timer);
  return true;
}
async function recordHumanActivity(guildId, channelId, at = new Date()) {
  if (!guildId || !channelId) return false;
  const db = readOrders();
  const order = Object.values(db.orders || {}).find(item =>
    item.guildId === guildId &&
    item.channelId === channelId &&
    item.status === ORDER_STATUS.OPEN
  );
  const ticket = Object.values(db.tickets || {}).find(item =>
    (!item.guildId || item.guildId === guildId) &&
    item.channelId === channelId &&
    item.status === ORDER_STATUS.OPEN
  );
  let changed = false;
  if (order && markHumanActivity(order, at)) {
    touchOrder(order);
    db.orders[order.id] = order;
    changed = true;
  }
  if (ticket && markHumanActivity(ticket, at)) {
    ticket.guildId = ticket.guildId || guildId;
    db.tickets[ticket.id] = ticket;
    changed = true;
  }
  if (!changed) return false;
  writeOrders(db);
  if (order) await persistOrderRelationalAsync(db, order, getOrderPanel(order, guildId));
  return true;
}
async function backfillLegacyActivity(guild) {
  const db = readOrders();
  const records = [
    ...Object.values(db.orders || {}).filter(item => item.guildId === guild.id && item.status === ORDER_STATUS.OPEN && item.activityNeedsChannelBackfill),
    ...Object.values(db.tickets || {}).filter(item => (!item.guildId || item.guildId === guild.id) && item.status === ORDER_STATUS.OPEN && item.activityNeedsChannelBackfill)
  ];
  if (!records.length) return 0;
  let changed = 0;
  const changedOrders = [];
  for (const record of records) {
    record.guildId = record.guildId || guild.id;
    const channel = await guild.channels.fetch(record.channelId).catch(() => null);
    let latestHuman = null;
    if (channel?.isTextBased?.() && channel.messages?.fetch) {
      let before;
      for (let page = 0; page < 5 && !latestHuman; page += 1) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
        if (!messages?.size) break;
        latestHuman = [...messages.values()]
          .filter(message => !message.author?.bot)
          .sort((a, b) => Number(b.createdTimestamp) - Number(a.createdTimestamp))[0] || null;
        before = messages.last()?.id;
        if (messages.size < 100) break;
      }
    }
    if (latestHuman) markHumanActivity(record, new Date(latestHuman.createdTimestamp));
    else delete record.activityNeedsChannelBackfill;
    if (db.orders?.[record.id]) {
      touchOrder(record);
      db.orders[record.id] = record;
      changedOrders.push(record);
    } else {
      record.guildId = record.guildId || guild.id;
      db.tickets[record.id] = record;
    }
    changed += 1;
  }
  if (!changed) return 0;
  writeOrders(db);
  for (const order of changedOrders) {
    await persistOrderRelationalAsync(db, order, getOrderPanel(order, guild.id));
  }
  return changed;
}
let inactivitySweepRunning = false;
async function sweepInactiveCarts() {
  if (inactivitySweepRunning) return;
  inactivitySweepRunning = true;
  try {
    const db = readOrders();
    const now = Date.now();
    const threshold = inactivityMs();
    for (const order of Object.values(db.orders || {})) {
      if (!isManualInactivityCandidate(order)) continue;
      if (!isInactive(order, now, threshold) || !claimOrderActionLock(order)) continue;
      try {
        const current = readOrders().orders?.[order.id];
        if (!current || current.status !== ORDER_STATUS.OPEN || !isInactive(current, now, threshold)) continue;
        const panel = getOrderPanel(current, current.guildId);
        if (current.stockReservedAt && postgresEnabled()) {
          await releaseOrderStock(getPostgresPool(), current.id).catch(error => {
            console.warn(`Nao consegui liberar a reserva do pedido #${current.id} expirado: ${errorSummary(error).message}`);
          });
          delete current.stockReservedAt;
          current.stockReleasedAt = new Date().toISOString();
        }
        current.status = ORDER_STATUS.EXPIRED_INACTIVITY;
        current.paymentState = PAYMENT_STATE.EXPIRED;
        current.expiredInactivityAt = new Date().toISOString();
        current.closedAt = current.expiredInactivityAt;
        touchOrder(current);
        const currentDb = readOrders();
        currentDb.orders[current.id] = current;
        await persistPaymentOrder(currentDb, current, panel);
        const guild = client.guilds.cache.get(current.guildId);
        const channel = guild ? await guild.channels.fetch(current.channelId).catch(() => null) : null;
        if (channel?.isTextBased?.()) {
          await channel.send("Este carrinho foi fechado automaticamente por ficar mais de 16 horas sem interacoes.").catch(() => null);
          await channel.permissionOverwrites.edit(current.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
          await channel.setName(channel.name.includes("aberto") ? channel.name.replace("aberto", "expirado") : `carrinho-expirado-${current.id}`).catch(() => null);
          const closedCategoryId = categoryId(current.guildId, "closed");
          if (closedCategoryId) await channel.setParent(closedCategoryId, { lockPermissions: false }).catch(() => null);
          await refreshCartMessage(guild, current, panel, channel).catch(() => null);
        }
        scheduleCartDeletion(current);
      } catch (error) {
        console.warn(`Falha ao expirar o pedido #${order.id}: ${errorSummary(error).message}`);
      } finally {
        releaseOrderActionLock(order);
      }
    }
    const freshDb = readOrders();
    for (const ticket of Object.values(freshDb.tickets || {})) {
      if (ticket.status !== ORDER_STATUS.OPEN || !isInactive(ticket, now, threshold) || ticketInactivityLocks.has(ticket.id)) continue;
      ticketInactivityLocks.add(ticket.id);
      try {
        const current = readOrders().tickets?.[ticket.id];
        if (!current || current.status !== ORDER_STATUS.OPEN || !isInactive(current, now, threshold)) continue;
        current.status = ORDER_STATUS.EXPIRED_INACTIVITY;
        current.expiredInactivityAt = new Date().toISOString();
        current.closedAt = current.expiredInactivityAt;
        const currentDb = readOrders();
        currentDb.tickets[current.id] = current;
        writeOrders(currentDb);
        await flushPersistentFile(ORDERS_FILE);
        const guild = client.guilds.cache.get(current.guildId);
        const channel = guild ? await guild.channels.fetch(current.channelId).catch(() => null) : null;
        if (channel?.isTextBased?.()) {
          await channel.send("Este ticket foi fechado automaticamente por ficar mais de 16 horas sem interacoes.").catch(() => null);
          await channel.permissionOverwrites.edit(current.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
        }
        scheduleInactiveTicketDeletion(current);
      } catch (error) {
        console.warn(`Falha ao expirar o ticket #${ticket.id}: ${errorSummary(error).message}`);
      } finally {
        ticketInactivityLocks.delete(ticket.id);
      }
    }
  } finally {
    inactivitySweepRunning = false;
  }
}
const inactivitySweepTimer = setInterval(() => {
  sweepInactiveCarts().catch(error => console.error("Falha ao encerrar carrinhos inativos:", errorSummary(error)));
}, INACTIVITY_SWEEP_INTERVAL_MS);
inactivitySweepTimer.unref?.();
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
async function collectChannelTranscript(channel, limit = 80, options = {}) {
  if (!channel?.messages?.fetch) return "Mensagens indisponiveis.";
  const messages = await channel.messages.fetch({ limit }).catch(() => null);
  if (!messages) return "Nao foi possivel buscar mensagens do canal.";
  const includeIds = options.includeIds !== false;
  return [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(message => {
      const authorName = message.author?.tag || message.author?.username || "desconhecido";
      const author = includeIds ? `${authorName} (${message.author?.id || "sem-id"})` : authorName;
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
async function buildCustomerTranscriptAttachment(channel, order, panel) {
  const totals = orderTotals(order, panel);
  const items = (order.items || []).map(item => {
    const details = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    return `- ${details.name} | ${quantity}x | ${details.price}`;
  });
  const header = [
    `${client.user?.username || "LOJA"} - COMPROVANTE E HISTORICO`,
    `Pedido: #${order.id}`,
    `Status: finalizado`,
    `Cliente: ${order.username || "cliente"}`,
    `Atendente: ${order.assignedAdminName || order.closedByAdminName || "equipe"}`,
    `Total: ${money(totals.amount)}`,
    `Criado em: ${order.createdAt || ""}`,
    `Finalizado em: ${order.closedAt || ""}`,
    "",
    "ITENS:",
    ...(items.length ? items : ["- Pedido personalizado"]),
    ""
  ].join("\n");
  const messages = await collectChannelTranscript(channel, 100, { includeIds: false });
  const text = `${header}\nHISTORICO DO CARRINHO:\n${messages}\n`;
  return new AttachmentBuilder(Buffer.from(text, "utf8"), {
    name: `historico-compra-${String(order.id || "pedido").replace(/[^\w-]/g, "")}.txt`
  });
}
function completionChannelId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).completionChannelId : "";
  return String(saved || process.env.COMPLETION_CHANNEL_ID || legacyStoreValue(config.completion?.channelId, DEFAULT_COMPLETION_CHANNEL_ID)).trim();
}
function completionFeedEnabled() {
  return config.completion?.enabled !== false && process.env.COMPLETION_FEED_ENABLED !== "false";
}
function completionTranscriptEnabled() {
  return config.completion?.transcriptEnabled === true || process.env.COMPLETION_TRANSCRIPT_ENABLED === "true";
}
function cancellationChannelId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).cancellationChannelId : "";
  return String(saved || process.env.CANCELLATION_CHANNEL_ID || legacyStoreValue(config.cancellation?.channelId, DEFAULT_CANCELLATION_CHANNEL_ID)).trim();
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
    serverConfig(guildId).customerRoleId,
    process.env.CUSTOMER_ROLE_ID,
    legacyStoreValue(config.customerRoleId, DEFAULT_CUSTOMER_ROLE_ID)
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
  if (staff.successChannelId === completionChannelId(guild.id)) return false;

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

  const channelId = completionChannelId(guild.id);
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

  const channelId = cancellationChannelId(guild.id);
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
    .setDescription(`Este canal vai receber as vendas concluidas com nome mascarado.\n\nStatus: **${statusText}**\nCargo cliente: ${roleText}\nLimpeza de carrinhos: **${closedCartDeleteLabel()} apos encerrar**.`)
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
function finalizedOrderAmount(order, guildId) {
  if (order.spentAmount !== null && order.spentAmount !== undefined && order.spentAmount !== "" && Number.isFinite(Number(order.spentAmount))) {
    return Math.max(0, Number(order.spentAmount));
  }
  if (order.paidAmount !== null && order.paidAmount !== undefined && order.paidAmount !== "" && Number.isFinite(Number(order.paidAmount))) {
    return Math.max(0, Number(order.paidAmount));
  }
  return orderTotals(order, getOrderPanel(order, guildId)).amount;
}
function revenueDashboardData(guildId) {
  const nowKeys = periodKeys(new Date());
  const rows = Object.values(readOrders().orders || {})
    .filter(order => order.guildId === guildId && order.status === ORDER_STATUS.CLOSED)
    .map(order => {
      const closedAt = new Date(order.closedAt || order.updatedAt || order.createdAt || Date.now());
      return {
        order,
        amount: finalizedOrderAmount(order, guildId),
        quantity: Math.max(0, Number(order.totalQuantity) || orderTotals(order, getOrderPanel(order, guildId)).quantity),
        keys: periodKeys(closedAt),
        timestamp: closedAt.getTime()
      };
    })
    .filter(row => row.amount > 0 && Number.isFinite(row.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);
  const sum = predicate => roundCurrency(rows.filter(predicate).reduce((total, row) => total + row.amount, 0));
  const total = sum(() => true);
  return {
    rows,
    total,
    today: sum(row => row.keys.day === nowKeys.day),
    week: sum(row => row.keys.week === nowKeys.week),
    month: sum(row => row.keys.month === nowKeys.month),
    orders: rows.length,
    items: rows.reduce((totalItems, row) => totalItems + row.quantity, 0),
    average: rows.length ? roundCurrency(total / rows.length) : 0
  };
}
function revenueDashboardEmbed(guildId) {
  const data = revenueDashboardData(guildId);
  const settings = serverConfig(guildId);
  const storeName = process.env.PUBLIC_STORE_NAME?.trim() || "Loja";
  const embed = new EmbedBuilder()
    .setTitle(`Faturamento - ${storeName}`)
    .setDescription("Valores confirmados em compras finalizadas. Descontos e quantidades ja estao aplicados.")
    .setColor(0x28f6a1)
    .addFields(
      { name: "Total faturado", value: `**${money(data.total)}**`, inline: false },
      { name: "Hoje", value: money(data.today), inline: true },
      { name: "Semana", value: money(data.week), inline: true },
      { name: "Mes", value: money(data.month), inline: true },
      { name: "Vendas", value: String(data.orders), inline: true },
      { name: "Itens", value: String(data.items), inline: true },
      { name: "Ticket medio", value: money(data.average), inline: true }
    )
    .setFooter({ text: `Instancia isolada: ${instanceConfig.STORE_INSTANCE_ID}` })
    .setTimestamp();

  if (settings.revenueListEnabled) {
    const lines = data.rows.slice(0, 10).map(row => {
      const order = row.order;
      const time = Math.floor(row.timestamp / 1000);
      return `#${order.id} | ${maskCustomerName(order.username)} | **${money(row.amount)}** | ${row.quantity} item(ns) | <t:${time}:R>`;
    });
    embed.addFields({
      name: "Ultimas vendas",
      value: lines.join("\n").slice(0, 1024) || "Nenhuma venda finalizada ainda.",
      inline: false
    });
  }
  return embed;
}
function revenueDashboardRows(guildId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("revenue:refresh").setLabel("Atualizar").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("revenue:toggle")
      .setLabel(serverConfig(guildId).revenueListEnabled ? "Ocultar lista" : "Mostrar lista")
      .setStyle(ButtonStyle.Primary)
  )];
}
async function updateRevenueDashboard(guild, options = {}) {
  const settings = serverConfig(guild.id);
  const channelId = String(settings.revenueChannelId || "").trim();
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return null;
  const payload = { embeds: [revenueDashboardEmbed(guild.id)], components: revenueDashboardRows(guild.id) };
  let message = !options.forceNew && settings.revenueMessageId
    ? await channel.messages.fetch(settings.revenueMessageId).catch(() => null)
    : null;
  if (message) await message.edit(payload);
  else {
    message = await channel.send(payload);
    saveServerConfig(guild.id, { revenueMessageId: message.id });
    await flushPersistentFile(STAFF_FILE).catch(() => null);
  }
  return message;
}
async function setupRevenueDashboard(context, options = {}) {
  if (!isAdmin(context.member)) return actionReply(context, { content: "So ADM pode configurar o faturamento.", ephemeral: true });
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  const channel = options.channel || context.channel;
  if (!channel?.isTextBased?.() || channel.type === ChannelType.GuildForum) {
    return actionReply(context, { content: "Escolha um canal de texto valido.", ephemeral: true });
  }
  const current = serverConfig(actionGuildId(context));
  saveServerConfig(actionGuildId(context), {
    revenueChannelId: channel.id,
    revenueMessageId: current.revenueChannelId === channel.id ? current.revenueMessageId || "" : "",
    revenueListEnabled: options.listEnabled ?? Boolean(current.revenueListEnabled)
  });
  await flushPersistentFile(STAFF_FILE);
  const message = await updateRevenueDashboard(context.guild);
  const everyoneCanView = channel.permissionsFor?.(context.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
  return actionReply(context, {
    content: `Painel de faturamento configurado em <#${channel.id}>.${everyoneCanView ? " Esse canal esta visivel para @everyone; torne-o privado para esconder os valores." : " O canal esta privado para @everyone."}${message ? "" : " Nao consegui publicar a mensagem."}`,
    ephemeral: true
  });
}
async function handleRevenueButton(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode usar o painel de faturamento.")) return;
  await interaction.deferUpdate();
  const [, action] = interaction.customId.split(":");
  if (action === "toggle") {
    saveServerConfig(interaction.guildId, { revenueListEnabled: !Boolean(serverConfig(interaction.guildId).revenueListEnabled) });
    await flushPersistentFile(STAFF_FILE).catch(() => null);
  }
  return interaction.editReply({ embeds: [revenueDashboardEmbed(interaction.guildId)], components: revenueDashboardRows(interaction.guildId) });
}
function webOrderEmbed(guildId, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  const order = readOrders().webOrders?.[code];
  if (!order || order.guildId !== guildId) return null;
  const expired = Date.parse(order.expiresAt || "") < Date.now();
  const lines = (order.items || []).map(item => `- **${item.name}** ${item.quantity}x - ${money(Number(item.subtotalCents || 0) / 100)}`);
  return new EmbedBuilder()
    .setTitle(`Pedido do site ${order.id}`)
    .setDescription(lines.join("\n").slice(0, 4096) || "Pedido sem itens.")
    .setColor(expired ? 0xffb020 : 0x28f6a1)
    .addFields(
      { name: "Total", value: `**${money(Number(order.totalCents || 0) / 100)}**`, inline: true },
      { name: "Status", value: expired ? "Expirado" : "Aguardando atendimento", inline: true },
      { name: "Origem", value: "Site Sávio Store", inline: true }
    )
    .setFooter({ text: "Confira os itens antes de abrir ou preencher o carrinho do cliente." })
    .setTimestamp(new Date(order.createdAt || Date.now()));
}
async function showWebOrder(context, code) {
  const embed = webOrderEmbed(actionGuildId(context), code);
  if (!embed) return actionReply(context, { content: "Pedido do site nao encontrado nesta loja.", ephemeral: true });
  return actionReply(context, { embeds: [embed], ephemeral: true });
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
    p.stockMode === STOCK_MODE.AUTOMATIC ? "Disponibilidade automatica" : `Estoque: ${String(p.stock || "infinito")}`
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
async function findRecoverableSalePanels(channel, guildId, scopeId = null, limit = 75, options = {}) {
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
    const compatibleBot = Boolean(options.allowOtherBotAuthors && message.author?.bot);
    if ((!sameBot && !compatibleBot) || !saleSelectComponentFromMessage(message) || seen.has(message.id)) continue;
    const select = saleSelectComponentFromMessage(message);
    const panelKey = panelIdFromComponentCustomId(componentCustomId(select)) || message.channelId;
    if (seenPanelKeys.has(panelKey) || options.skipPanelIds?.has(panelKey)) continue;
    seen.add(message.id);
    seenPanelKeys.add(panelKey);
    const panel = await recoverPanelFromPublishedMessage(message, guildId, scopeId).catch(() => null);
    if (panel) {
      options.skipPanelIds?.add(panel.id || panelKey);
      recovered.push(panel);
    }
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
async function scanGuildForPublishedSalePanels(guild, guildId, force = false, options = {}) {
  if (process.env.PUBLIC_STORE_SCAN_CHANNELS === "false" && !options.ignoreDisabled) return [];
  if (!force && publicPanelScanFresh(guildId)) return [];
  publicPanelScanCache.set(guildId, Date.now());

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels?.size) return [];

  const maxChannels = Math.max(1, Number(options.maxChannels || process.env.PUBLIC_STORE_SCAN_CHANNEL_LIMIT || 80) || 80);
  const messageLimit = Math.min(100, Math.max(10, Number(options.messageLimit || process.env.PUBLIC_STORE_SCAN_MESSAGE_LIMIT || 75) || 75));
  const candidates = [...channels.values()]
    .filter(isScannablePublicChannel)
    .sort((a, b) => (a.rawPosition ?? 9999) - (b.rawPosition ?? 9999))
    .slice(0, maxChannels);
  const recovered = [];

  for (const channel of candidates) {
    const panels = await findRecoverableSalePanels(channel, guildId, null, messageLimit, options).catch(() => []);
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
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:rewards`).setLabel("Sorteio/Chances").setEmoji("🎲").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:stock`).setLabel("Estoque secreto").setEmoji("🔐").setStyle(ButtonStyle.Primary)
    )
  ];
}
function stockRuntimeError() {
  if (!postgresEnabled()) return "Configure DATABASE_URL antes de usar estoque automatico.";
  try {
    validateStockEncryptionKey(process.env.STOCK_ENCRYPTION_KEY);
  } catch (error) {
    return error.message;
  }
  return "";
}
function stockProductMenu(sessionId, panel) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`stockproduct:${sessionId}`)
      .setPlaceholder("Produto para configurar estoque")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(item => ({
        label: `${productIcon(item)} ${String(item.name || "Produto").slice(0, 95)}`,
        description: item.stockMode === STOCK_MODE.AUTOMATIC ? "Estoque automatico ativo" : "Estoque manual",
        value: item.id
      })))
  );
}
function rememberStockSession(input) {
  const session = { ...input, expiresAt: Date.now() + CONFIG_SESSION_TTL_MS };
  stockAdminSessions.set(session.id, session);
  return session;
}
async function stockSessionOrReply(interaction) {
  const parts = interaction.customId.split(":");
  const session = stockAdminSessions.get(parts[1]);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) stockAdminSessions.delete(session.id);
    await actionReply(interaction, { content: "Sessao de estoque expirada. Abra /configds novamente.", ephemeral: true });
    return null;
  }
  if (session.ownerId !== interaction.user.id || session.guildId !== interaction.guildId || !isBotOwner(interaction.user)) {
    writeAuditLog(interaction, "security.stock_access_denied", { productId: session.productId || "" });
    await actionReply(interaction, { content: "Somente o proprietario que abriu esta sessao pode usar o estoque.", ephemeral: true });
    return null;
  }
  session.expiresAt = Date.now() + CONFIG_SESSION_TTL_MS;
  return session;
}
async function stockDashboardPayload(session, notice = "") {
  const summary = await stockSummary(getPostgresPool(), session.dbProductId, session.guildId);
  const mode = session.stockMode === STOCK_MODE.AUTOMATIC ? "AUTOMATICO" : "MANUAL";
  const embed = new EmbedBuilder()
    .setTitle(`Estoque: ${session.productName}`.slice(0, 256))
    .setDescription([notice, `Modo atual: **${mode}**`, "O conteudo fica criptografado no Postgres e nunca entra no painel publico."].filter(Boolean).join("\n\n"))
    .setColor(0x28f6a1)
    .addFields(
      { name: "Disponiveis", value: String(summary.AVAILABLE), inline: true },
      { name: "Reservados", value: String(summary.RESERVED), inline: true },
      { name: "Vendidos", value: String(summary.SOLD), inline: true },
      { name: "Desativados", value: String(summary.DISABLED), inline: true }
    )
    .setFooter({ text: "Apenas BOT_OWNER_IDS pode usar estes controles." })
    .setTimestamp();
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stock:${session.id}:mode`).setLabel(session.stockMode === STOCK_MODE.AUTOMATIC ? "Desativar automatico" : "Ativar automatico").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`stock:${session.id}:add`).setLabel("Adicionar itens").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`stock:${session.id}:replace`).setLabel("Substituir disponiveis").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`stock:${session.id}:view`).setLabel("Visualizar itens").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stock:${session.id}:remove`).setLabel("Remover item").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`stock:${session.id}:clear`).setLabel("Limpar disponiveis").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`stock:${session.id}:history`).setLabel("Historico").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`stock:${session.id}:refresh`).setLabel("Atualizar").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`stock:${session.id}:close`).setLabel("Fechar").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}
function stockInputModal(session, replace = false) {
  return new ModalBuilder()
    .setCustomId(`stockmodal:${session.id}:${replace ? "replace" : "add"}`)
    .setTitle(replace ? "Substituir estoque" : "Adicionar estoque")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("items")
        .setLabel("Uma key/conta por linha")
        .setPlaceholder("KEY-AAAA-BBBB\nKEY-CCCC-DDDD")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(true)
    ));
}
async function handleStockProductSelect(interaction) {
  const [, configSessionId] = interaction.customId.split(":");
  const configSession = await sessionOrReply(interaction, configSessionId);
  if (!configSession) return;
  if (!await requireBotOwner(interaction)) return;
  const runtimeError = stockRuntimeError();
  if (runtimeError) return actionReply(interaction, { content: runtimeError, ephemeral: true });
  const panel = getPanel(configSession.guildId, configSession.scopeId);
  const item = product(panel, interaction.values[0]);
  if (!item) return actionReply(interaction, { content: "Produto nao encontrado.", ephemeral: true });
  await interaction.deferUpdate();
  await withPostgresTransaction(client => upsertPanelRelational(client, configSession.guildId, panel));
  const session = rememberStockSession({
    id: sid(),
    ownerId: interaction.user.id,
    guildId: configSession.guildId,
    scopeId: configSession.scopeId,
    configSessionId,
    panelId: panel.id,
    productId: item.id,
    dbProductId: dbProductId(panel.id, item.id),
    productName: item.name,
    stockMode: item.stockMode === STOCK_MODE.AUTOMATIC ? STOCK_MODE.AUTOMATIC : STOCK_MODE.MANUAL
  });
  return interaction.editReply(await stockDashboardPayload(session));
}
async function handleStockButton(interaction) {
  const session = await stockSessionOrReply(interaction);
  if (!session) return;
  const [, , action, pageText] = interaction.customId.split(":");
  const panel = getPanel(session.guildId, session.scopeId);
  const item = product(panel, session.productId);
  if (!item) return actionReply(interaction, { content: "Produto removido do painel.", ephemeral: true });
  if (action === "close") {
    stockAdminSessions.delete(session.id);
    return interaction.update({ content: "Configuracao de estoque fechada.", embeds: [], components: [] });
  }
  if (action === "mode") {
    await interaction.deferUpdate();
    const next = session.stockMode === STOCK_MODE.AUTOMATIC ? STOCK_MODE.MANUAL : STOCK_MODE.AUTOMATIC;
    if (next === STOCK_MODE.AUTOMATIC) {
      const summary = await stockSummary(getPostgresPool(), session.dbProductId, session.guildId);
      if (!summary.AVAILABLE) return interaction.editReply(await stockDashboardPayload(session, "Adicione ao menos um item antes de ativar o estoque automatico."));
    }
    await setStockMode(getPostgresPool(), session.dbProductId, session.guildId, next);
    item.stockMode = next;
    session.stockMode = next;
    savePanel(session.guildId, panel, session.scopeId);
    writeAuditLog(interaction, "stock.mode_changed", { productId: item.id, productName: item.name, stockMode: next });
    await refreshConfig(session.configSessionId);
    return interaction.editReply(await stockDashboardPayload(session, `Modo alterado para **${next}**.`));
  }
  if (action === "add" || action === "replace") return interaction.showModal(stockInputModal(session, action === "replace"));
  if (action === "view") {
    return interaction.reply({
      content: "As keys completas serao exibidas somente para voce. Confirme para continuar.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stock:${session.id}:reveal:0`).setLabel("Confirmar visualizacao").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`stock:${session.id}:dashboard`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
      )],
      ephemeral: true
    });
  }
  if (action === "reveal") {
    await interaction.deferUpdate();
    const page = Math.max(0, Number(pageText) || 0);
    const rows = await listStock(getPostgresPool(), session.dbProductId, session.guildId, { limit: 10, offset: page * 10 });
    const lines = rows.map(row => `#${row.id} | ${row.status} | ${row.encrypted_value ? `||${decryptStockValue(row, process.env.STOCK_ENCRYPTION_KEY)}||` : "item legado desativado"}`);
    return interaction.editReply({
      content: lines.length ? `Itens do estoque (pagina ${page + 1}):\n${lines.join("\n")}`.slice(0, 1900) : "Nenhum item nesta pagina.",
      embeds: [],
      allowedMentions: { parse: [] },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stock:${session.id}:reveal:${Math.max(0, page - 1)}`).setLabel("Anterior").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`stock:${session.id}:reveal:${page + 1}`).setLabel("Proxima").setStyle(ButtonStyle.Secondary).setDisabled(rows.length < 10),
        new ButtonBuilder().setCustomId(`stock:${session.id}:dashboard`).setLabel("Voltar").setStyle(ButtonStyle.Primary)
      )]
    });
  }
  if (action === "dashboard" || action === "refresh") {
    await interaction.deferUpdate();
    return interaction.editReply(await stockDashboardPayload(session));
  }
  if (action === "remove") {
    await interaction.deferReply({ ephemeral: true });
    const rows = await listStock(getPostgresPool(), session.dbProductId, session.guildId, { limit: 25, status: STOCK_STATUS.AVAILABLE });
    if (!rows.length) return actionReply(interaction, { content: "Nao existem itens disponiveis para remover.", ephemeral: true });
    const menu = new StringSelectMenuBuilder().setCustomId(`stockremove:${session.id}`).setPlaceholder("Item disponivel para desativar").setMinValues(1).setMaxValues(1)
      .addOptions(rows.map(row => ({ label: `Item #${row.id}`, description: `Adicionado em ${new Date(row.created_at).toLocaleDateString("pt-BR")}`, value: String(row.id) })));
    return interaction.editReply({ content: "Escolha o item pelo ID interno. A key nao e colocada no menu.", components: [new ActionRowBuilder().addComponents(menu)] });
  }
  if (action === "clear") {
    return interaction.reply({
      content: "Isso desativa todos os itens disponiveis. Reservados e vendidos nao serao alterados.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`stock:${session.id}:clearconfirm`).setLabel("Confirmar limpeza").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`stock:${session.id}:dashboard`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
      )],
      ephemeral: true
    });
  }
  if (action === "clearconfirm") {
    await interaction.deferUpdate();
    const count = await clearAvailableStock(getPostgresPool(), session.dbProductId, session.guildId);
    writeAuditLog(interaction, "stock.cleared", { productId: session.productId, productName: session.productName, quantity: count });
    return interaction.editReply(await stockDashboardPayload(session, `${count} item(ns) disponiveis foram desativados.`));
  }
  if (action === "history") {
    const db = readOrders();
    const entries = (db.auditLogs || []).filter(entry => String(entry.action).startsWith("stock.") && entry.details?.productId === session.productId).slice(-10).reverse();
    const text = entries.length ? entries.map(entry => `<t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:R> ${entry.action} por <@${entry.actorId || "0"}>`).join("\n") : "Nenhuma operacao registrada ainda.";
    return interaction.reply({ content: text, ephemeral: true, allowedMentions: { parse: [] } });
  }
}
async function handleStockModal(interaction) {
  const session = await stockSessionOrReply(interaction);
  if (!session) return;
  const action = interaction.customId.split(":")[2];
  await interaction.deferReply({ ephemeral: true });
  const result = await addStock(getPostgresPool(), {
    productId: session.dbProductId,
    guildId: session.guildId,
    actorId: interaction.user.id,
    secret: process.env.STOCK_ENCRYPTION_KEY,
    text: interaction.fields.getTextInputValue("items"),
    replace: action === "replace"
  });
  writeAuditLog(interaction, action === "replace" ? "stock.replaced" : "stock.added", {
    productId: session.productId,
    productName: session.productName,
    added: result.added,
    existing: result.existing,
    ignored: result.ignored
  });
  return interaction.editReply({
    content: `Estoque atualizado. Adicionados: **${result.added}** | Ja existentes: **${result.existing}** | Ignorados: **${result.ignored}**.`
  });
}
async function handleStockRemoveSelect(interaction) {
  const session = await stockSessionOrReply(interaction);
  if (!session) return;
  await interaction.deferUpdate();
  const removed = await disableStockItem(getPostgresPool(), session.dbProductId, session.guildId, interaction.values[0]);
  writeAuditLog(interaction, "stock.item_disabled", { productId: session.productId, productName: session.productName, itemId: interaction.values[0], removed });
  return interaction.editReply({ content: removed ? "Item desativado." : "O item nao estava mais disponivel.", components: [] });
}
async function refreshConfig(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  const payload = { embeds: [configEmbed(panel, s.ownerId)], components: configRows(sessionId) };

  if (s.ephemeral && s.webhook && s.messageId) {
    try {
      await s.webhook.editMessage(s.messageId, payload);
    } catch (e) {
      console.error("refreshConfig ephemeral:", e.message);
    }
    return;
  }

  try {
    const guild = await client.guilds.fetch(s.guildId);
    const ch = await guild.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(s.messageId);
    await msg.edit(payload);
  } catch (e) { console.error("refreshConfig:", e.message); }
}
async function removeLegacyPublicConfig(panel, guild) {
  if (!panel.configMessageChannelId || !panel.configMessageId) return;
  const channel = await guild.channels.fetch(panel.configMessageChannelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(panel.configMessageId).catch(() => null)
    : null;
  const hasConfigControls = message?.components?.some(row => row.components?.some(component =>
    String(component.customId || component.data?.custom_id || "").startsWith("cfg:")
  ));
  const hasConfigTitle = message?.embeds?.some(embed => String(embed.title || "").includes("Configurador da Loja"));
  if (message?.author?.id === client.user.id && (hasConfigControls || hasConfigTitle)) {
    await message.delete().catch(() => null);
  }
}
async function openPrivateConfigSession(interaction, panel, options = {}) {
  const channel = interaction.channel;
  const user = interaction.user;
  const guildId = interaction.guildId;
  const sessionId = sid();

  await removeLegacyPublicConfig(panel, interaction.guild);
  panel.configMessageChannelId = "";
  panel.configMessageId = "";
  savePanel(guildId, panel, channel.id);

  const session = {
    guildId,
    scopeId: channel.id,
    channelId: channel.id,
    messageId: "",
    ownerId: user.id,
    ephemeral: true,
    webhook: interaction.webhook,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIG_SESSION_TTL_MS
  };
  sessions.set(sessionId, session);

  try {
    const payload = {
      content: options.content || undefined,
      embeds: [configEmbed(panel, user.id)],
      components: configRows(sessionId),
      ephemeral: true
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(stripEphemeral(payload));
    else await interaction.reply(payload);
    const message = await interaction.fetchReply();
    session.messageId = message.id;
    return session;
  } catch (error) {
    sessions.delete(sessionId);
    throw error;
  }
}
async function startConfig(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Você precisa ser ADM para abrir o configurador da loja.", ephemeral: true });
  }
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  const guildId = interaction.guildId;
  let panel = getPanel(guildId, channel.id);
  if (shouldAutoRecoverPanel(panel)) {
    panel = await findRecoverableSalePanel(channel, guildId, channel.id) || panel;
  }
  return openPrivateConfigSession(interaction, panel);
}
function quickPanelConfigModal() {
  return new ModalBuilder()
    .setCustomId("quickcfgmodal")
    .setTitle("Criar painel rapido")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("template")
          .setLabel("Template do painel")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(true)
          .setValue(QUICK_PANEL_TEMPLATE.slice(0, 4000))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("mode")
          .setLabel("Modo: substituir, adicionar ou mesclar")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(20)
          .setRequired(true)
          .setValue("substituir")
      )
    );
}
function quickPanelMode(value) {
  const mode = plainText(value).replace(/\s+/g, "");
  if (["substituir", "substitui", "replace", "novo"].includes(mode)) return "replace";
  if (["adicionar", "adiciona", "add", "somar"].includes(mode)) return "add";
  if (["mesclar", "mescla", "merge", "atualizar"].includes(mode)) return "merge";
  throw new Error("Modo invalido. Use substituir, adicionar ou mesclar.");
}
function quickPanelProduct(input) {
  const rawPrice = clampText(input.price, 50, "R$ 0,00");
  const cents = priceCentsFromValue(rawPrice);
  const price = Number.isFinite(cents) ? money(cents / 100) : rawPrice;
  return {
    id: "p" + random7(),
    ...normalizeProductInput({
      name: input.name,
      price,
      description: input.description || "Produto da loja",
      stock: input.stock || "infinito",
      imageUrl: ""
    })
  };
}
function applyQuickPanelTemplate(panel, parsed, mode) {
  const incoming = parsed.products.map(quickPanelProduct);
  let products;

  if (mode === "replace") {
    products = incoming;
  } else if (mode === "add") {
    if ((panel.products || []).length + incoming.length > 25) {
      throw new Error("Adicionar ultrapassaria o limite de 25 produtos deste painel.");
    }
    products = [...(panel.products || []), ...incoming];
  } else {
    products = (panel.products || []).map(item => ({ ...item }));
    for (const next of incoming) {
      const existing = products.find(item => plainText(item.name) === plainText(next.name));
      if (existing) {
        const preserved = { id: existing.id, imageUrl: existing.imageUrl || "", type: existing.type, rewards: existing.rewards, stockMode: existing.stockMode || STOCK_MODE.MANUAL };
        Object.assign(existing, next, preserved);
      } else {
        products.push(next);
      }
    }
    if (products.length > 25) throw new Error("Mesclar ultrapassaria o limite de 25 produtos deste painel.");
  }
  panel.title = clampText(parsed.title, 256, "Painel da loja");
  panel.description = clampText(parsed.description, 4000, "Confira os produtos disponiveis.");
  if (parsed.color) panel.color = normColor(parsed.color);
  panel.products = products;
  return panel;
}
async function handleQuickPanelConfigModal(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Somente ADM pode criar painel rapido.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const parsed = parseQuickPanelTemplate(interaction.fields.getTextInputValue("template"));
    const mode = quickPanelMode(interaction.fields.getTextInputValue("mode"));
    const panel = getPanel(interaction.guildId, interaction.channelId);
    applyQuickPanelTemplate(panel, parsed, mode);
    savePanel(interaction.guildId, panel, interaction.channelId);
    writeAuditLog(interaction, "panel.quick_template_applied", {
      scopeId: interaction.channelId,
      panelId: panel.id,
      mode,
      productCount: parsed.products.length,
      totalProducts: panel.products.length
    });
    const modeLabel = mode === "replace" ? "substituido" : mode === "add" ? "adicionado" : "mesclado";
    return openPrivateConfigSession(interaction, panel, {
      content: `Template processado: **${parsed.products.length}** produto(s), painel ${modeLabel}. Revise abaixo e clique em **Publicar painel**.`
    });
  } catch (error) {
    return actionReply(interaction, {
      content: `Nao consegui processar o template: **${clampText(error.message, 500, "formato invalido")}**\nUse \`/configds2\` novamente e confira a linha indicada.`,
      ephemeral: true
    });
  }
}
function catalogPanelSnapshot(panel) {
  const quick = quickOrderConfig(panel);
  return {
    title: clampText(panel.title, 256, "Painel da loja"),
    description: clampText(panel.description, 4096),
    color: normColor(panel.color),
    imageUrl: validUrl(panel.imageUrl) ? String(panel.imageUrl || "") : "",
    thumbnailUrl: validUrl(panel.thumbnailUrl) ? String(panel.thumbnailUrl || "") : "",
    quickOrder: {
      title: clampText(quick.title, 256, "Compre aqui"),
      description: clampText(quick.description, 4096),
      buttonLabel: clampText(quick.buttonLabel, 80, "Comprar"),
      question1: clampText(quick.question1, 45),
      question2: clampText(quick.question2, 45)
    },
    products: (panel.products || []).slice(0, 250).map(item => ({
      name: clampText(item.name, 100, "Produto"),
      price: clampText(item.price, 40, "R$ 0,00"),
      priceCents: Number.isFinite(Number(item.priceCents)) ? Number(item.priceCents) : priceCentsFromValue(item.price),
      description: clampText(item.description, 1000, "Produto da loja."),
      stock: clampText(item.stock, 40, "infinito"),
      imageUrl: validUrl(item.imageUrl) ? String(item.imageUrl || "") : "",
      type: clampText(item.type, 40, "product"),
      rewards: Array.isArray(item.rewards) ? cloneJson(item.rewards.slice(0, 100)) : undefined
    }))
  };
}
function storeCatalogExport(guildId) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const panels = allPublicPanels(guildStore)
    .filter(panel => (panel.products || []).length || panel.title || panel.description)
    .map(catalogPanelSnapshot);
  return {
    format: "dragon-store-catalog",
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceInstance: instanceConfig.STORE_INSTANCE_ID,
    panels
  };
}
async function exportStoreCatalog(context) {
  if (!isAdmin(context.member)) return actionReply(context, { content: "So ADM pode exportar a loja.", ephemeral: true });
  const data = storeCatalogExport(actionGuildId(context));
  if (!data.panels.length) return actionReply(context, { content: "Nao encontrei paineis para exportar.", ephemeral: true });
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), "utf8"), {
    name: `catalogo-${instanceConfig.STORE_INSTANCE_ID}-${Date.now()}.json`
  });
  return actionReply(context, {
    content: `Exportei **${data.panels.length} painel(is)**. O arquivo contem somente catalogo e visual; nao leva Pix, equipe, clientes, vendas, carrinhos, tokens ou IDs de canais.`,
    files: [file],
    ephemeral: true
  });
}
async function readCatalogAttachment(attachment) {
  if (!attachment?.url) throw new Error("Envie o arquivo JSON gerado por !exportarloja.");
  if (Number(attachment.size) > 2 * 1024 * 1024) throw new Error("O arquivo passa do limite de 2 MB.");
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Nao consegui baixar o arquivo (HTTP ${response.status}).`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("O arquivo passa do limite de 2 MB.");
  const payload = JSON.parse(text);
  if (payload?.format !== "dragon-store-catalog" || payload?.version !== 1 || !Array.isArray(payload.panels)) {
    throw new Error("Esse nao e um catalogo Dragon Store valido.");
  }
  if (!payload.panels.length || payload.panels.length > 100) throw new Error("Quantidade de paineis invalida no arquivo.");
  return payload;
}
function selectImportedPanel(payload, selector = "") {
  const wanted = plainText(selector).trim();
  if (!wanted && payload.panels.length === 1) return payload.panels[0];
  if (/^\d+$/.test(wanted)) return payload.panels[Number(wanted) - 1] || null;
  if (wanted) return payload.panels.find(panel => plainText(panel.title).trim() === wanted) || null;
  return null;
}
function importedPanelForChannel(source, guildId, channelId) {
  const panel = defaultPanel(guildId, channelId);
  panel.title = clampText(source.title, 256, panel.title);
  panel.description = clampText(source.description, 4096, panel.description);
  panel.color = normColor(source.color);
  panel.imageUrl = validUrl(source.imageUrl) ? String(source.imageUrl || "") : "";
  panel.thumbnailUrl = validUrl(source.thumbnailUrl) ? String(source.thumbnailUrl || "") : "";
  const quick = source.quickOrder && typeof source.quickOrder === "object" ? source.quickOrder : {};
  panel.quickOrder = {
    ...defaultQuickOrder(),
    title: clampText(quick.title, 256, "Compre aqui"),
    description: clampText(quick.description, 4096, defaultQuickOrder().description),
    buttonLabel: clampText(quick.buttonLabel, 80, "Comprar"),
    question1: clampText(quick.question1, 45),
    question2: clampText(quick.question2, 45),
    publishedChannelId: "",
    publishedMessageId: ""
  };
  panel.products = (Array.isArray(source.products) ? source.products : []).slice(0, 250).map(item => ({
    id: `p${random7()}`,
    name: clampText(item?.name, 100, "Produto"),
    price: clampText(item?.price, 40, "R$ 0,00"),
    priceCents: Number.isFinite(Number(item?.priceCents)) ? Number(item.priceCents) : priceCentsFromValue(item?.price),
    description: clampText(item?.description, 1000, "Produto da loja."),
    stock: clampText(item?.stock, 40, "infinito"),
    imageUrl: validUrl(item?.imageUrl) ? String(item.imageUrl || "") : "",
    type: clampText(item?.type, 40, "product"),
    rewards: Array.isArray(item?.rewards) ? cloneJson(item.rewards.slice(0, 100)) : undefined
  }));
  return panel;
}
async function importStoreCatalog(context, attachment, selector = "") {
  if (!isAdmin(context.member)) return actionReply(context, { content: "So ADM pode importar catalogo.", ephemeral: true });
  try {
    const payload = await readCatalogAttachment(attachment);
    const source = selectImportedPanel(payload, selector);
    if (!source) {
      const choices = payload.panels.slice(0, 20).map((panel, index) => `${index + 1}. ${clampText(panel.title, 80, "Sem titulo")}`).join("\n");
      return actionReply(context, {
        content: `Escolha qual painel importar pelo numero ou titulo. Exemplo: \`!importarloja 2\` junto do arquivo.\n\n${choices}`,
        ephemeral: true
      });
    }
    const panel = importedPanelForChannel(source, actionGuildId(context), context.channel.id);
    savePanel(actionGuildId(context), panel, context.channel.id);
    writeAuditLog(context, "store.catalog_imported", { panelId: panel.id, title: panel.title, productCount: panel.products.length });
    await flushPersistentFile(PANELS_FILE);
    await actionReply(context, {
      content: `Painel **${panel.title}** importado neste canal com **${panel.products.length} produto(s)**. Agora abra \`!configds\` para revisar e publicar.`,
      ephemeral: true
    });
    return startConfig(context.channel, context.member, actionUser(context));
  } catch (error) {
    return actionReply(context, { content: `Nao consegui importar: ${error.message}`, ephemeral: true });
  }
}
function serverBackupManager(context) {
  const user = actionUser(context);
  if (!user?.id || !context.guild) return false;
  const configuredCeoId = String(process.env.CEO_USER_ID || "").trim();
  return context.guild.ownerId === user.id || configuredCeoId === user.id;
}
function transientStoreChannelIds(guildId) {
  const db = readOrders();
  return new Set([
    ...Object.values(db.orders || {}).filter(item => item.guildId === guildId).map(item => item.channelId),
    ...Object.values(db.tickets || {}).filter(item => !item.guildId || item.guildId === guildId).map(item => item.channelId)
  ].filter(Boolean));
}
function storeServerBackupSnapshot(guildId) {
  const panelStore = readPanels();
  const guildStore = ensurePanelStore(panelStore, guildId);
  const staff = getStaffGuild(guildId);
  return {
    serverConfig: {
      ...cloneJson(serverConfig(guildId)),
      adminRoleId: adminRoleId(guildId),
      customerRoleId: configuredCustomerRoleId(guildId),
      resellerRoleId: resellerRoleId(guildId),
      resellerDiscountPercent: resellerDiscountPercent(guildId),
      completionChannelId: completionChannelId(guildId),
      cancellationChannelId: cancellationChannelId(guildId),
      reviewChannelId: reviewConfig({ guildId }).channelId,
      ticketPanelChannelId: ticketPanelChannelId(guildId),
      statusVoiceChannelId: statusVoiceChannelId(guildId),
      statusVoiceEnabled: statusVoiceEnabled(guildId),
      revenueChannelId: serverConfig(guildId).revenueChannelId || "",
      revenueListEnabled: Boolean(serverConfig(guildId).revenueListEnabled),
      cartOpenCategoryId: categoryId(guildId, "cartOpen"),
      closedCategoryId: categoryId(guildId, "closed"),
      ticketOpenCategoryId: categoryId(guildId, "ticketOpen")
    },
    staff: {
      panelChannelId: staff.panelChannelId || "",
      successChannelId: staff.successChannelId || "",
      successMessageEnabled: Boolean(staff.successMessageEnabled),
      customerRoleId: staff.customerRoleId || ""
    },
    panels: allPublicPanels(guildStore).map(panel => {
      const quick = quickOrderConfig(panel);
      return {
        ...catalogPanelSnapshot(panel),
        binding: {
          scopeId: panel.scopeId || "",
          channelId: panel.channelId || "",
          publishedChannelId: panel.publishedChannelId || "",
          publishPanel: Boolean(panel.publishedChannelId && panel.publishedMessageId),
          quickPublishedChannelId: quick.publishedChannelId || "",
          publishQuickOrder: Boolean(quick.publishedChannelId && quick.publishedMessageId)
        }
      };
    }),
    assets: {},
    assetWarnings: []
  };
}
async function recoverStorePanelsForBackup(guild) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guild.id);
  const skipPanelIds = new Set(
    allPublicPanels(guildStore)
      .filter(panel => (panel.products || []).length)
      .map(panel => String(panel.id || ""))
      .filter(Boolean)
  );
  const recovered = await scanGuildForPublishedSalePanels(guild, guild.id, true, {
    ignoreDisabled: true,
    allowOtherBotAuthors: true,
    skipPanelIds,
    maxChannels: 250,
    messageLimit: 100
  });
  if (recovered.length) await flushPersistentFile(PANELS_FILE);
  return recovered;
}
function backupAssetExtension(contentType) {
  if (/gif/i.test(contentType)) return "gif";
  if (/webp/i.test(contentType)) return "webp";
  if (/jpe?g/i.test(contentType)) return "jpg";
  return "png";
}
function trustedBackupAssetUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ["discordapp.com", "discordapp.net", "discord.com"].some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}
async function embedStoreBackupAssets(store) {
  const state = { totalBytes: 0, cache: new Map() };
  async function capture(url) {
    const raw = String(url || "").trim();
    if (!raw || !trustedBackupAssetUrl(raw)) return raw;
    if (state.cache.has(raw)) return state.cache.get(raw);
    try {
      const response = await fetch(raw, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "image/png";
      if (!contentType.startsWith("image/")) throw new Error("conteudo nao e imagem");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024 || state.totalBytes + bytes.length > 5 * 1024 * 1024) {
        throw new Error("limite de imagens do arquivo atingido");
      }
      const key = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 20);
      store.assets[key] = {
        contentType,
        name: `asset-${key}.${backupAssetExtension(contentType)}`,
        data: bytes.toString("base64")
      };
      state.totalBytes += bytes.length;
      const reference = `asset://${key}`;
      state.cache.set(raw, reference);
      return reference;
    } catch (error) {
      store.assetWarnings.push(`${raw.slice(0, 120)}: ${error.message}`);
      state.cache.set(raw, raw);
      return raw;
    }
  }

  for (const panel of store.panels || []) {
    panel.imageUrl = await capture(panel.imageUrl);
    panel.thumbnailUrl = await capture(panel.thumbnailUrl);
    for (const productItem of panel.products || []) productItem.imageUrl = await capture(productItem.imageUrl);
  }
  return store;
}
async function createFullServerBackupCommand(context) {
  if (!serverBackupManager(context)) {
    return actionReply(context, { content: "So o dono do servidor ou o CEO configurado pode gerar backup completo.", ephemeral: true });
  }
  let progressMessage = null;
  if (context.isRepliable?.()) await context.deferReply({ ephemeral: true });
  else progressMessage = await context.reply("Preparando backup completo do servidor...").catch(() => null);
  try {
    const recoveredPanels = await recoverStorePanelsForBackup(context.guild);
    const store = await embedStoreBackupAssets(storeServerBackupSnapshot(context.guild.id));
    const user = actionUser(context);
    const transientChannels = transientStoreChannelIds(context.guild.id);
    for (const channel of context.guild.channels.cache.values()) {
      if (/^(carrinho|ticket)-/i.test(channel.name || "")) transientChannels.add(channel.id);
    }
    const payload = await createServerBackup(context.guild, {
      excludedChannelIds: [...transientChannels],
      allowedMemberIds: [user.id],
      store
    });
    payload.ceoHint = { userId: user.id };
    const bytes = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    if (bytes.length > MAX_SERVER_BACKUP_BYTES) throw new Error("O backup passou de 8 MB. Remova imagens muito grandes e tente novamente.");
    const file = new AttachmentBuilder(bytes, { name: `backup-${safeName(context.guild.name)}-${Date.now()}.json` });
    const successPayload = {
      content: [
        `Backup completo de **${context.guild.name}** criado.`,
        `Incluidos: ${payload.roles.length} cargos, ${payload.channels.length} canais, ${payload.emojis.length} emojis, ${payload.stickers.length} stickers e ${(store.panels || []).length} paineis.`,
        recoveredPanels.length ? `${recoveredPanels.length} painel(is) foram recuperados das mensagens publicadas antes do backup.` : "Catalogo lido do armazenamento e das mensagens publicadas.",
        store.panels.length ? "Os produtos desses paineis estao incluidos no arquivo." : "Atencao: nenhum painel de produtos foi encontrado; este arquivo nao contem catalogo.",
        store.assetWarnings.length ? `${store.assetWarnings.length} imagem(ns) ficaram apenas como link por limite/tamanho.` : "Imagens dos paineis foram incorporadas ao arquivo.",
        "Pix, pedidos, vendas, clientes, membros e historico de mensagens nao foram copiados."
      ].join("\n"),
      files: [file],
      ephemeral: true
    };
    if (!context.isRepliable?.()) {
      const sent = await sendSafeDM(user.id, stripEphemeral(successPayload));
      return progressMessage?.edit(sent
        ? "Backup completo enviado no seu privado."
        : "Nao consegui abrir sua DM. Ative mensagens privadas ou use `/backup`, que entrega o arquivo de forma privada.");
    }
    return actionReply(context, successPayload);
  } catch (error) {
    await progressMessage?.delete().catch(() => null);
    return actionReply(context, { content: `Falha ao criar backup: ${error.message}`, ephemeral: true });
  }
}
async function readFullServerBackupAttachment(attachment) {
  if (!attachment?.url) throw new Error("Anexe o arquivo criado por !backup.");
  if (Number(attachment.size) > MAX_SERVER_BACKUP_BYTES) throw new Error("O arquivo passa de 8 MB.");
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Nao consegui baixar o backup (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SERVER_BACKUP_BYTES) throw new Error("O arquivo passa de 8 MB.");
  const payload = JSON.parse(bytes.toString("utf8"));
  return validateServerBackup(payload);
}
function restoreConfirmationRows(sessionId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`serverrestore:confirm:${sessionId}`).setLabel("Restaurar servidor").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`serverrestore:cancel:${sessionId}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
  )];
}
async function startFullServerRestoreCommand(context, attachment) {
  if (!serverBackupManager(context)) {
    return actionReply(context, { content: "So o dono do servidor ou o CEO configurado pode restaurar backup.", ephemeral: true });
  }
  const botMember = context.guild.members.me || await context.guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return actionReply(context, { content: "Para restaurar o servidor inteiro, coloque o cargo do bot com permissao Administrador e acima dos cargos que ele vai gerenciar.", ephemeral: true });
  }
  if (context.isRepliable?.()) await context.deferReply({ ephemeral: true });
  try {
    const payload = await readFullServerBackupAttachment(attachment);
    if (!context.isRepliable?.()) await context.delete().catch(() => null);
    const sessionId = sid();
    const user = actionUser(context);
    serverRestoreSessions.set(sessionId, {
      payload,
      guildId: context.guild.id,
      channelId: context.channel.id,
      userId: user.id,
      expiresAt: Date.now() + SERVER_RESTORE_SESSION_TTL_MS
    });
    return actionReply(context, {
      content: [
        `Backup de **${payload.sourceGuildName || payload.guild?.name || "servidor"}** carregado.`,
        `Serao processados **${payload.roles.length} cargos**, **${payload.channels.length} canais**, **${payload.emojis.length} emojis**, **${payload.stickers.length} stickers** e **${payload.store?.panels?.length || 0} paineis**.`,
        "Nada sera apagado. Estruturas iguais serao reaproveitadas; o restante sera criado.",
        "Confirme somente dentro do servidor novo."
      ].join("\n"),
      components: restoreConfirmationRows(sessionId),
      ephemeral: true
    });
  } catch (error) {
    return actionReply(context, { content: `Backup invalido: ${error.message}`, ephemeral: true });
  }
}
function mappedBackupId(map, value) {
  return value ? (map.get(String(value)) || "") : "";
}
async function restoreEmbeddedStoreAssets(guild, store, ceoUserId) {
  const assets = store?.assets && typeof store.assets === "object" ? store.assets : {};
  const entries = Object.entries(assets);
  if (!entries.length) return store;
  let channel = guild.channels.cache.find(item => item.type === ChannelType.GuildText && item.name === "dragon-assets") || null;
  if (!channel) {
    channel = await guild.channels.create({
      name: "dragon-assets",
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
        ...(ceoUserId ? [{ id: ceoUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }] : [])
      ],
      reason: "Arquivos tecnicos restaurados da Dragon Store"
    });
  }
  const urlMap = new Map();
  for (const [key, asset] of entries) {
    try {
      const file = new AttachmentBuilder(Buffer.from(String(asset.data || ""), "base64"), { name: clampText(asset.name, 100, `asset-${key}.png`) });
      const sent = await channel.send({ content: `Asset tecnico \`${key}\`.`, files: [file] });
      const url = sent.attachments.first()?.url;
      if (url) urlMap.set(`asset://${key}`, url);
    } catch (error) {
      console.log(`Falha ao restaurar asset ${key}: ${error.message}`);
    }
  }
  const restored = cloneJson(store);
  for (const panel of restored.panels || []) {
    panel.imageUrl = urlMap.get(panel.imageUrl) || panel.imageUrl;
    panel.thumbnailUrl = urlMap.get(panel.thumbnailUrl) || panel.thumbnailUrl;
    for (const productItem of panel.products || []) productItem.imageUrl = urlMap.get(productItem.imageUrl) || productItem.imageUrl;
  }
  return restored;
}
async function restoreStoreFromServerBackup(guild, result, ceoUserId) {
  const roleMap = result.roleMap;
  const channelMap = result.channelMap;
  const rawStore = result.payload.store || {};
  const store = await restoreEmbeddedStoreAssets(guild, rawStore, ceoUserId);
  const sourceConfig = store.serverConfig || {};
  const mappedConfig = {
    adminRoleId: result.ceoRoleId || "",
    customerRoleId: mappedBackupId(roleMap, sourceConfig.customerRoleId || store.staff?.customerRoleId),
    resellerRoleId: mappedBackupId(roleMap, sourceConfig.resellerRoleId),
    resellerDiscountPercent: Number(sourceConfig.resellerDiscountPercent ?? 10),
    completionChannelId: mappedBackupId(channelMap, sourceConfig.completionChannelId),
    cancellationChannelId: mappedBackupId(channelMap, sourceConfig.cancellationChannelId),
    reviewChannelId: mappedBackupId(channelMap, sourceConfig.reviewChannelId),
    ticketPanelChannelId: mappedBackupId(channelMap, sourceConfig.ticketPanelChannelId),
    statusVoiceChannelId: mappedBackupId(channelMap, sourceConfig.statusVoiceChannelId),
    statusVoiceEnabled: Boolean(sourceConfig.statusVoiceEnabled),
    revenueChannelId: mappedBackupId(channelMap, sourceConfig.revenueChannelId),
    revenueMessageId: "",
    revenueListEnabled: Boolean(sourceConfig.revenueListEnabled),
    cartOpenCategoryId: mappedBackupId(channelMap, sourceConfig.cartOpenCategoryId),
    closedCategoryId: mappedBackupId(channelMap, sourceConfig.closedCategoryId),
    ticketOpenCategoryId: mappedBackupId(channelMap, sourceConfig.ticketOpenCategoryId)
  };
  const staff = {
    ...defaultStaffGuild(),
    panelChannelId: mappedBackupId(channelMap, store.staff?.panelChannelId),
    successChannelId: mappedBackupId(channelMap, store.staff?.successChannelId),
    successMessageEnabled: Boolean(store.staff?.successMessageEnabled),
    customerRoleId: mappedConfig.customerRoleId,
    serverConfig: mappedConfig
  };
  saveStaffGuild(guild.id, staff);

  let panelsPublished = 0;
  let quickOrdersPublished = 0;
  for (const source of store.panels || []) {
    const binding = source.binding || {};
    const configuredChannelId = mappedBackupId(channelMap, binding.channelId);
    const scopeChannelId = mappedBackupId(channelMap, binding.scopeId);
    const panelChannelId = mappedBackupId(channelMap, binding.publishedChannelId) || configuredChannelId || scopeChannelId;
    const quickChannelId = mappedBackupId(channelMap, binding.quickPublishedChannelId) || configuredChannelId || panelChannelId || scopeChannelId;
    const storageScopeId = scopeChannelId || configuredChannelId || panelChannelId || quickChannelId;
    if (!storageScopeId) continue;
    const panel = importedPanelForChannel(source, guild.id, storageScopeId);
    panel.channelId = configuredChannelId || panelChannelId || quickChannelId;
    if (binding.publishPanel) {
      const channel = panelChannelId ? await guild.channels.fetch(panelChannelId).catch(() => null) : null;
      if (channel?.isTextBased() && channel.type !== ChannelType.GuildForum) {
        const message = await channel.send(saleMessage(panel));
        panel.publishedChannelId = channel.id;
        panel.publishedMessageId = message.id;
        panelsPublished += 1;
      }
    }
    if (binding.publishQuickOrder) {
      const channel = quickChannelId ? await guild.channels.fetch(quickChannelId).catch(() => null) : null;
      if (channel?.isTextBased() && channel.type !== ChannelType.GuildForum) {
        const quickMessage = await channel.send(quickOrderMessage(panel));
        panel.quickOrder = {
          ...quickOrderConfig(panel),
          publishedChannelId: channel.id,
          publishedMessageId: quickMessage.id
        };
        quickOrdersPublished += 1;
      }
    }
    savePanel(guild.id, panel, storageScopeId);
  }

  if (staff.panelChannelId) {
    const channel = await guild.channels.fetch(staff.panelChannelId).catch(() => null);
    if (channel?.isTextBased() && channel.type !== ChannelType.GuildForum) {
      const message = await channel.send({ embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() }).catch(() => null);
      if (message) {
        staff.panelMessageId = message.id;
        saveStaffGuild(guild.id, staff);
      }
    }
  }
  if (mappedConfig.ticketPanelChannelId) {
    const channel = await guild.channels.fetch(mappedConfig.ticketPanelChannelId).catch(() => null);
    if (channel?.isTextBased() && channel.type !== ChannelType.GuildForum) {
      const button = new ButtonBuilder().setCustomId("openticket").setLabel(config.ticketPanel.buttonLabel).setEmoji(config.ticketPanel.buttonEmoji).setStyle(ButtonStyle.Primary);
      await channel.send({ embeds: [ticketPanelEmbed()], components: [new ActionRowBuilder().addComponents(button)] }).catch(() => null);
    }
  }
  await flushPersistentFile(PANELS_FILE);
  await flushPersistentFile(STAFF_FILE);
  await updateRevenueDashboard(guild).catch(() => null);
  await saveStaffBackup(guild, staff.panelChannelId ? await guild.channels.fetch(staff.panelChannelId).catch(() => null) : null).catch(() => null);
  return { panelsPublished, quickOrdersPublished };
}
async function handleServerRestoreButton(interaction) {
  const [, action, sessionId] = interaction.customId.split(":");
  const session = serverRestoreSessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    serverRestoreSessions.delete(sessionId);
    return interaction.reply({ content: "Essa restauracao expirou. Envie o arquivo novamente com !restaurar.", ephemeral: true });
  }
  if (session.userId !== interaction.user.id || session.guildId !== interaction.guildId || !serverBackupManager(interaction)) {
    return interaction.reply({ content: "So quem iniciou a restauracao pode confirmar.", ephemeral: true });
  }
  if (action === "cancel") {
    serverRestoreSessions.delete(sessionId);
    return interaction.update({ content: "Restauracao cancelada. Nenhuma alteracao foi feita.", components: [] });
  }
  serverRestoreSessions.delete(sessionId);
  await interaction.deferUpdate();
  try {
    const ceoUserId = String(process.env.CEO_USER_ID || interaction.user.id).trim();
    const result = await restoreServerBackup(interaction.guild, session.payload, {
      ceoUserId,
      allowedMemberIds: [ceoUserId],
      onProgress: text => interaction.editReply({ content: text, components: [] }).catch(() => null)
    });
    await interaction.editReply({ content: "Estrutura criada. Restaurando configuracoes, imagens e paineis...", components: [] });
    const storeReport = await restoreStoreFromServerBackup(interaction.guild, result, ceoUserId);
    await connectStatusVoiceChannel(interaction.guild).catch(() => null);
    const report = result.report;
    const reportFiles = report.failures.length ? [new AttachmentBuilder(
      Buffer.from(["DRAGON STORE - RELATORIO DE RESTAURACAO", "", ...report.failures.map((item, index) => `${index + 1}. ${item}`)].join("\n"), "utf8"),
      { name: `relatorio-restauracao-${Date.now()}.txt` }
    )] : [];
    return interaction.editReply({
      content: [
        "Restauracao concluida.",
        `Cargos: ${report.rolesCreated} criado(s), ${report.rolesReused} reaproveitado(s).`,
        `Canais: ${report.channelsCreated} criado(s), ${report.channelsReused} reaproveitado(s).`,
        `Emojis: ${report.emojisCreated} criado(s).`,
        `Stickers: ${report.stickersCreated} criado(s).`,
        `Loja: ${storeReport.panelsPublished} painel(is) e ${storeReport.quickOrdersPublished} mensagem(ns) de compra publicados.`,
        `Falhas nao criticas: ${report.failures.length}.`,
        "Configure seu Pix com /configpix e rode /diagnostico antes de abrir a loja."
      ].join("\n"),
      components: [],
      files: reportFiles
    });
  } catch (error) {
    return interaction.editReply({ content: `A restauracao parou por erro: ${error.message}\nO que ja foi criado foi mantido; rode novamente para reaproveitar e continuar.`, components: [] });
  }
}
async function sessionOrReply(interaction, sessionId) {
  const s = sessions.get(sessionId);
  if (!s || Number(s.expiresAt || 0) <= Date.now()) {
    if (s) sessions.delete(sessionId);
    await interaction.reply({ content: "Sessão expirada. Use `!configds` ou `/configds` de novo.", ephemeral: true });
    return null;
  }
  if (interaction.user.id !== s.ownerId) {
    await interaction.reply({ content: "Só quem abriu esta configuração pode usar os controles.", ephemeral: true });
    return null;
  }
  if (interaction.message?.id === s.messageId) {
    s.expiresAt = Date.now() + CONFIG_SESSION_TTL_MS;
    if (interaction.webhook) s.webhook = interaction.webhook;
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
  if (action === "stock") {
    if (!await requireBotOwner(interaction)) return;
    const runtimeError = stockRuntimeError();
    if (runtimeError) return actionReply(interaction, { content: runtimeError, ephemeral: true });
    if (!panel.products.length) return actionReply(interaction, { content: "Cadastre um produto antes de configurar estoque.", ephemeral: true });
    return interaction.reply({ content: "Escolha o produto cujo estoque deseja administrar:", components: [stockProductMenu(sessionId, panel)], ephemeral: true });
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

    recovered.configMessageChannelId = "";
    recovered.configMessageId = "";
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
  const staffRoleId = adminRoleId(guild.id);
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
  ];
  if (staffRoleId) {
    overwrites.splice(2, 0, { id: staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] });
  }
  return guild.channels.create({
    name, type: ChannelType.GuildText, parent,
    permissionOverwrites: overwrites
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
  const ch = await privateChannel(guild, targetUser, `carrinho-${safeName(targetUser.username)}-aberto-${id}`, categoryId(guild.id, "cartOpen") || undefined);
  const order = {
    id,
    paymentFlowVersion: 3,
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
    lastInteractionAt: new Date().toISOString(),
    closedAt: null
  };

  const db = readOrders();
  db.orders[id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);

  await sendCartMessage(ch, order, panel);
  db.orders[id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
  await sendStaffChoiceMessage(ch, order, guild.id);

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
  const addProductHint = isFinishedCart(order)
    ? ""
    : "Quer adicionar outro produto? Use `/addproduto` ou o botão abaixo.";
  const embed = new EmbedBuilder()
    .setTitle(`🛒 Pedido #${order.id}`)
    .setDescription([cartText(order, panel), addProductHint].filter(Boolean).join("\n\n").slice(0, 4096))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Total", value: totalLine(order, panel), inline: true },
      { name: "Status", value: statusLabel, inline: true },
      { name: "Atendimento", value: order.assignedAdminId ? `<@${order.assignedAdminId}>` : "Aguardando ADM", inline: true },
      { name: "Andamento", value: `${paymentStatusLabel(order)} • ${deliveryStatusLabel(order)}`.slice(0, 1024), inline: false }
    )
    .setFooter({ text: `${totals.quantity} item(ns) no pedido` })
    .setTimestamp();

  const discountText = discountLine(order);
  if (discountText) embed.addFields({ name: "Desconto", value: discountText, inline: false });
  if (order.customAnswers) {
    const quick = order.quickOrder || {};
    const answers = [
      `${quick.question1 || "Informação 1"}: ${order.customAnswers.answer1 || "Não informado"}`,
      `${quick.question2 || "Informação 2"}: ${order.customAnswers.answer2 || "Não informado"}`
    ].join("\n");
    embed.addFields({ name: "Informações do pedido", value: answers.slice(0, 1024), inline: false });
  }
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
function cartActionRows(orderOrId) {
  const order = typeof orderOrId === "object" ? orderOrId : { id: orderOrId, status: ORDER_STATUS.OPEN };
  const orderId = order.id;
  const finished = isFinishedCart(order);
  const paid = Boolean(order.paymentStatus === "marked_paid" || order.paidAt);
  const frozen = paymentStarted(order);
  const paymentRecovery = automaticPaymentRecoveryAvailable(order);
  const manualApprovalAllowed = order.paymentFlowVersion < 2 ||
    (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX &&
      (Number(order.paymentFlowVersion || 0) >= 3
        ? order.paymentState === PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW
        : [PAYMENT_STATE.AWAITING_MANUAL_PAYMENT, PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW].includes(order.paymentState)));
  const automaticPayment = [PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX].includes(order.paymentMethod);
  const automaticVerificationAllowed = automaticPayment && Boolean(order.pagBankOrderId || order.mercadoPagoPaymentId);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`addproduct:${orderId}`).setLabel("Adicionar produto").setEmoji("➕").setStyle(ButtonStyle.Primary).setDisabled(finished || frozen),
      new ButtonBuilder().setCustomId(`pay:${orderId}`).setLabel(paymentRecovery ? "Tentar pagamento" : frozen ? "Pagamento gerado" : "Gerar pagamento").setEmoji("💠").setStyle(ButtonStyle.Success).setDisabled(finished || (frozen && !paymentRecovery)),
      new ButtonBuilder().setCustomId(`cancel:${orderId}`).setLabel("Cancelar").setEmoji("✖️").setStyle(ButtonStyle.Danger).setDisabled(finished)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sendpix:${orderId}`).setLabel("Reenviar Pix").setEmoji("💸").setStyle(ButtonStyle.Secondary).setDisabled(finished || !frozen || paymentRecovery),
      new ButtonBuilder().setCustomId(`paid:${orderId}`).setLabel(automaticPayment ? "Verificar pagamento" : "Aprovar pagamento").setEmoji("💵").setStyle(ButtonStyle.Secondary).setDisabled(finished || paid || (!manualApprovalAllowed && !automaticVerificationAllowed)),
      new ButtonBuilder().setCustomId(`deliver:${orderId}`).setLabel("Entregar").setEmoji("📦").setStyle(ButtonStyle.Primary).setDisabled(finished || Boolean(order.deliveredAt)),
      new ButtonBuilder().setCustomId(`finish:${orderId}`).setLabel("Finalizar").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(finished),
      new ButtonBuilder().setCustomId(`rejectpay:${orderId}`).setLabel("Recusar pagamento").setStyle(ButtonStyle.Danger).setDisabled(finished || order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX || order.paymentState !== PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW)
    )
  ];
}
async function sendCartMessage(channel, order, panel) {
  const message = await channel.send({
    content: `<@${order.userId}> seu pedido foi aberto.`,
    embeds: [cartEmbed(order, panel)],
    components: cartActionRows(order),
    allowedMentions: { users: [order.userId] }
  });
  order.cartMessageId = message.id;
  return message;
}
async function refreshCartMessage(guild, order, panel, fallbackChannel = null) {
  if (!guild || !order?.channelId) return false;
  const channel = fallbackChannel?.id === order.channelId
    ? fallbackChannel
    : await guild.channels.fetch(order.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return false;

  let message = order.cartMessageId
    ? await channel.messages.fetch(order.cartMessageId).catch(() => null)
    : null;
  let duplicateSummaries = [];
  if (!message) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      duplicateSummaries = [...recent.values()].filter(candidate =>
        candidate.author?.id === client.user.id && candidate.embeds?.some(embed =>
          [`🛒 Pedido #${order.id}`, `🛒 Carrinho #${order.id}`].includes(String(embed.title || ""))
        )
      );
      message = duplicateSummaries[0] || null;
    }
  }
  if (!message) return false;

  const previousMessageId = order.cartMessageId;
  order.cartMessageId = message.id;
  await message.edit({
    content: "",
    embeds: [cartEmbed(order, panel)],
    components: cartActionRows(order),
    allowedMentions: { parse: [] }
  }).catch(() => null);
  for (const duplicate of duplicateSummaries.filter(candidate => candidate.id !== message.id)) {
    await duplicate.delete().catch(() => null);
  }

  if (previousMessageId !== order.cartMessageId) {
    const db = readOrders();
    if (db.orders?.[order.id]) {
      db.orders[order.id].cartMessageId = order.cartMessageId;
      writeOrders(db);
    }
  }
  return true;
}
async function refreshOpenOrderInterfaces(guild) {
  const db = readOrders();
  let changed = 0;
  for (const order of Object.values(db.orders || {})) {
    if (order.guildId !== guild.id || order.status !== ORDER_STATUS.OPEN) continue;
    try {
      const channel = await guild.channels.fetch(order.channelId).catch(() => null);
      if (!channel?.isTextBased?.()) continue;
      const panel = getOrderPanel(order, guild.id);
      await refreshCartMessage(guild, order, panel, channel).catch(() => null);
      if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX &&
          await refreshManualPaymentMessage(order, channel).catch(() => false)) {
        db.orders[order.id] = order;
        changed += 1;
      }
    } catch (error) {
      console.warn(`Nao consegui atualizar a interface do pedido #${order.id}: ${errorSummary(error).message}`);
    }
  }
  if (changed) {
    writeOrders(db);
    await flushPersistentFile(ORDERS_FILE);
  }
  return changed;
}
function helpFields(name, lines) {
  const fields = [];
  let chunk = [];
  let length = 0;
  for (const line of lines) {
    const extra = line.length + (chunk.length ? 1 : 0);
    if (chunk.length && length + extra > 1000) {
      fields.push({ name: fields.length ? `${name} (continua)` : name, value: chunk.join("\n"), inline: false });
      chunk = [];
      length = 0;
    }
    chunk.push(line);
    length += line.length + (chunk.length > 1 ? 1 : 0);
  }
  if (chunk.length) fields.push({ name: fields.length ? `${name} (continua)` : name, value: chunk.join("\n"), inline: false });
  return fields;
}
function commandHelpEmbed(member) {
  const prefix = config.prefix || "!";
  const admin = isAdmin(member);
  const publicCommands = [
    "`/help` ou `!help` - mostra esta lista.",
    "`/addproduto [pesquisa]` - busca e adiciona produtos ao seu carrinho em uma tela privada.",
    "`/rankinggastos` ou `!rankinggastos` - top 10 publico de quem mais gastou.",
    "`/saldogasto` ou `!saldogasto` - mostra seu saldo gasto em modo privado."
  ];
  const setupCommands = [
    "`/configds` - abre o configurador privado; inclui produtos, imagens, sorteios e estoque secreto.",
    "`/configds2` - cria ou atualiza rapidamente o painel deste canal usando um template privado.",
    "`/configserver` ou `!configserver` - configura canais, cargos e call de status do servidor.",
    "`/setup-loja` ou `!setup-loja` - completa o setup sem substituir o que ja existe.",
    "`/backup` ou `!backup` - gera um clone seguro da estrutura, interface e catalogo.",
    "`/restaurar` ou `!restaurar` - recria o backup completo em outro servidor.",
    "`/exportarloja` ou `!exportarloja` - baixa paineis e produtos sem dados privados.",
    "`/importarloja` ou `!importarloja [painel]` - importa um painel exportado neste canal.",
    "`/setup-atendimento` ou `!atendimento` - cria/atualiza o painel ON/OFF dos ADMs.",
    "`/configpix` ou `!configpix` - BOT_OWNER_IDS configura o Pix manual da loja.",
    "`/togglepagbank` ou `!togglepagbank` - alterna entre PagBank automatico e Pix manual antigo.",
    "`/reconciliarpagbank order_id` - consulta e processa um pagamento PagBank confirmado.",
    "`/reconciliarmercadopago payment_id` - consulta e processa um Pix Mercado Pago confirmado.",
    "`/salvarpix` ou `!salvarpix` - salva backup do Pix e painel de atendimento.",
    "`/setup-ticket` - envia o painel de ticket.",
    "`/setupsucess` ou `!setupsucess` - define feed de vendas concluidas e cargo cliente.",
    "`/setupfaturamento` ou `!setupfaturamento [lista|resumo]` - configura o painel privado de faturamento.",
    "`!verificacao` - envia o painel OAuth2 com botao Verificar.",
    "`!verificados` - mostra quantas pessoas ja concluiram a verificacao.",
    "`!puxarbackup` - adiciona verificados ao servidor reserva usando OAuth2.",
    "`/status-loja` ou `!status-loja` - mostra resumo da loja.",
    "`/pedidos` ou `!pedidos` - lista pedidos abertos e permite assumir o proximo.",
    "`/diagnostico` ou `!diagnostico` - mostra saude do bot, KV, Pix, paineis e carrinhos.",
    "`/testntfy` ou `!testntfy` - envia uma notificacao de teste para o celular."
  ];
  const salesCommands = [
    "`/addcar` - alias administrativo do `/addproduto`.",
    "`!pix` ou `!assumir` - assume o carrinho atual e envia o Pix do ADM.",
    "`/pago`, `/verificarpagamento` ou `!pago` - aprova Pix manual ou consulta o provedor automatico.",
    "`/entregar` ou `!entregar key/link/mensagem` - salva a entrega manual e envia para o cliente.",
    "`!concluircompra` ou `!concluir` - conclui o carrinho atual.",
    "`!cancelarcompra` ou `!cancelar` - cancela e apaga o carrinho atual.",
    "`/avaliacao` ou `!avaliacao` - finaliza carrinho e pede avaliacao.",
    "`/carrinho cliente:@user` ou `!carrinho @user` - abre carrinho manual.",
    "`/caixapix quantidade:5` ou `!caixapix 5` - sorteia Caixa Pix manual.",
    "`/lock` e `/unlock` ou `!lock` e `!unlock` - trava/libera chat atual.",
    "`/ranking-gastos` ou `!ranking-gastos` - ranking admin paginado por periodo.",
    "`/vendas` ou `!vendas` - ranking privado de vendas por ADM.",
    "`/faturamento` ou `!faturamento` - mostra os totais reais de vendas finalizadas.",
    "`/pedido codigo` ou `!pedido codigo` - consulta um pedido gerado pelo site.",
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
    embed.addFields(...helpFields("Admin - Setup", setupCommands), ...helpFields("Admin - Vendas", salesCommands));
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
    .setFooter({ text: "Pedidos abaixo de R$ 1 usam Pix manual; a partir de R$ 1 usam PagBank quando configurado." })
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
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel?.type)) return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect
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
    ["cargo ADM", adminRoleId(guild.id)],
    ["cargo cliente", configuredCustomerRoleId(guild.id)],
    ["cargo premium/revendedor", resellerRoleId(guild.id)]
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
    ["categoria de carrinhos", categoryId(guild.id, "cartOpen")],
    ["categoria de fechados", categoryId(guild.id, "closed")],
    ["categoria de tickets", categoryId(guild.id, "ticketOpen")],
    ["canal do painel de ticket", ticketPanelChannelId(guild.id)],
    ["canal de vendas concluidas", completionChannelId(guild.id)],
    ["canal de cancelamentos", cancellationChannelId(guild.id)],
    ["canal de avaliacoes", reviewConfig({ guildId: guild.id }).channelId],
    ["call de status", statusVoiceChannelId(guild.id)],
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
  cleanupEphemeralState();
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
  const automaticStockProducts = panels.reduce((sum, panel) => sum + (panel.products || []).filter(item => item.stockMode === STOCK_MODE.AUTOMATIC).length, 0);
  const publishedCount = panels.filter(panel => panel.publishedChannelId && panel.publishedMessageId).length;
  const staffWithPix = staffProfiles.filter(profile => profile.pixKey).length;
  const onlineStaff = staffProfiles.filter(profile => profile.online && profile.pixKey).length;
  const auditCount = (ordersDb.auditLogs || []).filter(entry => !entry.guildId || entry.guildId === guildId).length;
  const warnings = [];

  if (!postgresEnabled()) warnings.push("DATABASE_URL ausente: finalizacao transacional, auditoria relacional e ranking em banco ficam limitados ao JSON/KV.");
  if (!kvEnabled() && !postgresEnabled()) warnings.push("KV/Postgres nao configurados: deploy pode perder JSON local em host read-only.");
  if (!process.env.PUBLIC_STORE_API_TOKEN?.trim()) warnings.push("PUBLIC_STORE_API_TOKEN ausente: pedidos e analytics do site ficam bloqueados.");
  if (!botOwnerIds().size) warnings.push("BOT_OWNER_IDS ausente: aprovacao manual, Pix e estoque ficam bloqueados por seguranca.");
  if (!pagBankReady()) warnings.push("PagBank incompleto: configure PAGBANK_TOKEN, PAGBANK_ENV e PAGBANK_WEBHOOK_URL.");
  if (automaticPaymentProvider(guildId) === "mercadopago" && !mercadoPagoReady()) warnings.push("Mercado Pago incompleto: configure MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_URL.");
  if (automaticStockProducts && stockRuntimeError()) warnings.push(`Estoque automatico indisponivel: ${stockRuntimeError()}`);
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
  const temporary = ephemeralStateStats();

  return new EmbedBuilder()
    .setTitle("Diagnostico Dragon Store")
    .setColor(warnings.length ? 0xf1c40f : 0x28f6a1)
    .addFields(
      { name: "Persistencia", value: persistenceLine, inline: true },
      { name: "Paineis", value: `${panels.length} painel(is)\n${productsCount} produto(s)\n${publishedCount} publicado(s)`, inline: true },
      { name: "Carrinhos", value: `${openOrders.length} aberto(s)\n${processingOrders.length} processando\n${closedOrders.length} fechado(s)\n${cancelledOrders.length} cancelado(s)`, inline: true },
      { name: "Atendimento", value: `${staffWithPix} ADM(s) com Pix\n${onlineStaff} ADM(s) ON\nPainel: ${staffPanelLine}`, inline: false },
      { name: "Auditoria", value: `${auditCount} evento(s) recentes salvos`, inline: true },
      { name: "Pagamentos", value: `Provedor: ${automaticPaymentProvider(guildId)}\nPagBank: ${pagBankReady() ? "pronto" : "incompleto"}\nMercado Pago: ${mercadoPagoReady() ? "pronto" : "incompleto"}\nOwners: ${botOwnerIds().size}\nEstoque automatico: ${automaticStockProducts} produto(s)`, inline: true },
      {
        name: "Estado temporario",
        value: `${temporary.configSessions} config | ${temporary.addCartSessions} addcar | ${temporary.imageUploads + temporary.paymentProofUploads} upload(s) | ${temporary.actionLocks} trava(s)`,
        inline: true
      },
      { name: "Site/API", value: `Token de escrita: ${process.env.PUBLIC_STORE_API_TOKEN?.trim() ? "configurado" : "faltando"}\nCatalogo publico: ativo\nScan paineis: ${process.env.PUBLIC_STORE_SCAN_CHANNELS === "false" ? "manual" : "ativo"}\nInvite: ${publicDiscordInviteUrl(process.env.DISCORD_INVITE_URL)}`, inline: false },
      { name: "Alertas", value: warningLine.slice(0, 1024), inline: false }
    )
    .setFooter({ text: "Use /configpix para o Pix manual e /configds > Estoque secreto para entrega automatica." })
    .setTimestamp();
}
async function sendDiagnosticsCommand(context) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode ver diagnostico do bot.", ephemeral: true });
  }
  const embed = await buildDiagnosticsEmbed(context.guild);
  if (isAuthorizedOwner(actionUser(context)?.id)) {
    let currentConfig;
    try {
      currentConfig = pagBankConfig();
    } catch {
      currentConfig = { environment: String(process.env.PAGBANK_ENV || "invalido").trim(), baseUrl: "https://invalid.local", token: "" };
    }
    const diagnostic = lastPagBankDiagnostic || {
      environment: currentConfig.environment,
      host: new URL(currentConfig.baseUrl).host,
      tokenPresent: Boolean(currentConfig.token),
      tokenLength: currentConfig.token.length,
      endpoint: `${currentConfig.baseUrl}/orders`,
      status: 0,
      errors: [],
      orderId: ""
    };
    const errors = diagnostic.errors.map(item => [
      `Codigo: ${item.code || "n/a"}`,
      `Parametro: ${item.parameterName || "n/a"}`,
      `Descricao: ${item.description || "n/a"}`
    ].join(" | ")).join("\n") || "Nenhuma resposta de erro registrada neste processo.";
    embed.addFields({
      name: "Ultima requisicao PagBank (somente owner)",
      value: [
        `Ambiente: ${diagnostic.environment}`,
        `Host: ${diagnostic.host}`,
        `Token presente: ${diagnostic.tokenPresent ? "sim" : "nao"} (${diagnostic.tokenLength} caracteres)`,
        `Endpoint: ${diagnostic.endpoint}`,
        `HTTP: ${diagnostic.status || "n/a"}`,
        `Pedido: ${diagnostic.orderId || "n/a"}`,
        errors
      ].filter(Boolean).join("\n").slice(0, 1024),
      inline: false
    });
  }
  return actionReply(context, { embeds: [embed], ephemeral: true });
}
async function togglePagBankCommand(context) {
  if (!await requireBotOwner(context, "Somente BOT_OWNER_IDS pode alterar o modo de pagamento.")) return;
  const guildId = actionGuildId(context);
  await ensureStaffState(context.guild, context.channel).catch(() => null);
  const enabled = !pagBankAutomaticEnabled(guildId);
  saveServerConfig(guildId, { pagBankAutomaticEnabled: enabled });
  writeAuditLog(context, "server.pagbank_toggled", { enabled });
  const description = enabled
    ? "Pix automatico PagBank **ligado**. Pedidos de R$ 1,00 ou mais pedirao os dados obrigatorios e gerarao QR Code automatico."
    : "Pix automatico PagBank **desligado**. Todos os pedidos usarao o Pix manual antigo do ADM, sem formulario PagBank.";
  return actionReply(context, { content: description, ephemeral: true });
}
async function configurePaymentProvider(context, provider) {
  if (!await requireBotOwner(context, "Somente BOT_OWNER_IDS pode alterar o provedor.")) return;
  const selected = ["manual", "pagbank", "mercadopago"].includes(provider) ? provider : "manual";
  saveServerConfig(actionGuildId(context), { paymentProvider: selected, pagBankAutomaticEnabled: selected === "pagbank" });
  writeAuditLog(context, "server.payment_provider_changed", { provider: selected });
  return actionReply(context, { content: `Provedor para novos pagamentos: **${selected === "mercadopago" ? "Mercado Pago" : selected === "pagbank" ? "PagBank" : "Pix manual"}**.`, ephemeral: true });
}
function automaticSetupCurrent(guildId) {
  const staff = getStaffGuild(guildId);
  const savedStoreCategoryId = serverConfig(guildId).storeCategoryId || "";
  const inferredStoreCategoryId = [
    staff.panelChannelId,
    completionChannelId(guildId),
    reviewConfig({ guildId }).channelId,
    ticketPanelChannelId(guildId)
  ].map(channelId => client.channels.cache.get(channelId)?.parentId).find(Boolean) || "";
  return {
    adminRoleId: adminRoleId(guildId),
    customerRoleId: configuredCustomerRoleId(guildId),
    resellerRoleId: resellerRoleId(guildId),
    cartOpenCategoryId: categoryId(guildId, "cartOpen"),
    closedCategoryId: categoryId(guildId, "closed"),
    ticketOpenCategoryId: categoryId(guildId, "ticketOpen"),
    storeCategoryId: savedStoreCategoryId || inferredStoreCategoryId,
    staffPanelChannelId: staff.panelChannelId || "",
    completionChannelId: completionChannelId(guildId),
    reviewChannelId: reviewConfig({ guildId }).channelId,
    cancellationChannelId: cancellationChannelId(guildId),
    ticketPanelChannelId: ticketPanelChannelId(guildId),
    statusVoiceChannelId: statusVoiceChannelId(guildId)
  };
}
function automaticSetupRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`autosetup:confirm:${userId}`).setLabel("Criar apenas o que falta").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`autosetup:cancel:${userId}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
  )];
}
async function showAutomaticSetup(context) {
  if (!serverBackupManager(context)) {
    return actionReply(context, { content: "So o dono do servidor ou o CEO configurado pode abrir o setup automatico.", ephemeral: true });
  }
  await Promise.all([context.guild.roles.fetch(), context.guild.channels.fetch()]);
  const summary = currentSetupSummary(context.guild, automaticSetupCurrent(context.guild.id));
  const ready = summary.filter(item => item.ready).length;
  const lines = summary.map(item => `${item.ready ? "OK" : "FALTA"} - ${item.label}${item.id ? `: \`${item.id}\`` : ""}`);
  const embed = new EmbedBuilder()
    .setTitle("Setup seguro da loja")
    .setDescription([
      `Prontidao atual: **${ready}/${summary.length}** itens principais.`,
      "O assistente reaproveita IDs validos e nomes existentes. Ele nao apaga, renomeia ou substitui produtos, Pix, pedidos e paineis publicados."
    ].join("\n\n"))
    .setColor(ready === summary.length ? 0x57f287 : 0xfee75c)
    .addFields({ name: "Checklist", value: lines.join("\n").slice(0, 1024), inline: false })
    .setFooter({ text: `Instancia ${instanceConfig.STORE_INSTANCE_ID} | Operacao idempotente` })
    .setTimestamp();
  return actionReply(context, {
    embeds: [embed],
    components: automaticSetupRows(actionUser(context).id),
    ephemeral: true
  });
}
function isTicketPanelMessage(message) {
  return message?.author?.id === client.user?.id && message.components?.some(row =>
    row.components?.some(component => componentCustomId(component) === "openticket")
  );
}
async function ensureAutomaticStaffPanel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return null;
  const staff = getStaffGuild(guild.id);
  let message = await recoverStaffPanelMessage(guild, channel, staff);
  const payload = { embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() };
  if (message) await message.edit(payload);
  else message = await channel.send(payload);
  staff.panelChannelId = channel.id;
  staff.panelMessageId = message.id;
  saveStaffGuild(guild.id, staff);
  return message;
}
async function ensureAutomaticTicketPanel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.type === ChannelType.GuildForum) return null;
  let message = await findBotMessage(channel, isTicketPanelMessage);
  const button = new ButtonBuilder()
    .setCustomId("openticket")
    .setLabel(config.ticketPanel.buttonLabel)
    .setEmoji(config.ticketPanel.buttonEmoji)
    .setStyle(ButtonStyle.Primary);
  const payload = { embeds: [ticketPanelEmbed()], components: [new ActionRowBuilder().addComponents(button)] };
  if (message) await message.edit(payload);
  else message = await channel.send(payload);
  return message;
}
async function handleAutomaticSetupButton(interaction) {
  const [, action, ownerId] = interaction.customId.split(":");
  if (interaction.user.id !== ownerId || !serverBackupManager(interaction)) {
    return interaction.reply({ content: "So quem abriu o setup pode confirmar.", ephemeral: true });
  }
  if (action === "cancel") return interaction.update({ content: "Setup cancelado. Nada foi alterado.", embeds: [], components: [] });
  await interaction.deferUpdate();
  try {
    const current = automaticSetupCurrent(interaction.guildId);
    const result = await provisionStoreSetup(interaction.guild, current, {
      ceoUserId: String(process.env.CEO_USER_ID || interaction.user.id),
      botUserId: client.user.id,
      onProgress: text => interaction.editReply({ content: text, embeds: [], components: [] }).catch(() => null)
    });
    saveServerConfig(interaction.guildId, {
      ...result.roles,
      ...result.categories,
      completionChannelId: result.channels.completionChannelId,
      reviewChannelId: result.channels.reviewChannelId,
      cancellationChannelId: result.channels.cancellationChannelId,
      ticketPanelChannelId: result.channels.ticketPanelChannelId,
      statusVoiceChannelId: result.channels.statusVoiceChannelId,
      statusVoiceEnabled: true,
      resellerDiscountPercent: resellerDiscountPercent(interaction.guildId)
    });
    const staff = getStaffGuild(interaction.guildId);
    staff.panelChannelId = result.channels.staffPanelChannelId;
    staff.customerRoleId = result.roles.customerRoleId;
    saveStaffGuild(interaction.guildId, staff);
    await ensureAutomaticStaffPanel(interaction.guild, result.channels.staffPanelChannelId);
    await ensureAutomaticTicketPanel(interaction.guild, result.channels.ticketPanelChannelId);
    const panelStore = readPanels();
    const guildStore = ensurePanelStore(panelStore, interaction.guildId);
    if (!allPublicPanels(guildStore).some(panel => (panel.products || []).length)) {
      const productsChannel = await interaction.guild.channels.fetch(result.channels.productsChannelId).catch(() => null);
      if (productsChannel?.isTextBased()) await startConfig(productsChannel, interaction.member, interaction.user);
    }
    await flushPersistentFile(STAFF_FILE);
    await connectStatusVoiceChannel(interaction.guild).catch(() => null);
    await saveStaffBackup(interaction.guild, await interaction.guild.channels.fetch(result.channels.staffPanelChannelId).catch(() => null)).catch(() => null);
    writeAuditLog(interaction, "server.automatic_setup", { created: result.report.created, reused: result.report.reused });
    return interaction.editReply({
      content: [
        "Setup concluido sem substituir configuracoes validas.",
        `Criados: **${result.report.created.length}** | Reaproveitados: **${result.report.reused.length}**.`,
        `Produtos: <#${result.channels.productsChannelId}> | Atendimento: <#${result.channels.staffPanelChannelId}>.`,
        "Agora use /configpix e /diagnostico."
      ].join("\n"),
      embeds: [],
      components: []
    });
  } catch (error) {
    return interaction.editReply({
      content: `O setup parou em: ${error.message}\nO que ja estava certo foi mantido. Corrija a permissao indicada e execute novamente.`,
      embeds: [],
      components: []
    });
  }
}
function boolText(value) {
  return value ? "Ligado" : "Desligado";
}
function parseBooleanConfig(value, fallback = true) {
  const text = plainText(value).trim();
  if (!text) return fallback;
  if (["1", "sim", "s", "true", "on", "ligado", "ativo", "ativado"].includes(text)) return true;
  if (["0", "nao", "n", "false", "off", "desligado", "inativo", "desativado"].includes(text)) return false;
  return fallback;
}
function roleMentionOrId(roleId) {
  return roleId ? `<@&${roleId}>` : "Nao configurado";
}
function channelMentionOrId(channelId) {
  return channelId ? `<#${channelId}>` : "Nao configurado";
}
function serverConfigEmbed(guild) {
  const guildId = guild?.id || "";
  const statusChannelId = statusVoiceChannelId(guildId);
  const completionId = completionChannelId(guildId);
  const cancellationId = cancellationChannelId(guildId);
  const review = reviewConfig({ guildId });
  const customerRole = configuredCustomerRoleId(guildId);
  const resellerRole = resellerRoleId(guildId);
  const resellerDiscount = resellerDiscountPercent(guildId);
  const staffRole = adminRoleId(guildId);

  return new EmbedBuilder()
    .setTitle("Config do servidor")
    .setColor(0x28f6a1)
    .addFields(
      {
        name: "Call de status",
        value: `Status: **${boolText(statusVoiceEnabled(guildId))}**\nCanal: ${channelMentionOrId(statusChannelId)}`,
        inline: false
      },
      {
        name: "Canais",
        value: [
          `Vendas concluidas: ${channelMentionOrId(completionId)}`,
          `Cancelamentos: ${channelMentionOrId(cancellationId)}`,
          `Avaliacoes: ${channelMentionOrId(review.channelId)}`,
          `Painel de suporte: ${channelMentionOrId(ticketPanelChannelId(guildId))}`,
          `Faturamento: ${channelMentionOrId(serverConfig(guildId).revenueChannelId)}`
        ].join("\n"),
        inline: false
      },
      {
        name: "Cargos e desconto",
        value: [
          `ADM: ${roleMentionOrId(staffRole)}`,
          `Cliente: ${roleMentionOrId(customerRole)}`,
          `Premium/revendedor: ${roleMentionOrId(resellerRole)}`,
          `Desconto premium: **${resellerDiscount}%**`
        ].join("\n"),
        inline: false
      },
      {
        name: "Categorias",
        value: [
          `Carrinhos: ${channelMentionOrId(categoryId(guildId, "cartOpen"))}`,
          `Fechados: ${channelMentionOrId(categoryId(guildId, "closed"))}`,
          `Tickets: ${channelMentionOrId(categoryId(guildId, "ticketOpen"))}`
        ].join("\n"),
        inline: false
      }
    )
    .setFooter({ text: `Instancia: ${instanceConfig.STORE_INSTANCE_ID} | Config salva no storage isolado.` })
    .setTimestamp();
}
function serverConfigRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("cfgsrv:call")
        .setLabel("Call")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("cfgsrv:channels")
        .setLabel("Canais")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("cfgsrv:roles")
        .setLabel("Cargos")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("cfgsrv:categories")
        .setLabel("Categorias")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("cfgsrv:reconnect")
        .setLabel("Reconectar call")
        .setStyle(ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("cfgsrv:refresh")
        .setLabel("Atualizar")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}
function serverConfigCallModal(guildId) {
  return new ModalBuilder()
    .setCustomId("cfgsrvmodal:call")
    .setTitle("Configurar call")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("statusVoiceChannelId")
          .setLabel("ID da call de status")
          .setPlaceholder("1515799363857809494")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(statusVoiceChannelId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("statusVoiceEnabled")
          .setLabel("Ligado? sim/nao")
          .setPlaceholder("sim")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(20)
          .setRequired(false)
          .setValue(statusVoiceEnabled(guildId) ? "sim" : "nao")
      )
    );
}
function serverConfigChannelsModal(guildId) {
  return new ModalBuilder()
    .setCustomId("cfgsrvmodal:channels")
    .setTitle("Configurar canais")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("completionChannelId")
          .setLabel("Canal de vendas concluidas")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(completionChannelId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("cancellationChannelId")
          .setLabel("Canal de cancelamentos")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(cancellationChannelId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reviewChannelId")
          .setLabel("Canal de avaliacoes")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(reviewConfig({ guildId }).channelId.slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticketPanelChannelId")
          .setLabel("Canal do painel de suporte")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(ticketPanelChannelId(guildId).slice(0, 30))
      )
    );
}
function serverConfigRolesModal(guildId) {
  return new ModalBuilder()
    .setCustomId("cfgsrvmodal:roles")
    .setTitle("Configurar cargos")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("adminRoleId")
          .setLabel("Cargo ADM")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(adminRoleId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("customerRoleId")
          .setLabel("Cargo cliente")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(configuredCustomerRoleId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("resellerRoleId")
          .setLabel("Cargo premium/revendedor")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(resellerRoleId(guildId).slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("resellerDiscountPercent")
          .setLabel("Desconto premium em porcentagem")
          .setPlaceholder("10")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(10)
          .setRequired(false)
          .setValue(String(resellerDiscountPercent(guildId)))
      )
    );
}
function serverConfigCategoriesModal(guildId) {
  return new ModalBuilder()
    .setCustomId("cfgsrvmodal:categories")
    .setTitle("Configurar categorias")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("cartOpenCategoryId")
          .setLabel("Categoria de carrinhos")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(categoryId(guildId, "cartOpen").slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("closedCategoryId")
          .setLabel("Categoria de finalizados")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(categoryId(guildId, "closed").slice(0, 30))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticketOpenCategoryId")
          .setLabel("Categoria de tickets")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(false)
          .setValue(categoryId(guildId, "ticketOpen").slice(0, 30))
      )
    );
}
async function showServerConfig(context) {
  if (!isAdmin(context.member)) {
    return actionReply(context, { content: "So ADM pode configurar o servidor.", ephemeral: true });
  }
  await ensureStaffState(context.guild, context.channel).catch(() => null);
  return actionReply(context, {
    embeds: [serverConfigEmbed(context.guild)],
    components: serverConfigRows(),
    ephemeral: true
  });
}
async function handleServerConfigButton(interaction) {
  if (!await requireAdminInteraction(interaction, "So ADM pode configurar o servidor.")) return;
  await ensureStaffState(interaction.guild, interaction.channel).catch(() => null);
  const [, action] = interaction.customId.split(":");
  if (action === "call") return interaction.showModal(serverConfigCallModal(interaction.guildId));
  if (action === "channels") return interaction.showModal(serverConfigChannelsModal(interaction.guildId));
  if (action === "roles") return interaction.showModal(serverConfigRolesModal(interaction.guildId));
  if (action === "categories") return interaction.showModal(serverConfigCategoriesModal(interaction.guildId));
  if (action === "reconnect") {
    await disconnectStatusVoiceChannel(interaction.guildId);
    await connectStatusVoiceChannel(interaction.guild).catch(error => {
      console.log(`Falha ao reconectar call via configserver: ${error.message}`);
    });
    return interaction.reply({
      content: `Tentei reconectar na call ${channelMentionOrId(statusVoiceChannelId(interaction.guildId))}.`,
      embeds: [serverConfigEmbed(interaction.guild)],
      components: serverConfigRows(),
      ephemeral: true
    });
  }
  if (action === "refresh") {
    return interaction.update({
      embeds: [serverConfigEmbed(interaction.guild)],
      components: serverConfigRows()
    });
  }
}
async function validateConfiguredChannel(guild, channelId, types, label) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return `${label} (${channelId}) nao existe ou o bot nao consegue ver.`;
  if (types?.length && !types.includes(channel.type)) return `${label} precisa ser do tipo correto.`;
  return null;
}
async function persistServerConfigStorage(interaction) {
  await flushPersistentFile(STAFF_FILE).catch(error => {
    console.log(`Nao consegui confirmar configserver no storage: ${error.message}`);
  });
  await saveStaffBackup(interaction.guild, interaction.channel).catch(error => {
    console.log(`Nao consegui salvar backup do configserver: ${error.message}`);
  });
}
function sanitizeOptionalId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalizeChannelId(raw);
}
function sanitizeOptionalRoleId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.match(/\d{15,25}/)?.[0] || "";
}
async function handleServerConfigModal(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "So ADM pode configurar o servidor.", ephemeral: true });
  }
  const [, section] = interaction.customId.split(":");
  await ensureStaffState(interaction.guild, interaction.channel).catch(() => null);

  if (section === "call") {
    const channelId = sanitizeOptionalId(interaction.fields.getTextInputValue("statusVoiceChannelId"));
    const enabled = parseBooleanConfig(interaction.fields.getTextInputValue("statusVoiceEnabled"), statusVoiceEnabled(interaction.guildId));
    if (interaction.fields.getTextInputValue("statusVoiceChannelId").trim() && !channelId) {
      return interaction.reply({ content: "ID da call invalido.", ephemeral: true });
    }
    const channelError = await validateConfiguredChannel(interaction.guild, channelId, [ChannelType.GuildVoice, ChannelType.GuildStageVoice], "Call de status");
    if (channelError) return interaction.reply({ content: channelError, ephemeral: true });
    saveServerConfig(interaction.guildId, { statusVoiceChannelId: channelId, statusVoiceEnabled: enabled });
    await persistServerConfigStorage(interaction);
    if (enabled) await connectStatusVoiceChannel(interaction.guild).catch(error => console.log(`Falha ao entrar na call configurada: ${error.message}`));
    else await disconnectStatusVoiceChannel(interaction.guildId);
  }

  if (section === "channels") {
    const completionId = sanitizeOptionalId(interaction.fields.getTextInputValue("completionChannelId"));
    const cancellationId = sanitizeOptionalId(interaction.fields.getTextInputValue("cancellationChannelId"));
    const reviewId = sanitizeOptionalId(interaction.fields.getTextInputValue("reviewChannelId"));
    const ticketPanelId = sanitizeOptionalId(interaction.fields.getTextInputValue("ticketPanelChannelId"));
    for (const [label, channelId] of [
      ["Canal de vendas concluidas", completionId],
      ["Canal de cancelamentos", cancellationId],
      ["Canal de avaliacoes", reviewId],
      ["Canal do painel de suporte", ticketPanelId]
    ]) {
      const error = await validateConfiguredChannel(interaction.guild, channelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement], label);
      if (error) return interaction.reply({ content: error, ephemeral: true });
    }
    saveServerConfig(interaction.guildId, {
      completionChannelId: completionId,
      cancellationChannelId: cancellationId,
      reviewChannelId: reviewId,
      ticketPanelChannelId: ticketPanelId
    });
    await persistServerConfigStorage(interaction);
  }

  if (section === "roles") {
    const admin = sanitizeOptionalRoleId(interaction.fields.getTextInputValue("adminRoleId"));
    const customerRoleId = sanitizeOptionalRoleId(interaction.fields.getTextInputValue("customerRoleId"));
    const reseller = sanitizeOptionalRoleId(interaction.fields.getTextInputValue("resellerRoleId"));
    const discountRaw = interaction.fields.getTextInputValue("resellerDiscountPercent").replace(",", ".");
    const discount = Number.parseFloat(discountRaw);
    if (interaction.fields.getTextInputValue("adminRoleId").trim() && !admin) return interaction.reply({ content: "ID do cargo ADM invalido.", ephemeral: true });
    if (interaction.fields.getTextInputValue("customerRoleId").trim() && !customerRoleId) return interaction.reply({ content: "ID do cargo cliente invalido.", ephemeral: true });
    if (interaction.fields.getTextInputValue("resellerRoleId").trim() && !reseller) return interaction.reply({ content: "ID do cargo premium/revendedor invalido.", ephemeral: true });
    if (!Number.isFinite(discount) || discount < 0 || discount > 90) return interaction.reply({ content: "Desconto invalido. Use um numero de 0 a 90.", ephemeral: true });
    saveServerConfig(interaction.guildId, {
      adminRoleId: admin,
      customerRoleId,
      resellerRoleId: reseller,
      resellerDiscountPercent: discount
    });
    await persistServerConfigStorage(interaction);
  }

  if (section === "categories") {
    const values = {
      cartOpenCategoryId: sanitizeOptionalId(interaction.fields.getTextInputValue("cartOpenCategoryId")),
      closedCategoryId: sanitizeOptionalId(interaction.fields.getTextInputValue("closedCategoryId")),
      ticketOpenCategoryId: sanitizeOptionalId(interaction.fields.getTextInputValue("ticketOpenCategoryId"))
    };
    for (const [field, label] of [
      ["cartOpenCategoryId", "Categoria de carrinhos"],
      ["closedCategoryId", "Categoria de finalizados"],
      ["ticketOpenCategoryId", "Categoria de tickets"]
    ]) {
      const raw = interaction.fields.getTextInputValue(field).trim();
      if (raw && !values[field]) return interaction.reply({ content: `${label}: ID invalido.`, ephemeral: true });
      const error = await validateConfiguredChannel(interaction.guild, values[field], [ChannelType.GuildCategory], label);
      if (error) return interaction.reply({ content: error, ephemeral: true });
    }
    saveServerConfig(interaction.guildId, values);
    await persistServerConfigStorage(interaction);
  }

  writeAuditLog(interaction, "server.config_updated", { section, serverConfig: serverConfig(interaction.guildId) });
  return interaction.reply({
    content: "Config do servidor salva.",
    embeds: [serverConfigEmbed(interaction.guild)],
    components: serverConfigRows(),
    ephemeral: true
  });
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
  if (!await automaticProductHasStock(interaction.guildId, panel, p, 1)) return actionReply(interaction, { content: "Este produto esta indisponivel no momento.", ephemeral: true });
  await resetSelectMessage(interaction, saleMessage(panel));
  const discount = discountForMember(interaction.member);
  const id = orderId("order");
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, categoryId(interaction.guildId, "cartOpen") || undefined);
  const order = {
    id,
    paymentFlowVersion: 3,
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
    lastInteractionAt: new Date().toISOString(),
    closedAt: null
  };
  const db = readOrders(); db.orders[id] = order; writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
  await sendCartMessage(ch, order, panel);
  db.orders[id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
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
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, categoryId(interaction.guildId, "cartOpen") || undefined);
  const order = {
    id,
    paymentFlowVersion: 3,
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
    lastInteractionAt: new Date().toISOString(),
    closedAt: null
  };

  const db = readOrders();
  db.orders[id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);

  await sendCartMessage(ch, order, panel);
  db.orders[id] = order;
  writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
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
  if (paymentStarted(order)) return actionReply(interaction, { content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Você não pode alterar esse carrinho.", ephemeral: true });
  const panel = getOrderPanel(order, actionGuildId(interaction)); const p = product(panel, interaction.values[0]);
  if (!p) return actionReply(interaction, { content: "Produto não encontrado.", ephemeral: true });
  if (!productHasStock(p, 1)) return actionReply(interaction, { content: stockUnavailableMessage(p, 1), ephemeral: true });
  await resetSelectMessage(interaction, { components: [productSelect(panel, `cartadd:${order.id}`), ...cartActionRows(order)] });
  const item = order.items.find(i => i.productId === p.id);
  if (item) item.quantity += 1; else order.items.push(orderItemFromProduct(p));
  touchOrder(order);
  appendAuditLog(db, interaction, "order.item_added", { order, productId: p.id, productName: p.name, quantity: 1, source: "cart_select" });
  db.orders[order.id] = order; writeOrders(db);
  persistOrderRelationalAsync(db, order, panel);
  await refreshCartMessage(interaction.guild, order, panel, interaction.channel);
  await actionReply(interaction, { content: `Adicionado: ${productIcon(p)} **${p.name}** — ${p.price}`, ephemeral: true });
  return null;
}
function canEditOrder(member, userId, order) {
  return Boolean(order && (userId === order.userId || isAdmin(member)));
}
function rememberAddCartSession(session) {
  session.expiresAt = Date.now() + ADD_CART_SESSION_TTL_MS;
  addCartSessions.set(session.id, session);
  return session;
}
function getAddCartSession(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const session = addCartSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) addCartSessions.delete(sessionId);
    return null;
  }
  if (interaction.message?.id === session.messageId && interaction.webhook) session.webhook = interaction.webhook;
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
    const availability = p.stockMode === STOCK_MODE.AUTOMATIC ? "Disponibilidade automatica" : `Estoque: ${p.stock || "infinito"}`;
    return `\`${index + 1}.\` ${productIcon(p)} **${p.name || "Produto"}** - ${p.price || "valor a combinar"} | ${entry.panelTitle} | ${availability}`;
  });
  if (matches.length > 15) lines.push(`...mais ${matches.length - 15} produto(s). Use **Pesquisar** para filtrar.`);
  return lines.join("\n");
}
function addCartOptionDescription(entry) {
  const p = entry.product || {};
  return [
    String(p.price || "valor a combinar"),
    String(entry.panelTitle || "Painel"),
    p.stockMode === STOCK_MODE.AUTOMATIC ? "Disponibilidade automatica" : `Estoque: ${String(p.stock || "infinito")}`
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
  if (session.ephemeral && session.webhook && session.messageId) {
    await session.webhook.editMessage(session.messageId, addCartPanelPayload(session, order, panel)).catch(() => null);
    return true;
  }
  const channel = context.channel;
  if (!channel?.messages?.fetch || !session.messageId) return false;
  const message = await channel.messages.fetch(session.messageId).catch(() => null);
  if (!message) return false;
  await message.edit(addCartPanelPayload(session, order, panel)).catch(() => null);
  return true;
}
async function startAddCartFlow(context, initialQuery = "", options = {}) {
  const isInteraction = Boolean(context.isRepliable?.());
  if (isInteraction && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }

  const db = readOrders();
  const order = findOrderInChannel(db, context, true);
  const user = actionUser(context);
  if (!order) {
    return actionReply(context, { content: "Nao encontrei carrinho aberto neste chat. Use dentro do canal do carrinho.", ephemeral: true });
  }
  if (paymentStarted(order)) return actionReply(context, { content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
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
    catalog,
    ephemeral: isInteraction,
    webhook: isInteraction ? context.webhook : null
  });
  const sent = isInteraction
    ? await context.editReply(addCartPanelPayload(session, order, panel))
    : await context.channel.send(addCartPanelPayload(session, order, panel));
  session.messageId = sent.id;
  addCartSessions.set(session.id, session);
  if (isInteraction || options.confirm === false) return sent;
  return actionReply(context, { content: `Lista de produtos aberta para o carrinho #${order.id}.`, ephemeral: true });
}
async function sendAddCartCommand(message, initialQuery = "") {
  await message.delete().catch(() => null);
  const queryText = initialQuery ? ` Pesquisa desejada: **${clampText(initialQuery, 100)}**.` : "";
  const sent = await sendSafeDM(message.author.id, {
    content: `Use \`/addproduto\` dentro do seu carrinho. A busca aparecerá somente para você.${queryText}`
  });
  if (sent) return true;
  const notice = await message.channel.send(`<@${message.author.id}> use \`/addproduto\`; a lista privada não pode ser aberta por comando com \`!\`.`).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => null), 10_000);
  return notice;
}
async function handleAddCartButton(interaction) {
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `/addproduto` novamente.", ephemeral: true });

  const [, , action] = interaction.customId.split(":");
  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (paymentStarted(order)) return interaction.reply({ content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
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
    addCartSessions.delete(session.id);
    return interaction.update({ content: "Busca fechada.", embeds: [], components: [] });
  }
}
async function handleAddCartSearchSubmit(interaction) {
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `/addproduto` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (paymentStarted(order)) return interaction.reply({ content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
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
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `/addproduto` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (paymentStarted(order)) return interaction.reply({ content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  const entry = addCartCatalogEntry(session, interaction.values[0]);
  if (!entry) return interaction.reply({ content: "Produto nao encontrado nessa lista. Clique em Atualizar e tente de novo.", ephemeral: true });
  return interaction.showModal(addCartQuantityModal(session, entry));
}
async function handleAddCartQuantitySubmit(interaction) {
  const parts = interaction.customId.split(":");
  const session = getAddCartSession(interaction);
  if (!session) return interaction.reply({ content: "Sessao expirada. Use `/addproduto` novamente.", ephemeral: true });

  const db = readOrders();
  const order = db.orders?.[session.orderId];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (paymentStarted(order)) return interaction.reply({ content: "O carrinho foi congelado porque o pagamento ja foi gerado.", ephemeral: true });
  if (!addCartSessionAllowed(interaction, session, order)) return interaction.reply({ content: "Essa lista foi aberta por outro usuario.", ephemeral: true });

  const quantity = parseCartQuantity(interaction.fields.getTextInputValue("quantity"));
  if (!quantity) return interaction.reply({ content: "Quantidade invalida. Use um numero maior que zero.", ephemeral: true });

  const panel = getOrderPanel(order, interaction.guildId);
  const entry = addCartCatalogEntry(session, parts[2]);
  if (!entry) return interaction.reply({ content: "Produto nao encontrado nessa lista. Clique em Atualizar e tente de novo.", ephemeral: true });
  const p = entry.product || {};
  if (!productHasStock(p, quantity)) return interaction.reply({ content: stockUnavailableMessage(p, quantity), ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const sourcePanel = getPanelById(interaction.guildId, entry.panelId);
  if (!await automaticProductHasStock(interaction.guildId, sourcePanel, p, quantity)) return actionReply(interaction, { content: "Este produto esta indisponivel no momento.", ephemeral: true });

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
  await refreshCartMessage(interaction.guild, order, panel, interaction.channel);
  await interaction.editReply({ content: `Adicionado: ${productIcon(p)} **${p.name || "Produto"}** x${quantity}.\nTotal atualizado: **${totalLine(order, panel)}**` });
  return null;
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

  const staffRoleId = adminRoleId(interaction.guildId);
  await interaction.channel.send({
    content: `${staffRoleId ? `<@&${staffRoleId}> ` : ""}${config.messages.adminCall}\nID: **${record.id || id}** | Cliente: <@${record.userId}>`,
    allowedMentions: { roles: staffRoleId ? [staffRoleId] : [], users: [record.userId] }
  });
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
async function testNtfyCommand(context) {
  if (!isAdmin(context.member) && !isBotOwner(actionUser(context))) {
    return actionReply(context, { content: "So ADM pode testar as notificacoes.", ephemeral: true });
  }
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  try {
    const result = await sendNtfyTestNotification();
    if (!result.sent) {
      return actionReply(context, {
        content: "ntfy nao configurado. Use NTFY_TOPIC com o link completo ou NTFY_URL + NTFY_TOPIC.",
        ephemeral: true
      });
    }
    return actionReply(context, { content: `Teste ntfy enviado com sucesso (HTTP ${result.status}).`, ephemeral: true });
  } catch (error) {
    return actionReply(context, {
      content: `Falha no teste ntfy: ${errorSummary(error).message}`,
      ephemeral: true
    });
  }
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
  const saved = options.guildId ? serverConfig(options.guildId) : {};
  const channelId = normalizeChannelId(options.reviewChannelId || saved.reviewChannelId || process.env.REVIEW_CHANNEL_ID || legacyStoreValue(config.review?.channelId));
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
  const review = reviewConfig({ ...options, guildId: actionGuildId(context) });
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
function verifiedPrivateOrderChannel(channel, order) {
  if (!channel?.isTextBased?.() || !channel.permissionsFor) return false;
  const everyoneCanView = channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
  const customerCanView = channel.permissionsFor(order.userId)?.has(PermissionFlagsBits.ViewChannel);
  return !everyoneCanView && Boolean(customerCanView);
}
async function deliverAutomaticOrderStock(order, panel, db, source = "payment") {
  if (!postgresEnabled() || Number(order.paymentSnapshot?.automaticUnits) <= 0) return { delivered: false, pending: false, count: 0 };
  const rows = await reservedStockForOrder(getPostgresPool(), order.id);
  const reserved = rows.filter(row => row.status === STOCK_STATUS.RESERVED);
  const sold = rows.filter(row => row.status === STOCK_STATUS.SOLD);
  if (!reserved.length && sold.length) return { delivered: true, pending: false, count: sold.length };
  if (!reserved.length) {
    if (Number(order.paymentSnapshot?.automaticUnits) > 0) {
      order.paymentState = PAYMENT_STATE.PAID_DELIVERY_PENDING;
      touchOrder(order);
      appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: client.user?.id || "bot", username: "bot" } }, "order.stock_reservation_missing", { order, source });
      await persistPaymentOrder(db, order, panel);
      await sendSafeDM(order.userId, { content: `O pagamento do pedido #${order.id} foi confirmado, mas a entrega automatica precisa de atendimento manual. Nenhuma nova key foi consumida.` });
      return { delivered: false, pending: true, count: 0 };
    }
    return { delivered: false, pending: false, count: 0 };
  }
  if (reserved.some(row => row.reserved_by_order_id !== order.id)) throw new Error("Reserva de estoque inconsistente.");
  const values = reserved.map(row => decryptStockValue(row, process.env.STOCK_ENCRYPTION_KEY));
  order.paymentState = PAYMENT_STATE.DELIVERING;
  order.deliveryAttemptedAt = new Date().toISOString();
  touchOrder(order);
  await persistPaymentOrder(db, order, panel);

  const deliveryPayload = {
    embeds: [new EmbedBuilder()
      .setTitle("Entrega automatica")
      .setDescription([`Pedido #${order.id}`, "", ...values.map((value, index) => `**Item ${index + 1}:**\n\`\`\`${value}\`\`\``)].join("\n").slice(0, 4096))
      .setColor(parseColor(panel.color))
      .setTimestamp()]
  };
  let delivered = await sendSafeDM(order.userId, deliveryPayload);
  const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId).catch(() => null);
  const channel = guild ? await guild.channels.fetch(order.channelId).catch(() => null) : null;
  if (!delivered && verifiedPrivateOrderChannel(channel, order)) {
    delivered = Boolean(await channel.send({ content: `<@${order.userId}> sua DM esta fechada; entrega protegida abaixo.`, ...deliveryPayload, allowedMentions: { users: [order.userId] } }).catch(() => null));
  }
  if (!delivered) {
    order.paymentState = PAYMENT_STATE.PAID_DELIVERY_PENDING;
    order.deliveryFailureAt = new Date().toISOString();
    touchOrder(order);
    appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: client.user?.id || "bot", username: "bot" } }, "order.delivery_pending", { order, source, quantity: reserved.length });
    await persistPaymentOrder(db, order, panel);
    if (channel?.isTextBased()) await channel.send({ content: `<@${order.userId}> o pagamento foi confirmado, mas a entrega automatica ficou pendente. Abra sua DM ou aguarde atendimento.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
    return { delivered: false, pending: true, count: reserved.length };
  }

  await markOrderStockSold(getPostgresPool(), order.id, order.userId);
  const totalUnits = (order.paymentSnapshot?.items || []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
  const allAutomatic = Number(order.paymentSnapshot?.automaticUnits) === totalUnits;
  order.automaticStockDeliveredAt = new Date().toISOString();
  order.stockReservationCompletedAt = order.automaticStockDeliveredAt;
  delete order.stockReservedAt;
  order.paymentState = allAutomatic ? PAYMENT_STATE.DELIVERED : PAYMENT_STATE.PAID_DELIVERY_PENDING;
  if (allAutomatic) {
    order.deliveredAt = order.automaticStockDeliveredAt;
    order.deliveredByAdminId = client.user?.id || "bot";
    order.deliveredByAdminName = "Entrega automatica";
    order.deliveryMessage = "Estoque automatico entregue de forma privada.";
  }
  touchOrder(order);
  appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: client.user?.id || "bot", username: "bot" } }, "order.stock_delivered", { order, source, quantity: reserved.length });
  await persistPaymentOrder(db, order, panel);
  if (channel?.isTextBased()) {
    await channel.send({ content: `<@${order.userId}> ${reserved.length} item(ns) do estoque automatico foram entregues com seguranca.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
    await refreshCartMessage(guild, order, panel, channel);
  }
  return { delivered: true, pending: !allAutomatic, count: reserved.length };
}
async function rejectManualPayment(context, id) {
  if (!await requireBotOwner(context)) return;
  if (context.isRepliable?.() && !context.deferred && !context.replied) await context.deferReply({ ephemeral: true });
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.status !== ORDER_STATUS.OPEN) return actionReply(context, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX) return actionReply(context, { content: "Este pedido nao usa Pix manual.", ephemeral: true });
  if ([PAYMENT_STATE.MANUAL_PAYMENT_APPROVED, PAYMENT_STATE.PAID, PAYMENT_STATE.DELIVERING, PAYMENT_STATE.DELIVERED].includes(order.paymentState)) return actionReply(context, { content: "O pagamento ja foi aprovado e nao pode ser recusado.", ephemeral: true });
  if (!claimOrderActionLock(order)) return actionReply(context, { content: "Outra acao esta processando este pedido.", ephemeral: true });
  try {
    if (postgresEnabled()) {
      const rejected = await withPostgresTransaction(async dbClient => {
        const result = await dbClient.query(`
          update orders set payment_state = 'MANUAL_PAYMENT_REJECTED', updated_at = now()
          where id = $1 and payment_method = 'MANUAL_PIX'
            and payment_state in ('AWAITING_MANUAL_PAYMENT', 'MANUAL_PAYMENT_UNDER_REVIEW')
            and total_cents_snapshot = $2 and user_id = $3
          returning id
        `, [order.id, order.totalCentsSnapshot, order.userId]);
        return result.rowCount === 1;
      });
      if (!rejected) return actionReply(context, { content: "Este pagamento ja foi aprovado, recusado ou processado por outra acao.", ephemeral: true });
      await releaseOrderStock(getPostgresPool(), order.id);
    }
    order.paymentState = PAYMENT_STATE.MANUAL_PAYMENT_REJECTED;
    order.paymentRejectedAt = new Date().toISOString();
    order.paymentRejectedById = actionUser(context).id;
    order.manualPaymentAwaitingReplacement = true;
    order.lastRejectedProofMessageId = order.paymentProofLatestMessageId || order.manualPaymentNotificationProofMessageId || "";
    delete order.stockReservedAt;
    touchOrder(order);
    appendAuditLog(db, context, "order.manual_payment_rejected", { order });
    const panel = getOrderPanel(order, order.guildId);
    await persistPaymentOrder(db, order, panel);
    await context.channel.send({ content: `<@${order.userId}> o comprovante do pedido #${order.id} foi recusado. Envie uma nova imagem ou PDF e clique em **Enviei novo comprovante** abaixo do Pix.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    await refreshManualPaymentMessage(order, context.channel);
    return actionReply(context, { content: "Pagamento recusado e reserva liberada.", ephemeral: true });
  } finally {
    releaseOrderActionLock(order);
  }
}
async function requestNewManualProof(context, id) {
  if (!await requireBotOwner(context)) return;
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX) return actionReply(context, { content: "Pedido manual inexistente.", ephemeral: true });
  if (order.paymentState !== PAYMENT_STATE.MANUAL_PAYMENT_REJECTED) return actionReply(context, { content: "Solicite novo comprovante somente depois de recusar o anterior.", ephemeral: true });
  const panel = getOrderPanel(order, order.guildId);
  const snapshot = serverOrderSnapshot(order);
  if (snapshot.hash !== order.paymentSnapshot?.hash || snapshot.totalCents !== order.totalCentsSnapshot) {
    return actionReply(context, { content: "O produto ou valor mudou. Cancele este carrinho e gere um pedido novo.", ephemeral: true });
  }
  const reservedIds = await reserveAutomaticStockForOrder(order, panel, snapshot);
  if (reservedIds.length) order.stockReservedAt = new Date().toISOString();
  order.paymentState = PAYMENT_STATE.AWAITING_MANUAL_PAYMENT;
  order.manualPaymentAwaitingReplacement = true;
  order.lastRejectedProofMessageId = order.paymentProofLatestMessageId || order.manualPaymentNotificationProofMessageId || "";
  delete order.paymentExpiresAt;
  touchOrder(order);
  appendAuditLog(db, context, "order.new_proof_requested", { order });
  await persistPaymentOrder(db, order, panel);
  await context.channel.send({ content: `<@${order.userId}> envie uma nova imagem ou PDF e clique no botao abaixo da mensagem Pix.`, allowedMentions: { users: [order.userId] } });
  await refreshCartMessage(context.guild, order, panel, context.channel);
  await refreshManualPaymentMessage(order, context.channel);
  return actionReply(context, { content: "Novo comprovante solicitado.", ephemeral: true });
}
async function retryAutomaticDelivery(context, id) {
  if (!isAdmin(context.member) && !isBotOwner(actionUser(context))) {
    return actionReply(context, { content: "Somente ADM pode reenviar uma entrega pendente.", ephemeral: true });
  }
  if (context.isRepliable?.() && !context.deferred && !context.replied) await context.deferReply({ ephemeral: true });
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  if (!order || order.paymentState !== PAYMENT_STATE.PAID_DELIVERY_PENDING) return actionReply(context, { content: "Nao existe entrega automatica pendente neste pedido.", ephemeral: true });
  const panel = getOrderPanel(order, order.guildId);
  if (order.deliveryMessage && !order.stockReservedAt) {
    const payload = { embeds: [new EmbedBuilder().setTitle("Produto entregue").setDescription(`Pedido #${order.id}\n\n${order.deliveryMessage}`.slice(0, 4096)).setColor(parseColor(panel.color)).setTimestamp()] };
    let delivered = await sendSafeDM(order.userId, payload);
    if (!delivered && verifiedPrivateOrderChannel(context.channel, order)) delivered = Boolean(await context.channel.send({ content: `<@${order.userId}> entrega protegida abaixo.`, ...payload, allowedMentions: { users: [order.userId] } }).catch(() => null));
    if (!delivered) return actionReply(context, { content: "A mesma entrega continua pendente; nenhum dado novo foi consumido.", ephemeral: true });
    order.deliveredAt = new Date().toISOString();
    order.deliveredByAdminId = actionUser(context).id;
    order.deliveredByAdminName = context.member?.displayName || actionUser(context).username;
    order.paymentState = PAYMENT_STATE.DELIVERED;
    touchOrder(order);
    appendAuditLog(db, context, "order.delivery_retried", { order });
    await persistPaymentOrder(db, order, panel);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    return actionReply(context, { content: "A mesma entrega foi reenviada com sucesso.", ephemeral: true });
  }
  const result = await deliverAutomaticOrderStock(order, panel, db, "manual_retry");
  return actionReply(context, { content: result.delivered ? "A mesma reserva foi reenviada com sucesso." : "A entrega continua pendente; nenhuma nova key foi consumida.", ephemeral: true });
}
function validStoredPaymentSnapshot(order) {
  if (!order.paymentSnapshot?.hash) return false;
  const hash = crypto.createHash("sha256").update(JSON.stringify({
    items: order.paymentSnapshot.items,
    grossCents: order.paymentSnapshot.grossCents,
    discountCents: order.paymentSnapshot.discountCents,
    totalCents: order.paymentSnapshot.totalCents
  })).digest("hex");
  return hash === order.paymentSnapshot.hash;
}
async function processPaidPagBankOrder(payload, source = "pagbank_webhook") {
  const charge = paidPixCharge(payload);
  if (!charge) return { ok: false, reason: "not_paid", orderFound: false };
  const referenceId = String(payload.reference_id || charge.reference_id || "");
  const pagBankOrderId = String(payload.id || "");
  const db = readOrders();
  const order = Object.values(db.orders || {}).find(item =>
    item.pagBankOrderId === pagBankOrderId || (referenceId && item.pagBankReferenceId === referenceId)
  );
  if (!order || order.paymentMethod !== PAYMENT_METHOD.PAGBANK_PIX) {
    console.warn(`PagBank ${source}: pedido interno nao encontrado para ${pagBankOrderId || "ID ausente"}.`);
    return { ok: false, reason: "order_not_found", orderFound: false };
  }
  const validation = validatePaidPixNotification(order, payload);
  if (!validation.ok || !validStoredPaymentSnapshot(order)) {
    console.warn(`PagBank ${source}: validacao de referencia, valor ou snapshot falhou no pedido ${order.id}.`);
    return { ok: false, reason: "validation_failed", orderFound: true, internalOrderId: order.id };
  }
  if ([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELED].includes(order.status) || order.paymentState === PAYMENT_STATE.CANCELED) {
    return { ok: false, reason: "invalid_state", orderFound: true, internalOrderId: order.id, paymentState: order.paymentState };
  }
  if (order.paymentState === PAYMENT_STATE.DELIVERED || order.automaticStockDeliveredAt) {
    return { ok: true, duplicate: true, orderFound: true, internalOrderId: order.id, paymentState: order.paymentState };
  }
  if (order.paymentState === PAYMENT_STATE.DELIVERING) {
    return { ok: true, processing: true, orderFound: true, internalOrderId: order.id, paymentState: order.paymentState };
  }
  const alreadyPaid = [PAYMENT_STATE.PAID, PAYMENT_STATE.PAID_DELIVERY_PENDING].includes(order.paymentState);
  if (alreadyPaid && Number(order.paymentSnapshot?.automaticUnits) <= 0) {
    return { ok: true, duplicate: true, orderFound: true, internalOrderId: order.id, paymentState: order.paymentState };
  }
  if (!alreadyPaid && ![PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT, PAYMENT_STATE.EXPIRED].includes(order.paymentState)) {
    return { ok: false, reason: "invalid_state", orderFound: true, internalOrderId: order.id, paymentState: order.paymentState };
  }
  if (!claimOrderActionLock(order)) return { ok: true, processing: true, orderFound: true, internalOrderId: order.id };
  try {
    if (!alreadyPaid && postgresEnabled()) {
      const locked = await withPostgresTransaction(async dbClient => {
        const result = await dbClient.query(`
          update orders set payment_state = 'PAID', pagbank_charge_id = $2, updated_at = now()
          where id = $1 and payment_method = 'PAGBANK_PIX' and payment_state in ('AWAITING_PAGBANK_PAYMENT', 'EXPIRED')
            and total_cents_snapshot = $3 and pagbank_reference_id = $4 and user_id = $5
          returning id
        `, [order.id, validation.chargeId || null, validation.amountCents, validation.referenceId, order.userId]);
        return result.rowCount === 1;
      });
      if (!locked) return { ok: true, duplicate: true, orderFound: true, internalOrderId: order.id };
    }
    if (!alreadyPaid) {
      order.paymentState = PAYMENT_STATE.PAID;
      order.paymentStatus = "marked_paid";
      order.paidAt = String(charge.paid_at || new Date().toISOString());
      order.paidAmount = validation.amountCents / 100;
      order.pagBankChargeId = validation.chargeId;
      touchOrder(order);
      appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: "pagbank", username: "PagBank" } }, "order.pagbank_paid", { order, amountCents: validation.amountCents, source });
      await persistPaymentOrder(db, order, getOrderPanel(order, order.guildId));
    }
    const panel = getOrderPanel(order, order.guildId);
    const delivery = await deliverAutomaticOrderStock(order, panel, db, source);
    const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(order.channelId).catch(() => null) : null;
    if (channel?.isTextBased()) {
      await channel.send({ content: `<@${order.userId}> pagamento Pix confirmado pelo PagBank.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
      await refreshCartMessage(guild, order, panel, channel);
    }
    return { ok: true, orderFound: true, internalOrderId: order.id, paymentState: order.paymentState, delivery };
  } finally {
    releaseOrderActionLock(order);
  }
}
async function handlePagBankWebhook(req, res) {
  console.log("[PagBank webhook] recebido", {
    method: req.method,
    path: req.originalUrl,
    contentType: req.headers["content-type"] || null,
    hasAuthenticityToken: Boolean(req.headers["x-authenticity-token"]),
    bodyIsBuffer: Buffer.isBuffer(req.body),
    bodyLength: Buffer.isBuffer(req.body) ? req.body.length : 0
  });
  const rawBody = req.body;
  let payload;
  try {
    if (!Buffer.isBuffer(rawBody)) throw new Error("body_not_buffer");
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false });
  }
  const config = pagBankConfig();
  const signature = req.headers["x-authenticity-token"];
  const signatureValid = verifyWebhookSignature(rawBody, signature, config.token);
  if (!signatureValid) {
    if (config.environment !== "sandbox" || signature) {
      console.warn("Webhook PagBank rejeitado: assinatura ausente ou invalida.");
      return res.status(401).json({ ok: false });
    }
    const orderId = String(payload?.id || req.headers["x-product-id"] || "");
    if (!/^ORDE_/i.test(orderId)) return res.status(401).json({ ok: false });
    try {
      payload = await getPagBankOrder(orderId);
      console.log(`[PagBank webhook] Sandbox sem assinatura confirmado via GET /orders/${orderId}.`);
    } catch (error) {
      console.warn(`Webhook PagBank Sandbox nao confirmado via API: ${error.message}`);
      return res.status(401).json({ ok: false });
    }
  }
  const result = await processPaidPagBankOrder(payload, signatureValid ? "pagbank_webhook" : "pagbank_sandbox_fallback");
  if (result.processing) return res.status(202).json({ ok: true, processing: true });
  if (result.ok) return res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate) });
  if (["not_paid", "order_not_found"].includes(result.reason)) return res.status(200).json({ ok: true, ignored: true });
  return res.status(409).json({ ok: false });
}
async function reconcilePagBankCommand(context, orderId) {
  if (!await requireBotOwner(context, "Somente BOT_OWNER_IDS pode reconciliar pagamentos PagBank.")) return;
  if (context.isRepliable?.() && !context.deferred && !context.replied) await context.deferReply({ ephemeral: true });
  const id = String(orderId || "").trim();
  if (!/^ORDE_[A-Z0-9-]{10,80}$/i.test(id)) return actionReply(context, { content: "Informe um order_id valido no formato ORDE_...", ephemeral: true });
  try {
    const payload = await getPagBankOrder(id);
    const result = await processPaidPagBankOrder(payload, "pagbank_admin_reconciliation");
    if (result.reason === "not_paid") return actionReply(context, { content: `O pedido ${id} existe, mas ainda nao possui cobranca PIX com status PAID.`, ephemeral: true });
    if (result.reason === "order_not_found") return actionReply(context, { content: `O PagBank confirmou ${id}, mas nenhum pedido interno correspondente foi encontrado.`, ephemeral: true });
    if (!result.ok) return actionReply(context, { content: `Reconciliação recusada por seguranca: ${result.reason || "validacao_falhou"}.`, ephemeral: true });
    if (result.processing) return actionReply(context, { content: `O pedido interno #${result.internalOrderId} ja esta sendo processado.`, ephemeral: true });
    if (result.duplicate) return actionReply(context, { content: `Pedido interno #${result.internalOrderId} ja estava confirmado; nenhuma entrega duplicada foi feita.`, ephemeral: true });
    const delivered = Number(result.delivery?.count) || 0;
    return actionReply(context, { content: `Pedido interno #${result.internalOrderId} reconciliado com sucesso.${delivered ? ` ${delivered} item(ns) automatico(s) processado(s).` : ""}`, ephemeral: true });
  } catch (error) {
    safePagBankFailure(error, { id: "reconciliation" });
    return actionReply(context, { content: `Nao foi possivel consultar o pedido PagBank: ${error.message}`, ephemeral: true });
  }
}
async function reconcileMercadoPagoOrder(order, source = "mercadopago_reconciliation") {
  const paymentId = String(order?.mercadoPagoPaymentId || "").trim();
  if (!paymentId) return { ok: false, reason: "payment_id_missing", internalOrderId: order?.id };
  const payment = await getMercadoPagoPayment(paymentId);
  const providerStatus = String(payment?.status || "unknown").toLowerCase();
  if (providerStatus !== "approved") {
    return { ok: false, reason: "not_approved", providerStatus, internalOrderId: order.id };
  }
  return processApprovedMercadoPagoPayment(payment, source);
}
async function notifyAutomaticPaymentOnce(order, panel, paymentId) {
  const key = `${order.id}:${String(paymentId || "")}`;
  if (!paymentId || order.automaticPaymentNotificationKey === key) return { sent: false, duplicate: true };
  if (!ntfyReady()) return { sent: false, reason: "not_configured" };
  if (automaticNotificationLocks.has(key)) return { sent: false, processing: true };
  automaticNotificationLocks.add(key);
  try {
    const result = await sendAutomaticPaymentNotification(orderNotificationInput(order, panel, {
      idempotencyKey: `automatic:${key}`
    }));
    if (!result.sent) return result;
    order.automaticPaymentNotificationKey = key;
    const db = readOrders();
    const current = db.orders?.[order.id];
    if (current && current.automaticPaymentNotificationKey !== key) {
      current.automaticPaymentNotificationKey = key;
      touchOrder(current);
      db.orders[current.id] = current;
      await persistPaymentOrder(db, current, panel);
    }
    return result;
  } catch (error) {
    console.warn(`Falha ao enviar notificacao automatica do pedido #${order.id}: ${errorSummary(error).message}`);
    return { sent: false, reason: "failed" };
  } finally {
    automaticNotificationLocks.delete(key);
  }
}
async function processApprovedMercadoPagoPayment(payload, source = "mercadopago_webhook") {
  const db = readOrders();
  const order = Object.values(db.orders || {}).find(item => String(item.mercadoPagoPaymentId || "") === String(payload?.id || ""));
  if (!order || order.paymentMethod !== PAYMENT_METHOD.MERCADOPAGO_PIX) return { ok: false, reason: "order_not_found" };
  const validation = validateApprovedMercadoPagoPayment(order, payload);
  if (!validation.ok || !validStoredPaymentSnapshot(order)) return { ok: false, reason: "validation_failed", internalOrderId: order.id };
  if ([ORDER_STATUS.CANCELLED, ORDER_STATUS.CANCELED].includes(order.status) || order.paymentState === PAYMENT_STATE.CANCELED) {
    return { ok: false, reason: "invalid_state", internalOrderId: order.id, paymentState: order.paymentState };
  }
  const panel = getOrderPanel(order, order.guildId);
  await notifyAutomaticPaymentOnce(order, panel, payload.id);
  const automaticUnits = Number(order.paymentSnapshot?.automaticUnits) || 0;
  if (order.paymentState === PAYMENT_STATE.DELIVERED || order.automaticStockDeliveredAt) {
    return { ok: true, duplicate: true, internalOrderId: order.id };
  }
  if (order.paymentState === PAYMENT_STATE.PAID_DELIVERY_PENDING) {
    return { ok: true, duplicate: true, deliveryPending: true, internalOrderId: order.id };
  }
  if (order.paymentState === PAYMENT_STATE.DELIVERING) {
    const attemptedAt = Date.parse(order.deliveryAttemptedAt || "");
    if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt < 2 * 60 * 1000) {
      return { ok: true, processing: true, internalOrderId: order.id };
    }
    order.paymentState = PAYMENT_STATE.PAID_DELIVERY_PENDING;
    touchOrder(order);
    await persistPaymentOrder(db, order, getOrderPanel(order, order.guildId));
    return { ok: true, duplicate: true, deliveryPending: true, internalOrderId: order.id };
  }
  const alreadyPaid = order.paymentState === PAYMENT_STATE.PAID;
  if (alreadyPaid && automaticUnits <= 0) return { ok: true, duplicate: true, internalOrderId: order.id };
  if (!alreadyPaid && ![PAYMENT_STATE.AWAITING_PAGBANK_PAYMENT, PAYMENT_STATE.EXPIRED].includes(order.paymentState)) {
    return { ok: false, reason: "invalid_state", internalOrderId: order.id, paymentState: order.paymentState };
  }
  if (!claimOrderActionLock(order)) return { ok: true, processing: true, internalOrderId: order.id };
  try {
    if (!alreadyPaid) {
      order.paymentState = PAYMENT_STATE.PAID;
      order.paymentStatus = "marked_paid";
      order.paidAt = String(payload.date_approved || new Date().toISOString());
      order.paidAmount = validation.amountCents / 100;
      touchOrder(order);
      appendAuditLog(db, { guildId: order.guildId, channelId: order.channelId, user: { id: "mercadopago", username: "Mercado Pago" } }, "order.mercadopago_paid", { order, amountCents: validation.amountCents, source });
      await persistPaymentOrder(db, order, panel);
    }
    const delivery = await deliverAutomaticOrderStock(order, panel, db, source);
    const guild = client.guilds.cache.get(order.guildId) || await client.guilds.fetch(order.guildId).catch(() => null);
    const channel = guild ? await guild.channels.fetch(order.channelId).catch(() => null) : null;
    if (!alreadyPaid && channel?.isTextBased()) {
      await channel.send({ content: `<@${order.userId}> pagamento Pix confirmado pelo Mercado Pago.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
      await refreshCartMessage(guild, order, panel, channel);
    }
    return { ok: true, internalOrderId: order.id, delivery };
  } finally { releaseOrderActionLock(order); }
}
async function handleMercadoPagoWebhook(req, res) {
  console.log("[Mercado Pago webhook] recebido", { method: req.method, path: req.path, contentType: req.headers["content-type"] || null, hasSignature: Boolean(req.headers["x-signature"]), bodyIsBuffer: Buffer.isBuffer(req.body) });
  let body;
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}"); } catch { return res.status(400).json({ ok: false }); }
  const queryPaymentId = String(req.query?.["data.id"] || req.query?.id || "").trim();
  const bodyPaymentId = String(body?.data?.id || "").trim();
  if (queryPaymentId && bodyPaymentId && queryPaymentId !== bodyPaymentId) return res.status(400).json({ ok: false });
  const paymentId = queryPaymentId || bodyPaymentId;
  if (!/^\d{5,30}$/.test(paymentId)) return res.status(400).json({ ok: false });
  const known = Object.values(readOrders().orders || {}).some(order => String(order.mercadoPagoPaymentId || "") === paymentId);
  if (!known) return res.status(200).json({ ok: true, ignored: true });
  const config = mercadoPagoConfig();
  if (config.webhookSecret && !verifyMercadoPagoSignature({ xSignature: req.headers["x-signature"], xRequestId: req.headers["x-request-id"], dataId: queryPaymentId || paymentId, secret: config.webhookSecret })) {
    console.warn("Mercado Pago webhook recusado: assinatura invalida ou ausente.");
    return res.status(401).json({ ok: false });
  }
  try {
    const payment = await getMercadoPagoPayment(paymentId);
    const result = await processApprovedMercadoPagoPayment(payment);
    if (result.processing) return res.status(202).json({ ok: true });
    if (!result.ok && result.reason === "validation_failed") return res.status(409).json({ ok: false });
    return res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate), ignored: !result.ok });
  } catch (error) {
    console.warn(`Mercado Pago webhook nao confirmado: ${error.message}`);
    return res.status(502).json({ ok: false });
  }
}
async function reconcileMercadoPagoCommand(context, paymentId) {
  if (!await requireBotOwner(context, "Somente BOT_OWNER_IDS pode reconciliar Mercado Pago.")) return;
  if (context.isRepliable?.() && !context.deferred && !context.replied) await context.deferReply({ ephemeral: true });
  try {
    const payment = await getMercadoPagoPayment(paymentId);
    const result = await processApprovedMercadoPagoPayment(payment, "mercadopago_admin_reconciliation");
    if (result.reason === "order_not_found") return actionReply(context, { content: "Pagamento existe, mas nao corresponde a um pedido interno salvo.", ephemeral: true });
    if (result.reason === "validation_failed") return actionReply(context, { content: "Pagamento recusado: status, Pix, referencia ou valor nao conferem.", ephemeral: true });
    return actionReply(context, { content: result.duplicate ? `Pedido #${result.internalOrderId} ja estava confirmado; nenhuma entrega foi duplicada.` : `Pedido #${result.internalOrderId} reconciliado com sucesso.`, ephemeral: true });
  } catch (error) { return actionReply(context, { content: `Falha ao consultar Mercado Pago: ${error.message}`, ephemeral: true }); }
}
async function verifyAutomaticPayment(context, order) {
  const actor = actionUser(context);
  if (actor.id !== order.userId && !isAdmin(context.member) && !isBotOwner(actor)) {
    return actionReply(context, { content: "Somente o cliente ou um ADM pode verificar este pagamento.", ephemeral: true });
  }
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  try {
    let result;
    if (order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX) {
      if (!order.mercadoPagoPaymentId) return actionReply(context, { content: "A cobranca Mercado Pago ainda nao possui um ID para consulta.", ephemeral: true });
      result = await reconcileMercadoPagoOrder(order, "mercadopago_user_check");
      if (result.reason === "not_approved") {
        const label = result.providerStatus === "pending" ? "ainda aguardando o Pix" : `com status ${result.providerStatus}`;
        return actionReply(context, { content: `O Mercado Pago respondeu que o pagamento esta ${label}. Se voce acabou de pagar, aguarde alguns segundos e tente novamente.`, ephemeral: true });
      }
    } else if (order.paymentMethod === PAYMENT_METHOD.PAGBANK_PIX) {
      if (!order.pagBankOrderId) return actionReply(context, { content: "A cobranca PagBank ainda nao possui um ID para consulta.", ephemeral: true });
      const payload = await getPagBankOrder(order.pagBankOrderId);
      result = await processPaidPagBankOrder(payload, "pagbank_user_check");
      if (result.reason === "not_paid") {
        return actionReply(context, { content: "O PagBank ainda nao confirmou o Pix. Se voce acabou de pagar, aguarde alguns segundos e tente novamente.", ephemeral: true });
      }
    } else {
      return actionReply(context, { content: "Este carrinho nao usa pagamento automatico.", ephemeral: true });
    }

    if (result.processing) return actionReply(context, { content: "O pagamento foi localizado e ja esta sendo processado.", ephemeral: true });
    if (!result.ok) return actionReply(context, { content: "O provedor respondeu, mas os dados do pagamento nao conferem com este pedido. Um proprietario precisa verificar o caso.", ephemeral: true });
    if (result.deliveryPending) return actionReply(context, { content: "Pagamento confirmado. A entrega automatica ficou pendente; um ADM pode tentar novamente pelo botao **Entregar**.", ephemeral: true });
    if (result.duplicate) return actionReply(context, { content: `O pagamento do pedido #${result.internalOrderId || order.id} ja estava confirmado.`, ephemeral: true });
    const delivered = Number(result.delivery?.count) || 0;
    return actionReply(context, { content: `Pagamento do pedido #${result.internalOrderId || order.id} confirmado oficialmente.${delivered ? ` ${delivered} item(ns) automatico(s) processado(s).` : ""}`, ephemeral: true });
  } catch (error) {
    return actionReply(context, { content: `Nao foi possivel consultar o provedor agora: ${error.message}`, ephemeral: true });
  }
}
async function markOrderPaid(context, id) {
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
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
  if ([PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX].includes(order.paymentMethod)) {
    return verifyAutomaticPayment(context, order);
  }
  if (!authorizedManualPaymentStaff(context)) {
    return actionReply(context, { content: "Somente dono, ADM ou atendente configurado pode confirmar pagamento manual.", ephemeral: true });
  }
  if (order.paymentFlowVersion >= 2 && !order.paymentMethod) {
    return actionReply(context, { content: "Gere o pagamento antes de aprovar.", ephemeral: true });
  }
  if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX && actionUser(context).id === order.userId) {
    writeAuditLog(context, "security.self_payment_approval_denied", { orderId: order.id, targetUserId: order.userId });
    return actionReply(context, { content: "O comprador nao pode aprovar o proprio pagamento, mesmo sendo proprietario.", ephemeral: true });
  }
  const manualApprovalStates = Number(order.paymentFlowVersion || 0) >= 3
    ? [PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW]
    : [PAYMENT_STATE.AWAITING_MANUAL_PAYMENT, PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW];
  if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX && !manualApprovalStates.includes(order.paymentState)) {
    return actionReply(context, { content: `Este pagamento manual nao pode ser aprovado no estado ${paymentStatusLabel(order)}.`, ephemeral: true });
  }
  if (order.paymentStatus === "marked_paid" || order.paidAt) {
    return actionReply(context, { content: `Pagamento ja marcado por ${order.paidByAdminId ? `<@${order.paidByAdminId}>` : "um ADM"}.`, ephemeral: true });
  }

  if (!claimOrderActionLock(order)) return actionReply(context, { content: "Outra acao ja esta processando este pagamento.", ephemeral: true });
  try {
    const actor = actionUser(context);
    const panel = getOrderPanel(order, guildId);
    const totals = orderTotals(order, panel);
    if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX) {
      const currentSnapshot = serverOrderSnapshot(order);
      if (!order.paymentSnapshot?.hash || currentSnapshot.hash !== order.paymentSnapshot.hash || currentSnapshot.totalCents !== order.totalCentsSnapshot) {
        return actionReply(context, { content: "O produto ou valor mudou depois da cobranca. Cancele este pedido e gere outro pagamento.", ephemeral: true });
      }
      if (postgresEnabled()) {
        const approved = await withPostgresTransaction(async dbClient => {
          const result = await dbClient.query(`
            update orders set payment_state = 'MANUAL_PAYMENT_APPROVED', updated_at = now()
            where id = $1 and payment_method = 'MANUAL_PIX'
              and payment_state = any($4::text[])
              and total_cents_snapshot = $2 and user_id = $3
            returning id
          `, [order.id, order.totalCentsSnapshot, order.userId, manualApprovalStates]);
          return result.rowCount === 1;
        });
        if (!approved) return actionReply(context, { content: "Este pagamento ja foi aprovado, recusado ou processado por outra acao.", ephemeral: true });
      }
    }
    const now = new Date().toISOString();
    order.paymentStatus = "marked_paid";
    order.paymentState = order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX ? PAYMENT_STATE.MANUAL_PAYMENT_APPROVED : order.paymentState;
    order.paidAt = now;
    order.paidByAdminId = actor.id;
    order.paidByAdminName = context.member?.displayName || actor.username;
    if (order.paymentMethod === PAYMENT_METHOD.MANUAL_PIX) {
      order.manuallyApprovedBy = actor.id;
      order.manuallyApprovedAt = now;
    }
    order.paidAmount = order.totalCentsSnapshot ? order.totalCentsSnapshot / 100 : totals.amount;
    order.paidGrossAmount = order.paymentSnapshot?.grossCents ? order.paymentSnapshot.grossCents / 100 : totals.grossAmount;
    order.paidDiscountAmount = order.paymentSnapshot?.discountCents ? order.paymentSnapshot.discountCents / 100 : totals.discountAmount;
    touchOrder(order);
    appendAuditLog(db, context, "order.payment_marked_paid", {
      order,
      paidAmountCents: Math.round(order.paidAmount * 100),
      paymentMethod: order.paymentMethod || "LEGACY_MANUAL"
    });
    await persistPaymentOrder(db, order, panel);
    const automaticDelivery = await deliverAutomaticOrderStock(order, panel, db, "manual_approval");
    await refreshCartMessage(context.guild, order, panel, context.channel);
    await refreshManualPaymentMessage(order, context.channel);
    return actionReply(context, { content: `Pagamento do carrinho #${order.id} aprovado (${money(order.paidAmount)}).${automaticDelivery.count ? ` ${automaticDelivery.count} item(ns) automatico(s) processado(s).` : ""}`, ephemeral: true });
  } finally {
    releaseOrderActionLock(order);
  }
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
  if (order.paymentState === PAYMENT_STATE.PAID_DELIVERY_PENDING) {
    return retryAutomaticDelivery(interaction, id);
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
  const deliveryPayload = {
    embeds: [new EmbedBuilder()
      .setTitle("Produto entregue")
      .setDescription(`Pedido #${order.id}\n\n${deliveryMessage}`.slice(0, 4096))
      .setColor(parseColor(panel.color))
      .setTimestamp()]
  };
  let delivered = await sendSafeDM(order.userId, deliveryPayload);
  if (!delivered && verifiedPrivateOrderChannel(context.channel, order)) {
    delivered = Boolean(await context.channel.send({
      content: `<@${order.userId}> sua DM esta fechada; entrega protegida abaixo.`,
      ...deliveryPayload,
      allowedMentions: { users: [order.userId] }
    }).catch(() => null));
  }
  order.deliveryMessage = deliveryMessage;
  if (!delivered) {
    order.paymentState = PAYMENT_STATE.PAID_DELIVERY_PENDING;
    order.deliveryFailureAt = now;
    touchOrder(order);
    appendAuditLog(db, context, "order.delivery_pending", { order, deliveredBy: actor.id });
    await persistPaymentOrder(db, order, panel);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    return actionReply(context, { content: "Nao consegui entregar por DM nem confirmar que este ticket e privado. A mesma entrega ficou pendente para reenvio.", ephemeral: true });
  }
  order.deliveredAt = now;
  order.deliveredByAdminId = actor.id;
  order.deliveredByAdminName = context.member?.displayName || actor.username;
  if (order.paymentFlowVersion >= 2) order.paymentState = PAYMENT_STATE.DELIVERED;
  touchOrder(order);
  appendAuditLog(db, context, "order.delivered", {
    order,
    deliveredBy: actor.id
  });
  db.orders[order.id] = order;
  writeOrders(db);
  await persistOrderRelationalAsync(db, order, panel);

  await context.channel.send({ content: `<@${order.userId}> entrega do pedido #${order.id} concluida.`, allowedMentions: { users: [order.userId] } }).catch(() => null);
  await refreshCartMessage(context.guild, order, panel, context.channel);
  return actionReply(context, { content: `Entrega do pedido #${order.id} concluida de forma privada.`, ephemeral: true });
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
  if (order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX) {
    return actionReply(interaction, { content: "Este carrinho nao esta usando PIX manual.", ephemeral: true });
  }
  if (![PAYMENT_STATE.AWAITING_MANUAL_PAYMENT, PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW].includes(order.paymentState)) {
    return actionReply(interaction, { content: "Este pagamento manual nao esta aceitando comprovantes agora.", ephemeral: true });
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
      content: "Envie uma imagem ou um arquivo PDF do comprovante aqui neste carrinho nos proximos 2 minutos.",
      ephemeral: true
    });
  }

  await interaction.channel.send({
    content: `<@${targetUserId}> envie uma imagem ou um arquivo PDF do comprovante aqui neste carrinho nos proximos 2 minutos.`,
    allowedMentions: { users: [targetUserId] }
  }).catch(() => null);

  return actionReply(interaction, { content: `Solicitei o comprovante para <@${targetUserId}>.`, ephemeral: true });
}
function authorizedManualPaymentStaff(context) {
  const actor = actionUser(context);
  return isAdmin(context.member) ||
    isBotOwner(actor) ||
    Boolean(getStaffProfile(actionGuildId(context), actor.id));
}
function orderNotificationInput(order, panel, extra = {}) {
  const snapshotItems = Array.isArray(order.paymentSnapshot?.items) && order.paymentSnapshot.items.length
    ? order.paymentSnapshot.items
    : (order.items || []).map(item => {
      const sourcePanel = getPanelById(order.guildId, item.sourcePanelId || order.panelId) || panel;
      const sourceProduct = product(sourcePanel, item.sourceProductId || item.productId);
      return {
        name: sourceProduct?.name || item.name || "Produto",
        quantity: Math.max(1, Number(item.quantity) || 1)
      };
    });
  return {
    products: snapshotItems.map(item => `${item.name || "Produto"} x${Math.max(1, Number(item.quantity) || 1)}`),
    total: money((Number(order.totalCentsSnapshot) || Math.round(orderTotals(order, panel).amount * 100)) / 100),
    customerName: order.username || "cliente",
    customerId: order.userId,
    orderId: order.id,
    discordUrl: `https://discord.com/channels/${order.guildId}/${order.channelId}`,
    ...extra
  };
}
async function confirmManualPaymentNotification(context, id) {
  if (context.isRepliable?.() && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: true }).catch(() => null);
  }
  const db = readOrders();
  const order = orderForAction(db, id, context, false);
  const actor = actionUser(context);
  if (!order || order.status !== ORDER_STATUS.OPEN) {
    return actionReply(context, { content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }
  if (order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX) {
    return actionReply(context, { content: "Este carrinho nao esta usando PIX manual.", ephemeral: true });
  }
  if (actor.id !== order.userId && !authorizedManualPaymentStaff(context)) {
    return actionReply(context, { content: "Somente o cliente ou um atendente autorizado pode enviar esta confirmacao.", ephemeral: true });
  }
  const replacement = Boolean(order.manualPaymentAwaitingReplacement) &&
    [PAYMENT_STATE.MANUAL_PAYMENT_REJECTED, PAYMENT_STATE.AWAITING_MANUAL_PAYMENT].includes(order.paymentState);
  if (![PAYMENT_STATE.AWAITING_MANUAL_PAYMENT, PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW].includes(order.paymentState) && !replacement) {
    return actionReply(context, { content: `Este pagamento nao aceita confirmacao no estado ${paymentStatusLabel(order)}.`, ephemeral: true });
  }
  if (order.manualPaymentNotificationSentAt && !replacement) {
    return actionReply(context, { content: "O comprovante deste carrinho ja foi enviado para analise.", ephemeral: true });
  }
  if (!replacement) {
    const remaining = manualNotificationRemaining(
      db,
      order.guildId,
      actor.id,
      Date.now(),
      manualNotificationCooldownMs()
    );
    if (remaining > 0) {
      return actionReply(context, {
        content: `Voce ja enviou uma confirmacao recentemente. Aguarde ${Math.max(1, Math.ceil(remaining / 60_000))} minuto(s) e tente novamente.`,
        ephemeral: true
      });
    }
  }
  if (!claimOrderActionLock(order)) {
    return actionReply(context, { content: "Outra confirmacao deste carrinho esta sendo processada.", ephemeral: true });
  }
  try {
    const recentMessages = await context.channel.messages.fetch({ limit: 100 }).catch(() => null);
    const latest = findLatestProofAttachment(recentMessages || [], order.userId, { maxBytes: proofMaxBytes() });
    if (!latest) {
      return actionReply(context, {
        content: "Envie uma imagem ou um arquivo PDF do comprovante antes de confirmar o pagamento.",
        ephemeral: true
      });
    }
    if (replacement && latest.message.id === order.lastRejectedProofMessageId) {
      return actionReply(context, {
        content: "Envie um novo comprovante em imagem ou PDF antes de confirmar novamente.",
        ephemeral: true
      });
    }
    let proof;
    try {
      proof = await downloadAndValidateProof(latest.attachment, { maxBytes: proofMaxBytes() });
    } catch (error) {
      return actionReply(context, {
        content: error.message || "Nao foi possivel validar o comprovante mais recente.",
        ephemeral: true
      });
    }
    const panel = getOrderPanel(order, order.guildId);
    if (replacement && Number(order.paymentSnapshot?.automaticUnits) > 0 && !order.stockReservedAt) {
      const snapshot = serverOrderSnapshot(order);
      if (snapshot.hash !== order.paymentSnapshot?.hash || snapshot.totalCents !== order.totalCentsSnapshot) {
        return actionReply(context, { content: "O produto ou valor mudou. Cancele este carrinho e gere um pedido novo.", ephemeral: true });
      }
      try {
        const reservedIds = await reserveAutomaticStockForOrder(order, panel, snapshot);
        if (reservedIds.length) order.stockReservedAt = new Date().toISOString();
      } catch {
        return actionReply(context, {
          content: "Nao consegui reservar novamente o estoque deste pedido. Chame um administrador.",
          ephemeral: true
        });
      }
    }
    const now = new Date().toISOString();
    const savedProof = {
      url: latest.attachment.url,
      proxyUrl: latest.attachment.proxyURL || latest.attachment.proxyUrl || "",
      name: latest.attachment.name || safeProofFilename(order.id, proof),
      contentType: proof.contentType,
      kind: proof.kind,
      extension: proof.extension,
      size: proof.size,
      messageId: latest.message.id,
      submittedAt: now,
      submittedById: order.userId,
      requestedById: actor.id
    };
    if (!Array.isArray(order.paymentProofs)) order.paymentProofs = [];
    if (!order.paymentProofs.some(item => item.messageId === savedProof.messageId && item.url === savedProof.url)) {
      order.paymentProofs.push(savedProof);
    }
    order.paymentProofSubmittedAt = now;
    order.paymentProofLatestUrl = savedProof.url;
    order.paymentProofLatestMessageId = savedProof.messageId;
    order.paymentState = PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW;
    order.paymentStatus = "proof_received";
    delete order.manualPaymentAwaitingReplacement;
    touchOrder(order);
    db.orders[order.id] = order;
    writeOrders(db);
    await persistOrderRelationalAsync(db, order, panel);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    await refreshManualPaymentMessage(order, context.channel);
    if (replacement && order.manualPaymentNotificationSentAt) {
      await context.channel.send({
        content: `<@${order.userId}> o novo comprovante foi recebido e voltou para analise.`,
        allowedMentions: { users: [order.userId] }
      }).catch(() => null);
      return actionReply(context, {
        content: "Novo comprovante recebido. O responsavel ja havia sido notificado e pode analisar o novo arquivo.",
        ephemeral: true
      });
    }
    try {
      const notification = await sendManualProofNotification(orderNotificationInput(order, panel, {
        idempotencyKey: `manual:${order.id}`,
        attachment: {
          buffer: proof.buffer,
          contentType: proof.contentType,
          filename: safeProofFilename(order.id, proof)
        }
      }));
      if (!notification.sent) {
        return actionReply(context, {
          content: "O comprovante foi salvo para analise, mas o ntfy ainda nao esta configurado. Um ADM pode aprovar ou tentar o aviso novamente.",
          ephemeral: true
        });
      }
    } catch (error) {
      console.warn(`Falha ao encaminhar comprovante do pedido #${order.id} ao ntfy: ${errorSummary(error).message}`);
      return actionReply(context, {
        content: "O comprovante foi salvo para analise, mas nao consegui avisar o responsavel agora. Um ADM pode aprovar ou tentar novamente.",
        ephemeral: true
      });
    }
    order.manualPaymentNotificationSentAt = now;
    order.manualPaymentNotificationSentBy = actor.id;
    order.manualPaymentNotificationProofMessageId = savedProof.messageId;
    recordManualNotification(db, order.guildId, actor.id, new Date(now));
    touchOrder(order);
    db.orders[order.id] = order;
    writeOrders(db);
    await persistOrderRelationalAsync(db, order, panel);
    await refreshCartMessage(context.guild, order, panel, context.channel);
    await refreshManualPaymentMessage(order, context.channel);
    await context.channel.send({
      content: `<@${order.userId}> seu comprovante foi enviado para analise. Aguarde a confirmacao do responsavel.`,
      allowedMentions: { users: [order.userId] }
    }).catch(() => null);
    return actionReply(context, {
      content: "Seu comprovante foi enviado para analise. Aguarde a confirmacao do responsavel.",
      ephemeral: true
    });
  } finally {
    releaseOrderActionLock(order);
  }
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
  if ([PAYMENT_STATE.PAID, PAYMENT_STATE.MANUAL_PAYMENT_APPROVED, PAYMENT_STATE.DELIVERING, PAYMENT_STATE.DELIVERED, PAYMENT_STATE.PAID_DELIVERY_PENDING].includes(order.paymentState)) {
    return actionReply(interaction, { content: "O pagamento ja foi confirmado; este pedido nao pode ser cancelado por este botao.", ephemeral: true });
  }
  if (actor.id !== order.userId && !isAdmin(interaction.member)) return actionReply(interaction, { content: "Sem permissao para cancelar esse carrinho.", ephemeral: true });

  const panel = getOrderPanel(order, guildId);
  const now = new Date().toISOString();
  order.status = ORDER_STATUS.CANCELLED;
  order.cancelledAt = now;
  order.closedAt = now;
  order.cancelledById = actor.id;
  order.cancelledByName = interaction.member?.displayName || actor.username;
  order.paymentState = PAYMENT_STATE.CANCELED;
  if (order.stockReservedAt && postgresEnabled()) {
    await releaseOrderStock(getPostgresPool(), order.id);
    order.stockReleasedAt = now;
    delete order.stockReservedAt;
  }
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
  const closedCategoryId = categoryId(interaction.guildId, "closed");
  if (closedCategoryId) await interaction.channel.setParent(closedCategoryId, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  scheduleCartDeletion(order);
  await refreshCartMessage(interaction.guild, order, panel, interaction.channel);
  await refreshManualPaymentMessage(order, interaction.channel);
  await interaction.channel.send({ content: `<@${order.userId}> Compra #${order.id} cancelada. Este canal sera apagado em instantes.` }).catch(() => null);
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
  if (config.settings.finalizeCartOnlyAdmins && !isAdmin(interaction.member)) return actionReply(interaction, { content: "So ADM pode finalizar. Aguarde o atendimento da equipe.", ephemeral: true });
  if (!Array.isArray(order.items) || !order.items.length) {
    return actionReply(interaction, { content: "Esse carrinho ainda esta vazio. Adicione um produto antes de finalizar.", ephemeral: true });
  }
  if (order.paymentFlowVersion >= 2) {
    if (!order.paymentMethod) return actionReply(interaction, { content: "Gere o pagamento pelo botao **Gerar pagamento** antes de finalizar.", ephemeral: true });
    const paidStates = [PAYMENT_STATE.MANUAL_PAYMENT_APPROVED, PAYMENT_STATE.PAID, PAYMENT_STATE.DELIVERED, PAYMENT_STATE.PAID_DELIVERY_PENDING];
    if (!paidStates.includes(order.paymentState)) return actionReply(interaction, { content: `O pagamento ainda nao foi confirmado: ${paymentStatusLabel(order)}.`, ephemeral: true });
    const totalUnits = (order.paymentSnapshot?.items || []).reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
    const manualUnits = Math.max(0, totalUnits - (Number(order.paymentSnapshot?.automaticUnits) || 0));
    if (order.paymentState === PAYMENT_STATE.PAID_DELIVERY_PENDING && order.stockReservedAt && !order.automaticStockDeliveredAt) {
      return actionReply(interaction, { content: "A entrega automatica ainda esta pendente. Use **Entregar** para tentar novamente antes de finalizar.", ephemeral: true });
    }
    if (manualUnits > 0 && !order.deliveredAt) return actionReply(interaction, { content: "Este pedido ainda possui item de entrega manual. Use **Entregar** antes de finalizar.", ephemeral: true });
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
  const closedCategoryId = categoryId(interaction.guildId, "closed");
  if (closedCategoryId) await interaction.channel.setParent(closedCategoryId, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  const roleGranted = await grantCustomerRole(interaction.guild, order.userId);
  await sendCompletionReceipt(interaction.guild, order, panel, interaction.channel).catch(error => console.log(`Nao consegui enviar recibo da venda ${order.id}: ${error.message}`));
  await sendSuccessFeed(interaction.guild, order, panel).catch(error => console.log(`Nao consegui enviar feed da venda ${order.id}: ${error.message}`));
  await updateRevenueDashboard(interaction.guild).catch(error => console.log(`Nao consegui atualizar faturamento da venda ${order.id}: ${error.message}`));
  scheduleCartDeletion(order);
  const thanks = config.messages.purchaseThanks.replaceAll("{id}", order.id);
  const extraEmbed = mysteryResultsEmbed(mysteryResults, panel);
  const reviewResult = options.requestReview
    ? await sendReviewRequest(interaction, order, options).catch(error => ({ ok: false, message: `Nao consegui enviar avaliacao: ${error.message}` }))
    : null;
  await refreshCartMessage(interaction.guild, order, panel, interaction.channel);
  await refreshManualPaymentMessage(order, interaction.channel);
  await interaction.channel.send({ content: `<@${order.userId}> ${thanks}\nEste canal sera apagado automaticamente em ${closedCartDeleteLabel()}.`, embeds: [extraEmbed].filter(Boolean) });

  const customerTranscript = await buildCustomerTranscriptAttachment(interaction.channel, order, panel).catch(error => {
    console.log(`Nao consegui gerar historico para o cliente no pedido ${order.id}: ${error.message}`);
    return null;
  });

  const receiptDmSent = await sendSafeDM(order.userId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Compra finalizada")
        .setDescription(`${thanks}

**Resumo da compra:**
Total: **${totalLine(order, panel)}**
${discountLine(order) ? `\n${discountLine(order)}` : ""}

${cartText(order, panel)}

${customerTranscript ? "O histórico completo do carrinho está anexado nesta mensagem." : ""}`.slice(0, 4096))
        .setColor(parseColor(panel.color))
        .setTimestamp(),
      extraEmbed
    ].filter(Boolean),
    files: customerTranscript ? [customerTranscript] : []
  });
  if (!receiptDmSent && customerTranscript) {
    await interaction.channel.send({
      content: `<@${order.userId}> sua DM está fechada. Baixe o histórico abaixo antes da exclusão deste canal.`,
      files: [customerTranscript],
      allowedMentions: { users: [order.userId] }
    }).catch(() => null);
  }

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
  const channelId = ticketPanelChannelId(interaction.guildId);
  const ch = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
  if (!ch || !ch.isTextBased()) return interaction.reply({ content: "Configure o canal do painel de suporte em /configserver > Canais.", ephemeral: true });
  const btn = new ButtonBuilder().setCustomId("openticket").setLabel(config.ticketPanel.buttonLabel).setEmoji(config.ticketPanel.buttonEmoji).setStyle(ButtonStyle.Primary);
  await ch.send({ embeds: [ticketPanelEmbed()], components: [new ActionRowBuilder().addComponents(btn)] });
  return interaction.reply({ content: `Painel de ticket enviado em <#${ch.id}>.`, ephemeral: true });
}
async function openTicket(interaction) {
  const id = orderId("ticket");
  const ch = await privateChannel(interaction.guild, interaction.user, `ticket-${safeName(interaction.user.username)}-aberto-${id}`, categoryId(interaction.guildId, "ticketOpen") || categoryId(interaction.guildId, "cartOpen") || undefined);
  const now = new Date().toISOString();
  const db = readOrders(); db.tickets[id] = { id, status: "open", guildId: interaction.guildId, userId: interaction.user.id, username: interaction.user.username, channelId: ch.id, createdAt: now, lastInteractionAt: now, closedAt: null }; writeOrders(db);
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

  const attachments = [...message.attachments.values()];
  if (!attachments.length) return false;
  const candidate = attachments
    .map(attachment => ({ attachment, validation: validateProofMetadata(attachment, { maxBytes: proofMaxBytes() }) }))
    .find(item => item.validation.ok);
  if (!candidate) {
    const firstFailure = validateProofMetadata(attachments[0], { maxBytes: proofMaxBytes() });
    await message.reply(firstFailure.message).catch(() => null);
    return true;
  }
  const attachment = candidate.attachment;
  let validatedProof;
  try {
    validatedProof = await downloadAndValidateProof(attachment, { maxBytes: proofMaxBytes() });
  } catch (error) {
    await message.reply(error.message || "Nao foi possivel validar o comprovante enviado.").catch(() => null);
    return true;
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
  if (order.paymentMethod !== PAYMENT_METHOD.MANUAL_PIX) {
    paymentProofUploads.delete(key);
    await message.reply("Este pedido nao aceita comprovante manual.").catch(() => null);
    return true;
  }

  const panel = getOrderPanel(order, message.guild.id);
  const now = new Date().toISOString();
  const proof = {
    url: attachment.url,
    proxyUrl: attachment.proxyURL || attachment.proxyUrl || "",
    name: attachment.name || "comprovante",
    contentType: validatedProof.contentType,
    kind: validatedProof.kind,
    extension: validatedProof.extension,
    size: validatedProof.size,
    messageId: message.id,
    submittedAt: now,
    submittedById: message.author.id,
    requestedById: pending.requestedById || ""
  };
  if (!Array.isArray(order.paymentProofs)) order.paymentProofs = [];
  order.paymentProofs.push(proof);
  order.paymentProofSubmittedAt = now;
  order.paymentProofLatestUrl = attachment.url;
  if (Number(order.paymentFlowVersion || 0) < 3 || order.manualPaymentNotificationSentAt) {
    order.paymentState = PAYMENT_STATE.MANUAL_PAYMENT_UNDER_REVIEW;
  }
  if (!order.paymentStatus || ["pending", "proof_uploaded"].includes(order.paymentStatus)) {
    order.paymentStatus = order.manualPaymentNotificationSentAt ? "proof_received" : "proof_uploaded";
  }
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

  await refreshCartMessage(message.guild, order, panel, message.channel);
  await message.reply({
    content: Number(order.paymentFlowVersion || 0) >= 3 && !order.manualPaymentNotificationSentAt
      ? `Comprovante valido recebido. Agora clique em **Ja fiz o pagamento** para avisar o responsavel pelo pedido #${order.id}.`
      : `Comprovante recebido e salvo. A equipe vai conferir o pedido #${order.id}.`,
    allowedMentions: { parse: [] }
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

function statusVoiceChannelId(guildId = "") {
  const saved = guildId ? serverConfig(guildId).statusVoiceChannelId : "";
  return String(saved || process.env.STATUS_VOICE_CHANNEL_ID || legacyStoreValue(config.statusVoice?.channelId, DEFAULT_STATUS_VOICE_CHANNEL_ID)).trim();
}
function statusVoiceEnabled(guildId = "") {
  if (process.env.STATUS_VOICE_ENABLED === "false") return false;
  const saved = guildId ? serverConfig(guildId).statusVoiceEnabled : undefined;
  if (typeof saved === "boolean") return saved;
  return config.statusVoice?.enabled !== false;
}
function scheduleStatusVoiceReconnect(guildId, delayMs = 30000) {
  const key = String(guildId || "");
  if (!key || statusVoiceReconnectTimers.has(key) || !statusVoiceEnabled(key)) return;
  const timer = setTimeout(() => {
    statusVoiceReconnectTimers.delete(key);
    connectStatusVoiceChannel(key).catch(error => {
      console.log(`Nao consegui reconectar na call de status: ${error.message}`);
      scheduleStatusVoiceReconnect(key);
    });
  }, delayMs);
  statusVoiceReconnectTimers.set(key, timer);
}
function clearStatusVoiceReconnect(guildId) {
  const key = String(guildId || "");
  const timer = statusVoiceReconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  statusVoiceReconnectTimers.delete(key);
}
function watchStatusVoiceConnection(connection, guildId) {
  if (connection.__dragonStoreStatusWatcher) return;
  connection.__dragonStoreStatusWatcher = true;
  connection.on("stateChange", (_, state) => {
    if (state.status === VoiceConnectionStatus.Destroyed || state.status === VoiceConnectionStatus.Disconnected) {
      scheduleStatusVoiceReconnect(guildId, state.status === VoiceConnectionStatus.Disconnected ? 10000 : 30000);
    }
  });
  connection.on("error", error => {
    console.log(`Erro na call de status: ${error.message}`);
    scheduleStatusVoiceReconnect(guildId, 15000);
  });
}
async function disconnectStatusVoiceChannel(guildId) {
  clearStatusVoiceReconnect(guildId);
  const existing = getVoiceConnection(String(guildId || ""));
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) existing.destroy();
}
async function connectStatusVoiceChannel(guildOrId) {
  const guildId = typeof guildOrId === "string" ? guildOrId : guildOrId?.id || "";
  if (!guildId || !statusVoiceEnabled(guildId)) {
    if (guildId) await disconnectStatusVoiceChannel(guildId);
    return null;
  }
  const channelId = statusVoiceChannelId(guildId);
  if (!channelId) return null;

  const guild = typeof guildOrId === "string" ? client.guilds.cache.get(guildId) : guildOrId;
  const channel = guild?.channels?.cache?.get(channelId) ||
    await guild?.channels?.fetch(channelId).catch(() => null) ||
    client.channels.cache.get(channelId) ||
    await client.channels.fetch(channelId).catch(() => null);
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
    watchStatusVoiceConnection(existing, channel.guild.id);
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
  watchStatusVoiceConnection(connection, channel.guild.id);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    clearStatusVoiceReconnect(channel.guild.id);
    console.log(`Bot entrou na call de status: ${channel.name || channel.id}`);
  } catch (error) {
    const currentStatus = connection.state?.status || "desconhecido";
    console.log(`Call de status ${channel.name || channel.id} ainda nao confirmou Ready (${error.message}); mantendo conexao em estado ${currentStatus}.`);
    if (currentStatus === VoiceConnectionStatus.Destroyed) scheduleStatusVoiceReconnect(channel.guild.id, 30000);
    else scheduleStatusVoiceReconnect(channel.guild.id, 60000);
  }
  return connection;
}

client.once("clientReady", async () => {
  console.log(`Bot online como ${client.user.tag}`);
  const install = instanceConfig.installationSummary();
  console.log(`Instancia da loja: ${install.instanceId} | servidor: ${install.guildId || "nao travado"} | storage: ${BOT_DB_PREFIX}`);
  const recoveredProcessing = recoverStaleProcessingOrders();
  if (recoveredProcessing) console.log(`${recoveredProcessing} carrinho(s) preso(s) em processing foram reabertos automaticamente.`);
  for (const guild of client.guilds.cache.values()) {
    if (!instanceConfig.acceptsGuild(guild.id)) continue;
    const backfilled = await backfillLegacyActivity(guild).catch(error => {
      console.warn(`Nao consegui recuperar atividade antiga em ${guild.id}: ${errorSummary(error).message}`);
      return 0;
    });
    if (backfilled) console.log(`${backfilled} carrinho(s)/ticket(s) tiveram a atividade antiga recuperada.`);
    await ensureStaffState(guild, null).catch(error => {
      console.log(`Nao consegui recuperar atendimento em ${guild.id}: ${error.message}`);
    });
    await connectStatusVoiceChannel(guild).catch(error => {
      console.log(`Nao consegui entrar na call de status em ${guild.id}: ${error.message}`);
      scheduleStatusVoiceReconnect(guild.id);
    });
    await refreshStaffPanel(guild.id).catch(() => null);
    await updateRevenueDashboard(guild).catch(error => {
      console.log(`Nao consegui atualizar painel de faturamento em ${guild.id}: ${error.message}`);
    });
    const refreshedOrders = await refreshOpenOrderInterfaces(guild).catch(error => {
      console.warn(`Nao consegui atualizar interfaces de carrinhos em ${guild.id}: ${errorSummary(error).message}`);
      return 0;
    });
    if (refreshedOrders) console.log(`${refreshedOrders} mensagem(ns) Pix antiga(s) foram recuperadas em ${guild.id}.`);
    const panelStore = readPanels();
    const guildStore = ensurePanelStore(panelStore, guild.id);
    const permissionWarnings = await discordPermissionWarnings(guild, allPublicPanels(guildStore), getStaffGuild(guild.id)).catch(error => [`Falha ao validar permissoes: ${error.message}`]);
    if (permissionWarnings.length) {
      console.log(`Alertas de permissao em ${guild.name || guild.id}:\n- ${permissionWarnings.join("\n- ")}`);
    }
  }
  scheduleExistingClosedCarts();
  const db = readOrders();
  Object.values(db.tickets || {}).forEach(scheduleInactiveTicketDeletion);
  await sweepInactiveCarts().catch(error => console.error("Falha na verificacao inicial de inatividade:", errorSummary(error)));
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (!instanceConfig.acceptsGuild(message.guild.id)) return;
  await recordHumanActivity(message.guild.id, message.channel.id, message.createdAt).catch(error => {
    console.warn(`Nao consegui salvar atividade humana no canal ${message.channel.id}: ${errorSummary(error).message}`);
  });
  if (await handlePaymentProofUpload(message)) return;
  if (await handlePendingImageUpload(message)) return;
  const rawContent = message.content.trim();
  const content = rawContent.toLowerCase();
  const plainContent = content.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const prefix = config.prefix || "!";

  if (content === `${config.prefix || "!"}help`) {
    return sendHelpCommand(message);
  }

  if (content === `${prefix}verificacao` || content === `${prefix}verificação`) {
    return sendVerificationPanel(message);
  }

  if (content === `${prefix}verificados`) {
    return sendVerifiedCount(message);
  }

  if (content === `${prefix}puxarbackup`) {
    return pullBackupCommand(message);
  }

  if (content === `${prefix}backup`) {
    return createFullServerBackupCommand(message);
  }

  if (content === `${prefix}restaurar`) {
    return startFullServerRestoreCommand(message, message.attachments.first());
  }

  if (content === `${prefix}setup-loja`) {
    await message.delete().catch(() => null);
    return showAutomaticSetup(message);
  }

  if (content === `${prefix}exportarloja`) {
    return exportStoreCatalog(message);
  }

  if (content === `${prefix}importarloja` || content.startsWith(`${prefix}importarloja `)) {
    const selector = rawContent.slice(`${prefix}importarloja`.length).trim();
    return importStoreCatalog(message, message.attachments.first(), selector);
  }

  if ([`${config.prefix || "!"}configds`, `${config.prefix || "!"}painel`, `${config.prefix || "!"}loja`, `${config.prefix || "!"}setup`].includes(content)) {
    await message.delete().catch(() => null);
    const sent = await message.author.send("Use `/configds` no canal do painel. O configurador será privado e aparecerá somente para você.").catch(() => null);
    if (sent) return sent;
    const notice = await message.channel.send(`<@${message.author.id}> use \`/configds\`; o configurador privado não pode ser aberto por comando com \`!\`.`).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 10_000);
    return notice;
  }

  if (content === `${config.prefix || "!"}configds2`) {
    await message.delete().catch(() => null);
    const sent = await message.author.send("Use `/configds2` no canal onde o painel será publicado. O Discord abrirá o template somente para você.").catch(() => null);
    if (sent) return sent;
    const notice = await message.channel.send(`<@${message.author.id}> use \`/configds2\` neste canal para abrir o criador rápido privado.`).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 10_000);
    return notice;
  }

  if (content === `${config.prefix || "!"}configserver`) {
    await message.delete().catch(() => null);
    return showServerConfig(message);
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

  if ([`${config.prefix || "!"}pago`, `${config.prefix || "!"}marcarpago`, `${config.prefix || "!"}pagamento`, `${config.prefix || "!"}verificarpagamento`, `${config.prefix || "!"}verificarpix`].includes(content)) {
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

  if (content.startsWith(`${prefix}setupfaturamento`)) {
    await message.delete().catch(() => null);
    const listEnabled = /\b(lista|detalhes|on|sim)\b/i.test(rawContent)
      ? true
      : /\b(resumo|off|nao)\b/i.test(plainContent)
        ? false
        : undefined;
    return setupRevenueDashboard(message, { listEnabled });
  }

  if (content === `${prefix}faturamento`) {
    if (!isAdmin(message.member)) return message.reply("So ADM pode ver o faturamento.");
    await message.delete().catch(() => null);
    return message.channel.send({ embeds: [revenueDashboardEmbed(message.guild.id)], components: revenueDashboardRows(message.guild.id) });
  }

  if (content.startsWith(`${prefix}pedido `)) {
    return showWebOrder(message, rawContent.slice(`${prefix}pedido`.length).trim());
  }

  if (plainContent.startsWith(`${config.prefix || "!"}avaliacao`)) {
    if (!isAdmin(message.member)) return message.reply("So ADM pode finalizar compra com pedido de avaliacao.");
    const options = reviewOptionsFromText(rawContent);
    await message.delete().catch(() => null);
    return finishCurrentCartWithReview(message, options);
  }

  if (content === `${config.prefix || "!"}configpix`) {
    if (!isBotOwner(message.author)) return message.reply("Somente BOT_OWNER_IDS pode configurar Pix.");
    await message.delete().catch(() => null);
    const reply = await message.channel.send({
      content: `<@${message.author.id}> clique no botão abaixo para abrir o formulário do Pix. Se o Discord não mostrar os comandos com \`/\`, esse botão resolve.`,
      components: pixShortcutRows()
    });
    setTimeout(() => reply.delete().catch(() => null), 2 * 60 * 1000);
    return;
  }

  if (content === `${config.prefix || "!"}togglepagbank`) {
    await message.delete().catch(() => null);
    return togglePagBankCommand(message);
  }
  if (content.startsWith(`${config.prefix || "!"}configpagamento `)) {
    await message.delete().catch(() => null);
    return configurePaymentProvider(message, rawContent.split(/\s+/)[1]?.toLowerCase());
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
  if (content === `${config.prefix || "!"}testntfy`) {
    await message.delete().catch(() => null);
    return testNtfyCommand(message);
  }
  if (content.startsWith(`${config.prefix || "!"}reconciliarpagbank `)) {
    await message.delete().catch(() => null);
    return reconcilePagBankCommand(message, rawContent.split(/\s+/)[1]);
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
    if (interaction.guildId && !instanceConfig.acceptsGuild(interaction.guildId)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "Esta instalacao do bot pertence a outra loja.", ephemeral: true }).catch(() => null);
      }
      return;
    }
    if (interaction.guildId && interaction.channelId && interaction.user && !interaction.user.bot) {
      recordHumanActivity(interaction.guildId, interaction.channelId, new Date(interaction.createdTimestamp || Date.now()))
        .catch(error => console.warn(`Nao consegui salvar atividade da interacao em ${interaction.channelId}: ${errorSummary(error).message}`));
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "help") return sendHelpCommand(interaction);
      if (interaction.commandName === "configds") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para abrir o configurador da loja.")) return;
        return startConfig(interaction);
      }
      if (interaction.commandName === "configds2") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para criar um painel rápido.")) return;
        return interaction.showModal(quickPanelConfigModal());
      }
      if (interaction.commandName === "configserver") return showServerConfig(interaction);
      if (interaction.commandName === "setup-loja") return showAutomaticSetup(interaction);
      if (interaction.commandName === "backup") return createFullServerBackupCommand(interaction);
      if (interaction.commandName === "restaurar") return startFullServerRestoreCommand(interaction, interaction.options.getAttachment("arquivo"));
      if (interaction.commandName === "exportarloja") return exportStoreCatalog(interaction);
      if (interaction.commandName === "importarloja") {
        return importStoreCatalog(
          interaction,
          interaction.options.getAttachment("arquivo"),
          interaction.options.getString("painel") || ""
        );
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
      if (interaction.commandName === "setupfaturamento") {
        return setupRevenueDashboard(interaction, {
          channel: interaction.options.getChannel("canal") || interaction.channel,
          listEnabled: interaction.options.getBoolean("mostrar-lista") ?? undefined
        });
      }
      if (interaction.commandName === "faturamento") {
        if (!await requireAdminInteraction(interaction, "So ADM pode ver o faturamento.")) return;
        return interaction.reply({ embeds: [revenueDashboardEmbed(interaction.guildId)], ephemeral: true });
      }
      if (interaction.commandName === "pedido") return showWebOrder(interaction, interaction.options.getString("codigo"));
      if (interaction.commandName === "avaliacao") {
        const reviewChannel = interaction.options.getChannel("canal");
        const reviewMessage = interaction.options.getString("mensagem") || "";
        return finishCurrentCartWithReview(interaction, {
          reviewChannelId: reviewChannel?.id || "",
          reviewMessage
        });
      }
      if (interaction.commandName === "configpix") {
        if (!await requireBotOwner(interaction, "Somente BOT_OWNER_IDS pode configurar Pix.")) return;
        await ensureStaffState(interaction.guild, interaction.channel);
        return interaction.showModal(pixConfigModal(interaction.guildId, interaction.user));
      }
      if (interaction.commandName === "togglepagbank") return togglePagBankCommand(interaction);
      if (interaction.commandName === "configpagamento") return configurePaymentProvider(interaction, interaction.options.getString("provedor"));
      if (interaction.commandName === "status-loja") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para ver o status da loja.")) return;
        return interaction.reply({ embeds: [buildStoreStatusEmbed(interaction.guildId, interaction.channelId)], ephemeral: true });
      }
      if (interaction.commandName === "pedidos") return showOpenOrders(interaction);
      if (interaction.commandName === "diagnostico") return sendDiagnosticsCommand(interaction);
      if (interaction.commandName === "testntfy") return testNtfyCommand(interaction);
      if (interaction.commandName === "reconciliarpagbank") return reconcilePagBankCommand(interaction, interaction.options.getString("order_id"));
      if (interaction.commandName === "reconciliarmercadopago") return reconcileMercadoPagoCommand(interaction, interaction.options.getString("payment_id"));
      if (["pago", "verificarpagamento"].includes(interaction.commandName)) {
        const order = findOrderInChannel(readOrders(), interaction, false);
        if (!order) return actionReply(interaction, { content: "Nao encontrei carrinho neste canal.", ephemeral: true });
        return markOrderPaid(interaction, order.id);
      }
      if (interaction.commandName === "entregar") {
        const order = findOrderInChannel(readOrders(), interaction, false);
        if (!order) return actionReply(interaction, { content: "Nao encontrei carrinho neste canal.", ephemeral: true });
        return requestDelivery(interaction, order.id);
      }
      if (["addcar", "addproduto"].includes(interaction.commandName)) {
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
      if (interaction.customId.startsWith("stock:")) return handleStockButton(interaction);
      if (interaction.customId.startsWith("autosetup:")) return handleAutomaticSetupButton(interaction);
      if (interaction.customId.startsWith("serverrestore:")) return handleServerRestoreButton(interaction);
      if (interaction.customId.startsWith("rmconfirm:")) return handleRemoveConfirm(interaction);
      if (interaction.customId.startsWith("rmcancel:")) return handleRemoveCancel(interaction);
      if (interaction.customId.startsWith("cfg:")) return handleConfigButton(interaction);
      if (interaction.customId.startsWith("cfgsrv:")) return handleServerConfigButton(interaction);
      if (interaction.customId.startsWith("staff:")) return handleStaffButton(interaction);
      if (interaction.customId.startsWith("addcar:")) return handleAddCartButton(interaction);
      if (interaction.customId.startsWith("rank:")) {
        const [, period, page] = interaction.customId.split(":");
        return showSpendRanking(interaction, period, Number(page) || 0);
      }
      if (interaction.customId.startsWith("orders:")) return handleOpenOrdersButton(interaction);
      if (interaction.customId.startsWith("revenue:")) return handleRevenueButton(interaction);
      if (interaction.customId.startsWith("quickbuy:")) {
        const [, panelId] = interaction.customId.split(":");
        return handleQuickBuyButton(interaction, panelId);
      }
      if (interaction.customId === "openticket") return openTicket(interaction);
      const [act, id] = interaction.customId.split(":");
      if (act === "addproduct") return startAddCartFlow(interaction);
      if (act === "pay") return showPaymentMethodChoice(interaction, id);
      if (act === "payauto") return selectPaymentMethod(interaction, id, "automatic");
      if (act === "paymanual") return selectPaymentMethod(interaction, id, "manual");
      if (act === "call") return callAdmin(interaction, id, "order");
      if (act === "view") return viewCart(interaction, id);
      if (act === "paid") return markOrderPaid(interaction, id);
      if (act === "proof") return requestPaymentProof(interaction, id);
      if (act === "manualconfirm") return confirmManualPaymentNotification(interaction, id);
      if (act === "deliver") return requestDelivery(interaction, id);
      if (act === "finish") return finishCart(interaction, id);
      if (act === "cancel") return cancelCart(interaction, id);
      if (act === "assume") return assumeOrder(interaction, id);
      if (act === "sendpix") return resendPix(interaction, id);
      if (act === "rejectpay") return rejectManualPayment(interaction, id);
      if (act === "newproof") return requestNewManualProof(interaction, id);
      if (act === "retrydelivery") return retryAutomaticDelivery(interaction, id);
      if (act === "tcall") return callAdmin(interaction, id, "ticket");
      if (act === "tclose") return closeTicket(interaction, id);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("stockmodal:")) return handleStockModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("paycustomer:")) return handlePagBankCustomerSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId === "quickcfgmodal") return handleQuickPanelConfigModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId === "pixmodal") return handlePixModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("cfgsrvmodal:")) return handleServerConfigModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("addcarsearch:")) return handleAddCartSearchSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("addcarqty:")) return handleAddCartQuantitySubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("quickmodal:")) return handleQuickOrderSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("deliverymodal:")) {
      const [, id] = interaction.customId.split(":");
      return deliverOrder(interaction, id, interaction.fields.getTextInputValue("delivery"));
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal:")) return handleModal(interaction);
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("stockproduct:")) return handleStockProductSelect(interaction);
      if (interaction.customId.startsWith("stockremove:")) return handleStockRemoveSelect(interaction);
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
  const summary = errorSummary(err);
  if ([10062, 40060].includes(Number(summary.code))) {
    console.warn(`Interacao ignorada (${summary.code}): ${summary.message}`);
    return;
  }
  console.error("Falha ao processar interacao:", summary);
  const safeMessage = summary.message.replace(/`/g, "'").slice(0, 1500);
  const payload = { content: `Erro: \`${safeMessage}\``, ephemeral: true };
  await actionReply(interaction, payload).catch(() => null);
}

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("DISCORD_TOKEN não configurado.");
  process.exit(1);
}
function shutdown(signal) {
  console.log(`${signal} recebido; salvando persistencia pendente antes de sair.`);
  clearInterval(ephemeralCleanupTimer);
  clearInterval(paymentExpiryTimer);
  clearInterval(mercadoPagoReconcileTimer);
  clearInterval(inactivitySweepTimer);
  for (const timer of cartDeleteTimers.values()) clearTimeout(timer);
  for (const timer of ticketDeleteTimers.values()) clearTimeout(timer);
  oauthHttp?.server?.close?.(() => null);
  drainPersistentWriteQueues()
    .finally(() => closePostgresPool())
    .finally(() => process.exit(0));
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
async function boot() {
  await hydratePersistentFiles();
  await client.login(token);
  if (!client.isReady()) {
    await Promise.race([
      new Promise(resolve => client.once("clientReady", resolve)),
      new Promise(resolve => setTimeout(resolve, 30_000))
    ]);
  }
  await sweepPendingMercadoPagoPayments().catch(error => console.error("Falha na reconciliacao inicial Mercado Pago:", errorSummary(error)));
  await sweepExpiredPayments().catch(error => console.error("Falha ao recuperar expiracoes:", errorSummary(error)));
}
boot().catch(error => {
  if (/Used disallowed intents/i.test(String(error?.message || ""))) {
    console.error("Discord recusou os intents. Ative Message Content Intent em Developer Portal > Bot > Privileged Gateway Intents, ou use ENABLE_MESSAGE_CONTENT_INTENT=false para operar apenas por slash commands.");
  }
  console.error("Falha ao iniciar bot:", errorSummary(error));
  process.exit(1);
});
