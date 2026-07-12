function parseOwnerIds(value) {
  return new Set(String(value || "")
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(item => /^\d{15,25}$/.test(item)));
}

function isAuthorizedOwner(userId, value = process.env.BOT_OWNER_IDS) {
  return Boolean(userId && parseOwnerIds(value).has(String(userId)));
}

function canApproveManualPayment(actorId, buyerId, value = process.env.BOT_OWNER_IDS) {
  return Boolean(actorId && buyerId && String(actorId) !== String(buyerId) && isAuthorizedOwner(actorId, value));
}

module.exports = { canApproveManualPayment, isAuthorizedOwner, parseOwnerIds };
