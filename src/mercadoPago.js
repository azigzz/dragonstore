const crypto = require("node:crypto");

const MP_API_URL = "https://api.mercadopago.com";

function mercadoPagoConfig(env = process.env) {
  return {
    accessToken: String(env.MERCADOPAGO_ACCESS_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim(),
    webhookUrl: String(env.MERCADOPAGO_WEBHOOK_URL || "").trim(),
    webhookSecret: String(env.MERCADOPAGO_WEBHOOK_SECRET || "").trim()
  };
}

function validWebhookUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/webhooks/mercadopago";
  } catch { return false; }
}

function mercadoPagoReady(env = process.env) {
  const config = mercadoPagoConfig(env);
  return Boolean(config.accessToken && validWebhookUrl(config.webhookUrl));
}

function safeError(status, payload) {
  const code = String(payload?.code || payload?.error || "").slice(0, 100);
  const message = String(payload?.message || payload?.error || "Requisicao recusada").replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]").replace(/\b\d{11,14}\b/g, "[documento]").slice(0, 300);
  const error = new Error(`Mercado Pago HTTP ${status}${code ? ` (${code})` : ""}`);
  error.mercadoPago = { status, code, message };
  return error;
}

async function mercadoPagoRequest(path, options = {}) {
  const config = mercadoPagoConfig(options.env || process.env);
  if (!config.accessToken) throw new Error("MERCADOPAGO_ACCESS_TOKEN nao configurado.");
  const response = await (options.fetchImpl || fetch)(`${MP_API_URL}${path}`, {
    ...options.request,
    headers: { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json", ...(options.request?.headers || {}) },
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw safeError(response.status, payload);
  return payload;
}

async function createMercadoPagoPix(input, options = {}) {
  const config = mercadoPagoConfig(options.env || process.env);
  if (!validWebhookUrl(config.webhookUrl)) throw new Error("MERCADOPAGO_WEBHOOK_URL invalida.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100) throw new Error("Pix Mercado Pago exige pelo menos 100 centavos.");
  const taxId = String(input.customer?.tax_id || "").replace(/\D/g, "");
  const names = String(input.customer?.name || "").trim().split(/\s+/);
  const body = {
    transaction_amount: input.amountCents / 100,
    description: String(input.description || "Produtos digitais").slice(0, 120),
    payment_method_id: "pix",
    external_reference: String(input.referenceId).slice(0, 64),
    notification_url: config.webhookUrl,
    date_of_expiration: input.expiresAt,
    payer: {
      email: String(input.customer?.email || "").toLowerCase(),
      first_name: names.shift() || "Cliente",
      last_name: names.join(" ") || "Digital",
      identification: { type: taxId.length === 14 ? "CNPJ" : "CPF", number: taxId }
    }
  };
  const payload = await mercadoPagoRequest("/v1/payments", {
    ...options,
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Idempotency-Key": input.idempotencyKey || crypto.randomUUID() },
      body: JSON.stringify(body)
    }
  });
  const transaction = payload?.point_of_interaction?.transaction_data || {};
  if (!payload?.id || !transaction.qr_code) throw new Error("Mercado Pago respondeu sem Pix copia e cola.");
  return { paymentId: String(payload.id), status: String(payload.status || "pending"), copyPaste: String(transaction.qr_code), qrCodeBase64: String(transaction.qr_code_base64 || ""), ticketUrl: String(transaction.ticket_url || ""), expiresAt: String(payload.date_of_expiration || input.expiresAt) };
}

function getMercadoPagoPayment(paymentId, options = {}) {
  const id = String(paymentId || "").trim();
  if (!/^\d{5,30}$/.test(id)) throw new Error("ID Mercado Pago invalido.");
  return mercadoPagoRequest(`/v1/payments/${id}`, { ...options, request: { ...(options.request || {}), method: "GET" } });
}

function verifyMercadoPagoSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!xSignature || !xRequestId || !dataId || !secret) return false;
  const parts = Object.fromEntries(String(xSignature).split(",").map(item => item.trim().split("=")));
  if (!parts.ts || !/^[a-f0-9]{64}$/i.test(parts.v1 || "")) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest();
  const received = Buffer.from(parts.v1, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function validateApprovedMercadoPagoPayment(order, payload) {
  const amountCents = Math.round(Number(payload?.transaction_amount) * 100);
  const ok = payload?.status === "approved" && payload?.payment_method_id === "pix" && String(payload?.external_reference || "") === order.mercadoPagoReferenceId && String(payload?.id || "") === String(order.mercadoPagoPaymentId || "") && amountCents === order.totalCentsSnapshot;
  return { ok, amountCents, paymentId: String(payload?.id || "") };
}

module.exports = { createMercadoPagoPix, getMercadoPagoPayment, mercadoPagoConfig, mercadoPagoReady, validateApprovedMercadoPagoPayment, verifyMercadoPagoSignature };
