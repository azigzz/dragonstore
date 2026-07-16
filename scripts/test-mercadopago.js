const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createMercadoPagoPix, getMercadoPagoPayment, validateApprovedMercadoPagoPayment, verifyMercadoPagoSignature } = require("../src/mercadoPago");

(async () => {
  let request;
  const env = { MERCADOPAGO_ACCESS_TOKEN: "APP_USR-fake", MERCADOPAGO_WEBHOOK_URL: "https://example.com/webhooks/mercadopago" };
  const result = await createMercadoPagoPix({ referenceId: "order-1", idempotencyKey: "idem-1", amountCents: 100, expiresAt: "2030-01-01T00:15:00.000Z", description: "Pedido 1", customer: { name: "Maria da Silva", email: "maria@example.com", tax_id: "52998224725" } }, { env, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 201, json: async () => ({ id: 123456789, status: "pending", date_of_expiration: "2030-01-01T00:15:00.000Z", point_of_interaction: { transaction_data: { qr_code: "PIX-FAKE" } } }) }; } });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.mercadopago.com/v1/payments");
  assert.equal(request.options.headers["X-Idempotency-Key"], "idem-1");
  assert.equal(body.transaction_amount, 1);
  assert.equal(body.payment_method_id, "pix");
  assert.equal(body.notification_url, env.MERCADOPAGO_WEBHOOK_URL);
  assert.equal(body.payer.identification.number, "52998224725");
  assert.equal(result.paymentId, "123456789");
  assert.equal(result.copyPaste, "PIX-FAKE");

  const secret = "webhook-secret"; const dataId = "123456789"; const requestId = "req-1"; const ts = "1704908010";
  const signature = crypto.createHmac("sha256", secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest("hex");
  assert.equal(verifyMercadoPagoSignature({ xSignature: `ts=${ts},v1=${signature}`, xRequestId: requestId, dataId, secret }), true);
  assert.equal(verifyMercadoPagoSignature({ xSignature: `ts=${ts},v1=${"0".repeat(64)}`, xRequestId: requestId, dataId, secret }), false);
  assert.equal(validateApprovedMercadoPagoPayment({ mercadoPagoReferenceId: "order-1", mercadoPagoPaymentId: "123456789", totalCentsSnapshot: 100 }, { id: 123456789, status: "approved", payment_method_id: "pix", external_reference: "order-1", transaction_amount: 1 }).ok, true);
  await getMercadoPagoPayment("123456789", { env, fetchImpl: async (_url, options) => { assert.equal(options.method, "GET"); return { ok: true, status: 200, json: async () => ({ id: 123456789 }) }; } });
  console.log("Mercado Pago integration tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
