const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PAYMENT_METHOD, calculateServerCart, resolvePaymentMethod } = require("../src/paymentPolicy");
const { createPixOrder, normalizeCustomer, pagBankConfig, pagBankErrorDetails, paidPixCharge, qrCodeData, validatePaidPixNotification, validCnpj, validCpf, verifyWebhookSignature } = require("../src/pagBank");
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
const customer = { name: "Maria da Silva", email: "MARIA@example.com", taxId: "529.982.247-25" };
const created = await createPixOrder({
  referenceId: "order-1",
  idempotencyKey: "idem-1",
  amountCents: 100,
  items: [{ productId: "p1", name: "Produto", priceCents: 100, quantity: 1 }],
  customer
}, {
  env: { PAGBANK_TOKEN: "fake-token", PAGBANK_ENV: "sandbox", PAGBANK_WEBHOOK_URL: "https://example.com/webhooks/pagbank" },
  fetchImpl: async (url, options) => {
    fetchCalls += 1;
    request = { url, options };
    return { ok: true, status: 201, json: async () => ({ id: "ORDE_FAKE", qr_codes: [{ text: "PIX-FAKE", expiration_date: "2030-01-01T00:00:00Z", links: [] }] }) };
  }
});
assert.equal(created.pagBankOrderId, "ORDE_FAKE");
assert.equal(request.options.headers.Accept, "application/json");
assert.equal(request.options.headers["x-idempotency-key"], "idem-1");
const requestBody = JSON.parse(request.options.body);
assert.deepEqual(requestBody.customer, { name: "Maria da Silva", email: "maria@example.com", tax_id: "52998224725" });
assert.equal(requestBody.qr_codes[0].amount.value, 100);
assert.equal(requestBody.items.reduce((sum, item) => sum + item.quantity * item.unit_amount, 0), 100);
assert.equal("charges" in requestBody, false);
assert.deepEqual(requestBody.notification_urls, ["https://example.com/webhooks/pagbank"]);
const expirationDelay = Date.parse(requestBody.qr_codes[0].expiration_date) - Date.now();
assert.ok(expirationDelay > 14 * 60_000 && expirationDelay <= 15 * 60_000);
assert.equal(Number.isInteger(requestBody.items[0].unit_amount), true);

assert.equal(validCpf("529.982.247-25"), true);
assert.equal(validCpf("529.982.247-24"), false);
assert.equal(validCpf("11111111111"), false);
assert.equal(validCnpj("11.222.333/0001-81"), true);
assert.equal(normalizeCustomer(customer).tax_id, "52998224725");
assert.throws(() => normalizeCustomer({ ...customer, name: "   " }), /nome completo/i);
assert.throws(() => normalizeCustomer({ ...customer, email: "invalido" }), /e-mail/i);
assert.throws(() => normalizeCustomer({ ...customer, taxId: "" }), /CPF ou CNPJ/i);
assert.throws(() => normalizeCustomer({ ...customer, taxId: "123.456.789-00" }), /CPF ou CNPJ/i);
assert.equal(pagBankConfig({ PAGBANK_ENV: "sandbox", PAGBANK_TOKEN: " Bearer secret-token ", PAGBANK_WEBHOOK_URL: "https://example.com/hook" }).token, "secret-token");

let discountedBody;
await createPixOrder({
  referenceId: "order-discount",
  amountCents: 180,
  items: [{ productId: "p1", name: "Produto", priceCents: 100, quantity: 2 }],
  customer
}, {
  env: { PAGBANK_TOKEN: "fake", PAGBANK_ENV: "sandbox", PAGBANK_WEBHOOK_URL: "https://example.com/webhooks/pagbank" },
  fetchImpl: async (_url, options) => {
    discountedBody = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ id: "ORDE_DISCOUNT", qr_codes: [{ text: "PIX-DISCOUNT", links: [] }] }) };
  }
});
assert.equal(discountedBody.items.reduce((sum, item) => sum + item.quantity * item.unit_amount, 0), 180);
assert.equal(discountedBody.qr_codes[0].amount.value, 180);

const parsedErrors = pagBankErrorDetails(400, { error_messages: [
  { code: "40001", description: "parametro obrigatorio nao informado", parameter_name: "customer.tax_id" },
  { code: "40002", description: "email invalido", parameter_name: "customer.email" }
] });
assert.equal(parsedErrors.errors.length, 2);
assert.deepEqual(parsedErrors.errors[0], { code: "40001", description: "parametro obrigatorio nao informado", parameterName: "customer.tax_id" });

const linkedQr = qrCodeData({ id: "ORDE_LINK", qr_codes: [{ expiration_date: "2030-01-01T00:00:00Z", links: [
  { rel: "QRCODE.PNG", media: "image/png", href: "https://example.com/qr.png" },
  { rel: "PIX", media: "text/plain", href: "PIX-FROM-LINK" }
] }] });
assert.equal(linkedQr.copyPaste, "PIX-FROM-LINK");
assert.equal(linkedQr.qrCodeImageUrl, "https://example.com/qr.png");

let rejectedRequest;
await assert.rejects(() => createPixOrder({ referenceId: "bad", amountCents: 100, items: [{ productId: "p1", name: "Produto", priceCents: 100, quantity: 1 }], customer }, {
  env: { PAGBANK_TOKEN: "never-log-this-token", PAGBANK_ENV: "sandbox", PAGBANK_WEBHOOK_URL: "https://example.com/webhooks/pagbank" },
  fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error_messages: [{ code: "40001", description: "tax id obrigatorio", parameter_name: "customer.tax_id" }] }) })
}).catch(error => { rejectedRequest = error; throw error; }), /PagBank HTTP 400 \(40001\)/);
assert.equal(rejectedRequest.message.includes("52998224725"), false);
assert.equal(rejectedRequest.message.includes("never-log-this-token"), false);
assert.equal(rejectedRequest.pagBank.errors[0].parameterName, "customer.tax_id");

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
