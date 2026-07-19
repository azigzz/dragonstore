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
  assert.equal(cartRows.includes("Tentar pagamento"), true);
  assert.equal(cartRows.includes("automaticPaymentRecoveryAvailable(order)"), true);

  const pixRows = sourceSection(source, "function manualPaymentActionRows(", "function manualPaymentEmbed(");
  assert.equal(pixRows.includes("manualconfirm:"), true, "confirmacao deve ficar abaixo do Pix");
  assert.equal(pixRows.includes("Ja fiz o pagamento"), true);
  assert.equal(pixRows.includes("Enviei novo comprovante"), true);

  const pixMessage = sourceSection(source, "async function sendOrRefreshManualPaymentMessage(", "async function refreshManualPaymentMessage(");
  assert.equal(pixMessage.includes("components: manualPaymentActionRows(order)"), true);
  assert.equal(pixMessage.includes("order.manualPaymentMessageId = message.id"), true);

  const paymentChoice = sourceSection(source, "function paymentMethodChoicePayload(", "async function showPaymentMethodChoice(");
  assert.equal(paymentChoice.includes("PIX Automatico - precisa CPF"), true);
  assert.equal(paymentChoice.includes("PIX Manual"), true);
  assert.equal(paymentChoice.includes("incluindo CPF/CNPJ"), true);
  assert.equal(paymentChoice.includes("imagem ou PDF"), true);
  assert.equal(paymentChoice.includes(".setDisabled(!availability.automatic)"), true);

  const privateCustomerModal = sourceSection(source, "function pagBankCustomerModal(", "function automaticPaymentMethodForGuild(");
  assert.equal(privateCustomerModal.includes("CPF/CNPJ privado exigido pelo provedor"), true);
  assert.equal(privateCustomerModal.includes("Nao sera exibido no canal"), true);
  assert.equal(privateCustomerModal.includes('setCustomId("email")'), true);

  const paymentStart = sourceSection(source, "async function startOrderPayment(", "async function handlePagBankCustomerSubmit(");
  assert.equal(paymentStart.includes("handleAutomaticPaymentCreationFailure("), true);
  assert.equal(paymentStart.includes("delete order.paymentCreationUncertainAt"), true);

  const rejection = sourceSection(source, "async function rejectManualPayment(", "async function requestNewManualProof(");
  assert.equal(rejection.includes("manualPaymentAwaitingReplacement = true"), true);
  assert.equal(rejection.includes("Enviei novo comprovante"), true);

  const confirmation = sourceSection(source, "async function confirmManualPaymentNotification(", "async function cancelCart(");
  assert.equal(confirmation.includes("claimOrderActionLock(order)"), true);
  assert.equal(confirmation.includes("findLatestProofAttachment(recentMessages || [], order.userId"), true);
  assert.equal(confirmation.includes("persistOrderRelationalAsync(db, order, panel)"), true);
  assert.equal(confirmation.indexOf("persistOrderRelationalAsync(db, order, panel)") < confirmation.indexOf("sendManualProofNotification("), true);
  assert.equal(confirmation.includes("O comprovante foi salvo para analise"), true);

  const approval = sourceSection(source, "async function markOrderPaid(", "function proofSubmittedAtText(");
  assert.equal(approval.includes("authorizedManualPaymentStaff(context)"), true);
  assert.equal(approval.includes("comprador nao pode aprovar o proprio pagamento"), true);
  assert.equal(approval.includes("claimOrderActionLock(order)"), true);
  assert.equal(approval.includes("deliverAutomaticOrderStock(order, panel, db"), true);

  const delivery = sourceSection(source, "async function requestDelivery(", "async function deliverOrder(");
  assert.equal(delivery.includes("PAYMENT_STATE.PAID_DELIVERY_PENDING"), true);
  assert.equal(delivery.includes("retryAutomaticDelivery(interaction, id)"), true);

  const automaticApproval = sourceSection(source, "async function processApprovedMercadoPagoPayment(", "async function handleMercadoPagoWebhook(");
  assert.equal(automaticApproval.indexOf("PAYMENT_STATE.CANCELED") < automaticApproval.indexOf("notifyAutomaticPaymentOnce("), true);
  assert.equal(automaticApproval.includes("automaticStockDeliveredAt"), true);
  assert.equal(automaticApproval.includes("claimOrderActionLock(order)"), true);

  const webhook = sourceSection(source, "async function handleMercadoPagoWebhook(", "async function reconcileMercadoPagoCommand(");
  assert.equal(webhook.includes("verifyMercadoPagoSignature"), true);
  assert.equal(webhook.includes("getMercadoPagoPayment(paymentId)"), true);
  assert.equal(webhook.includes("return res.status(401)"), true);

  const inactivity = sourceSection(source, "async function sweepInactiveCarts(", "const inactivitySweepTimer");
  assert.equal(inactivity.includes("isManualInactivityCandidate(order)"), true);
  assert.equal(inactivity.includes("isInactive(current, now, threshold)"), true);
  assert.equal(inactivity.includes("ORDER_STATUS.EXPIRED_INACTIVITY"), true);
  assert.equal(inactivity.includes("scheduleCartDeletion(current)"), true);

  const humanMessages = sourceSection(source, 'client.on("messageCreate"', 'client.on("interactionCreate"');
  assert.equal(humanMessages.indexOf("message.author.bot") < humanMessages.indexOf("recordHumanActivity("), true);

  const startup = sourceSection(source, 'client.once("clientReady"', 'client.on("messageCreate"');
  assert.equal(startup.includes("refreshOpenOrderInterfaces(guild)"), true);
  assert.equal(startup.includes("sweepInactiveCarts()"), true);

  console.log("Buyer/admin experience regression tests passed.");
})();
