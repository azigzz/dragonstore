const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  manualPaymentConfirmationMode,
  paymentChoiceAvailability
} = require("../src/orderLifecycle");

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `secao ${startMarker} nao encontrada`);
  return source.slice(start, end);
}

(() => {
  const initialManual = {
    id: "1234567",
    status: "open",
    paymentMethod: "MANUAL_PIX",
    paymentState: "AWAITING_MANUAL_PAYMENT"
  };
  assert.equal(manualPaymentConfirmationMode(initialManual), "initial");
  assert.equal(manualPaymentConfirmationMode({
    ...initialManual,
    paymentState: "MANUAL_PAYMENT_UNDER_REVIEW",
    manualPaymentNotificationSentAt: "2026-07-19T10:00:00.000Z"
  }), "disabled");
  assert.equal(manualPaymentConfirmationMode({
    ...initialManual,
    paymentState: "MANUAL_PAYMENT_REJECTED",
    manualPaymentNotificationSentAt: "2026-07-19T10:00:00.000Z",
    manualPaymentAwaitingReplacement: true
  }), "replacement");
  assert.equal(manualPaymentConfirmationMode({ ...initialManual, status: "cancelled" }), "disabled");
  assert.equal(manualPaymentConfirmationMode({
    ...initialManual,
    paymentMethod: "MERCADOPAGO_PIX"
  }), "disabled");

  assert.equal(paymentChoiceAvailability(99, true).automatic, false);
  assert.equal(paymentChoiceAvailability(99, true).manual, true);
  assert.equal(paymentChoiceAvailability(100, true).automatic, true);

  const source = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
  const cartRows = sourceSection(source, "function cartActionRows(", "async function sendCartMessage(");
  for (const removedAction of ["assume:", "proof:", "newproof:", "retrydelivery:", "call:", "manualconfirm:"]) {
    assert.equal(cartRows.includes(removedAction), false, `${removedAction} nao deve aparecer no painel principal`);
  }
  for (const expectedAction of ["addproduct:", "pay:", "cancel:", "paid:", "deliver:", "finish:"]) {
    assert.equal(cartRows.includes(expectedAction), true, `${expectedAction} deve continuar disponivel`);
  }

  const pixRows = sourceSection(source, "function manualPaymentActionRows(", "function manualPaymentEmbed(");
  assert.equal(pixRows.includes("manualconfirm:"), true, "confirmacao deve ficar abaixo do Pix");
  assert.equal(pixRows.includes("Ja fiz o pagamento"), true);
  assert.equal(pixRows.includes("Enviei novo comprovante"), true);

  const pixMessage = sourceSection(source, "async function sendOrRefreshManualPaymentMessage(", "async function refreshManualPaymentMessage(");
  assert.equal(pixMessage.includes("components: manualPaymentActionRows(order)"), true);
  assert.equal(pixMessage.includes("order.manualPaymentMessageId = message.id"), true);

  const rejection = sourceSection(source, "async function rejectManualPayment(", "async function requestNewManualProof(");
  assert.equal(rejection.includes("manualPaymentAwaitingReplacement = true"), true);
  assert.equal(rejection.includes("Enviei novo comprovante"), true);

  const delivery = sourceSection(source, "async function requestDelivery(", "async function deliverOrder(");
  assert.equal(delivery.includes("PAYMENT_STATE.PAID_DELIVERY_PENDING"), true);
  assert.equal(delivery.includes("retryAutomaticDelivery(interaction, id)"), true);

  console.log("Buyer/admin experience regression tests passed.");
})();
