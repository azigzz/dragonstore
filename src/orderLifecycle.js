const DEFAULT_INACTIVITY_MS = 16 * 60 * 60 * 1000;
const DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

function validTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activityFallback(record, now = Date.now()) {
  return validTimestamp(record?.updatedAt) ??
    validTimestamp(record?.createdAt) ??
    now;
}

function initializeActivity(record, now = Date.now()) {
  if (!record || typeof record !== "object") return false;
  if (validTimestamp(record.lastInteractionAt) !== null) return false;
  record.lastInteractionAt = new Date(activityFallback(record, now)).toISOString();
  record.activityNeedsChannelBackfill = true;
  return true;
}

function markHumanActivity(record, at = new Date()) {
  if (!record || typeof record !== "object") return false;
  const timestamp = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(timestamp)) return false;
  const previous = validTimestamp(record.lastInteractionAt) || 0;
  if (timestamp < previous) return false;
  record.lastInteractionAt = new Date(timestamp).toISOString();
  delete record.activityNeedsChannelBackfill;
  return true;
}

function inactivityMs(env = process.env) {
  const hours = Number(env.CART_INACTIVITY_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_INACTIVITY_MS;
  return Math.max(60 * 1000, hours * 60 * 60 * 1000);
}

function isInactive(record, now = Date.now(), thresholdMs = DEFAULT_INACTIVITY_MS) {
  const last = validTimestamp(record?.lastInteractionAt) ?? activityFallback(record, now);
  return now - last >= thresholdMs;
}

function isManualInactivityCandidate(order) {
  if (!order || String(order.status || "") !== "open") return false;
  if (["PAGBANK_PIX", "MERCADOPAGO_PIX"].includes(String(order.paymentMethod || ""))) return false;
  const protectedStates = new Set([
    "MANUAL_PAYMENT_UNDER_REVIEW",
    "MANUAL_PAYMENT_APPROVED",
    "PAID",
    "DELIVERING",
    "DELIVERED",
    "PAID_DELIVERY_PENDING"
  ]);
  return !protectedStates.has(String(order.paymentState || ""));
}

function ensureManualNotificationRateLimits(store) {
  if (!store.manualNotificationRateLimits || typeof store.manualNotificationRateLimits !== "object" || Array.isArray(store.manualNotificationRateLimits)) {
    store.manualNotificationRateLimits = {};
  }
  return store.manualNotificationRateLimits;
}

function manualRateLimitKey(guildId, userId) {
  return `${String(guildId || "default")}:${String(userId || "")}`;
}

function manualNotificationCooldownMs(env = process.env) {
  const seconds = Number(env.MANUAL_NOTIFICATION_COOLDOWN_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS;
  return Math.max(1000, seconds * 1000);
}

function manualNotificationRemaining(store, guildId, userId, now = Date.now(), cooldownMs = DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS) {
  const limits = ensureManualNotificationRateLimits(store);
  const last = validTimestamp(limits[manualRateLimitKey(guildId, userId)]);
  if (last === null) return 0;
  return Math.max(0, last + cooldownMs - now);
}

function recordManualNotification(store, guildId, userId, at = new Date()) {
  const limits = ensureManualNotificationRateLimits(store);
  const timestamp = at instanceof Date ? at : new Date(at);
  limits[manualRateLimitKey(guildId, userId)] = timestamp.toISOString();
  return limits[manualRateLimitKey(guildId, userId)];
}

function paymentChoiceAvailability(totalCents, automaticConfigured) {
  const validTotal = Number.isSafeInteger(totalCents) && totalCents > 0;
  const minimumMet = validTotal && totalCents >= 100;
  return {
    manual: validTotal,
    automatic: minimumMet && Boolean(automaticConfigured),
    minimumMet,
    reason: !minimumMet
      ? "O Pix automatico esta disponivel somente a partir de R$ 1,00."
      : automaticConfigured
        ? ""
        : "O provedor de Pix automatico nao esta configurado."
  };
}

module.exports = {
  DEFAULT_INACTIVITY_MS,
  DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS,
  activityFallback,
  inactivityMs,
  initializeActivity,
  isInactive,
  isManualInactivityCandidate,
  manualNotificationCooldownMs,
  manualNotificationRemaining,
  markHumanActivity,
  paymentChoiceAvailability,
  recordManualNotification
};
