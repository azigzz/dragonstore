const assert = require("node:assert/strict");
const {
  DEFAULT_INACTIVITY_MS,
  DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS,
  initializeActivity,
  isInactive,
  isManualInactivityCandidate,
  manualNotificationRemaining,
  markHumanActivity,
  paymentChoiceAvailability,
  recordManualNotification
} = require("../src/orderLifecycle");

(() => {
  const createdAt = "2026-07-18T10:00:00.000Z";
  const order = { createdAt, updatedAt: "2026-07-18T11:00:00.000Z" };
  assert.equal(initializeActivity(order), true);
  assert.equal(order.lastInteractionAt, order.updatedAt);
  assert.equal(order.activityNeedsChannelBackfill, true);

  const beforeLimit = Date.parse(order.lastInteractionAt) + DEFAULT_INACTIVITY_MS - 60 * 1000;
  assert.equal(isInactive(order, beforeLimit), false);
  assert.equal(isInactive(order, Date.parse(order.lastInteractionAt) + DEFAULT_INACTIVITY_MS), true);

  const renewedAt = beforeLimit;
  assert.equal(markHumanActivity(order, renewedAt), true);
  assert.equal(isInactive(order, renewedAt + DEFAULT_INACTIVITY_MS - 1), false);
  assert.equal(isInactive(order, renewedAt + DEFAULT_INACTIVITY_MS), true);
  assert.equal(order.activityNeedsChannelBackfill, undefined);

  const persisted = JSON.parse(JSON.stringify(order));
  assert.equal(isInactive(persisted, renewedAt + DEFAULT_INACTIVITY_MS), true);

  const store = {};
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  assert.equal(manualNotificationRemaining(store, "guild", "user", now), 0);
  recordManualNotification(store, "guild", "user", new Date(now));
  assert.equal(manualNotificationRemaining(store, "guild", "user", now + 1000), DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS - 1000);
  assert.equal(manualNotificationRemaining(store, "guild", "user", now + DEFAULT_MANUAL_NOTIFICATION_COOLDOWN_MS), 0);
  const restartedStore = JSON.parse(JSON.stringify(store));
  assert.equal(manualNotificationRemaining(restartedStore, "guild", "user", now + 60_000) > 0, true);

  assert.deepEqual(paymentChoiceAvailability(99, true), {
    manual: true,
    automatic: false,
    minimumMet: false,
    reason: "O Pix automatico esta disponivel somente a partir de R$ 1,00."
  });
  assert.equal(paymentChoiceAvailability(100, true).automatic, true);
  assert.equal(paymentChoiceAvailability(100, false).automatic, false);
  assert.equal(paymentChoiceAvailability(100, false).manual, true);

  assert.equal(isManualInactivityCandidate({ status: "open", paymentMethod: "MANUAL_PIX", paymentState: "AWAITING_MANUAL_PAYMENT" }), true);
  assert.equal(isManualInactivityCandidate({ status: "open", paymentMethod: "MANUAL_PIX", paymentState: "MANUAL_PAYMENT_UNDER_REVIEW" }), false);
  assert.equal(isManualInactivityCandidate({ status: "open", paymentMethod: "MANUAL_PIX", paymentState: "MANUAL_PAYMENT_APPROVED" }), false);
  assert.equal(isManualInactivityCandidate({ status: "open", paymentMethod: "MERCADOPAGO_PIX", paymentState: "AWAITING_PAGBANK_PAYMENT" }), false);
  assert.equal(isManualInactivityCandidate({ status: "cancelled", paymentMethod: "MANUAL_PIX", paymentState: "AWAITING_MANUAL_PAYMENT" }), false);

  console.log("Order lifecycle and payment choice tests passed.");
})();
