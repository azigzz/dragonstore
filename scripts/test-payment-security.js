const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PAYMENT_METHOD, calculateServerCart, resolvePaymentMethod } = require("../src/paymentPolicy");
const { createPixOrder, paidPixCharge, validatePaidPixNotification, verifyWebhookSignature } = require("../src/pagBank");
const { canApproveManualPayment, isAuthorizedOwner } = require("../src/securityPolicy");

(async () => {

assert.equal(resolvePaymentMethod(40), PAYMENT_METHOD.MANUAL_PIX);
assert.equal(resolvePaymentMethod(99), PAYMENT_METHOD.MANUAL_PIX);
assert.equal(resolvePaymentMethod(100), PAYMENT_METHOD.PAGBANK_PIX);
assert.equal(resolvePaymentMethod(200), PAYMENT_METHOD.PAGBANK_PIX);
assert.throws(() => resolvePaymentMethod(0), /inteiro positivo/i);
assert.throws(() => resolvePaymentMethod(99.5), /inteiro positivo/i);

const catalog = new Map([["p1", { productId: "p1", name: "Produto", priceCents: 100 }]]);
const calculated = calculateServerCart([{ productId: "p1", priceCents: 1, quantity: 2 }], item => catalog.get(item.productId), 10);
assert.equal(calculated.grossCents, 200);
assert.equal(calculated.totalCents, 180, "o preco adulterado pelo cliente deve ser ignorado");

let fetchCalls = 0;
await assert.rejects(() => createPixOrder({ referenceId: "x", amountCents: 99, items: [] }, {
  env: { PAGBANK_TOKEN: "fake", PAGBANK_ENV: "sandbox", PAGBANK_WEBHOOK_URL: "https://example.com/webhooks/pagbank" },
  fetchImpl: async () => { fetchCalls += 1; }
}), /pelo menos 100/i);
assert.equal(fetchCalls, 0, "Pix manual nunca deve chamar o PagBank");

let request;
const created = await createPixOrder({
  referenceId: "order-1",
  idempotencyKey: "idem-1",
  amountCents: 100,
  items: [{ productId: "p1", name: "Produto", priceCents: 100, quantity: 1 }]
}, {
  env: { PAGBANK_TOKEN: "fake-token", PAGBANK_ENV: "sandbox", PAGBANK_WEBHOOK_URL: "https://example.com/webhooks/pagbank" },
  fetchImpl: async (url, options) => {
    fetchCalls += 1;
    request = { url, options };
    return { ok: true, status: 201, json: async () => ({ id: "ORDE_FAKE", qr_codes: [{ text: "PIX-FAKE", expiration_date: "2030-01-01T00:00:00Z", links: [] }] }) };
  }
});
assert.equal(created.pagBankOrderId, "ORDE_FAKE");
assert.equal(request.options.headers["x-idempotency-key"], "idem-1");
assert.equal(JSON.parse(request.options.body).qr_codes[0].amount.value, 100);

const raw = Buffer.from('{"status":"PAID"}', "utf8");
const token = "fake-token";
const signature = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(`${token}-`), raw])).digest("hex");
assert.equal(verifyWebhookSignature(raw, signature, token), true);
assert.equal(verifyWebhookSignature(raw, "0".repeat(64), token), false);
assert.equal(paidPixCharge({ status: "PAID", payment_method: { type: "PIX" } }).status, "PAID");
assert.equal(paidPixCharge({ status: "PAID", payment_method: { type: "BOLETO" } }), null);
const webhookPayload = { id: "ORDE_FAKE", reference_id: "ref-1", charges: [{ id: "CHAR_FAKE", status: "PAID", amount: { value: 100 }, payment_method: { type: "PIX" } }] };
assert.equal(validatePaidPixNotification({ paymentMethod: "MANUAL_PIX", pagBankReferenceId: "ref-1", totalCentsSnapshot: 100 }, webhookPayload).ok, false);
assert.equal(validatePaidPixNotification({ paymentMethod: "PAGBANK_PIX", pagBankReferenceId: "ref-1", pagBankOrderId: "ORDE_FAKE", totalCentsSnapshot: 100 }, webhookPayload).ok, true);
assert.equal(validatePaidPixNotification({ paymentMethod: "PAGBANK_PIX", pagBankReferenceId: "ref-1", pagBankOrderId: "ORDE_FAKE", totalCentsSnapshot: 99 }, webhookPayload).ok, false);

assert.equal(isAuthorizedOwner("123456789012345678", "123456789012345678, 999999999999999999"), true);
assert.equal(isAuthorizedOwner("111111111111111111", "123456789012345678"), false);
assert.equal(isAuthorizedOwner("123456789012345678", ""), false, "sem BOT_OWNER_IDS a autorizacao deve falhar fechada");
assert.equal(canApproveManualPayment("123456789012345678", "111111111111111111", "123456789012345678"), true);
assert.equal(canApproveManualPayment("123456789012345678", "123456789012345678", "123456789012345678"), false, "o comprador nao pode aprovar a propria compra");
assert.equal(canApproveManualPayment("999999999999999999", "111111111111111111", "123456789012345678"), false);

console.log("Payment and authorization security tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
