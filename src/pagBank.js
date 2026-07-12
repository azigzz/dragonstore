const crypto = require("node:crypto");

const PAGBANK_BASE_URLS = Object.freeze({
  sandbox: "https://sandbox.api.pagseguro.com",
  production: "https://api.pagseguro.com"
});

function pagBankConfig(env = process.env) {
  const environment = String(env.PAGBANK_ENV || "sandbox").trim().toLowerCase();
  if (!PAGBANK_BASE_URLS[environment]) throw new Error("PAGBANK_ENV deve ser sandbox ou production.");
  return {
    token: String(env.PAGBANK_TOKEN || "").trim(),
    environment,
    baseUrl: PAGBANK_BASE_URLS[environment],
    webhookUrl: String(env.PAGBANK_WEBHOOK_URL || "").trim()
  };
}

function pagBankReady(env = process.env) {
  try {
    const config = pagBankConfig(env);
    return Boolean(config.token && /^https:\/\//i.test(config.webhookUrl));
  } catch {
    return false;
  }
}

function safePagBankError(status, payload) {
  const code = String(payload?.error_messages?.[0]?.code || payload?.code || "").slice(0, 80);
  return new Error(`PagBank HTTP ${status}${code ? ` (${code})` : ""}`);
}

function qrCodeData(payload) {
  const qr = Array.isArray(payload?.qr_codes) ? payload.qr_codes[0] : null;
  const links = Array.isArray(qr?.links) ? qr.links : [];
  const image = links.find(link => /png|image/i.test(`${link?.media || ""} ${link?.rel || ""}`));
  return {
    pagBankOrderId: String(payload?.id || ""),
    copyPaste: String(qr?.text || ""),
    qrCodeImageUrl: String(image?.href || ""),
    expiresAt: String(qr?.expiration_date || "")
  };
}

async function createPixOrder(input, options = {}) {
  const config = pagBankConfig(options.env || process.env);
  if (!config.token) throw new Error("PAGBANK_TOKEN nao configurado.");
  if (!/^https:\/\//i.test(config.webhookUrl)) throw new Error("PAGBANK_WEBHOOK_URL invalida.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100) {
    throw new Error("O PagBank aceita neste bot apenas pedidos de pelo menos 100 centavos.");
  }

  const expiresAt = input.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const body = {
    reference_id: String(input.referenceId).slice(0, 64),
    items: (input.items || []).slice(0, 100).map((item, index) => ({
      reference_id: String(item.productId || `item-${index + 1}`).slice(0, 64),
      name: String(item.name || "Produto digital").slice(0, 100),
      quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
      unit_amount: Math.max(1, Math.trunc(Number(item.priceCents) || 0))
    })),
    qr_codes: [{
      amount: { value: input.amountCents, currency: "BRL" },
      expiration_date: expiresAt
    }],
    notification_urls: [config.webhookUrl]
  };

  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  let response;
  let payload;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await (options.fetchImpl || fetch)(`${config.baseUrl}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-idempotency-key": idempotencyKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(options.timeoutMs) || 15_000)
    });
    payload = await response.json().catch(() => ({}));
    if (response.status !== 429 || attempt === 2) break;
    const retryAfter = Math.min(5000, Math.max(250, Number(response.headers?.get?.("retry-after") || payload?.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, retryAfter));
  }
  if (!response.ok) throw safePagBankError(response.status, payload);
  const qr = qrCodeData(payload);
  if (!qr.pagBankOrderId || !qr.copyPaste) throw new Error("PagBank respondeu sem QR Code Pix.");
  return { ...qr, expiresAt: qr.expiresAt || expiresAt };
}

function verifyWebhookSignature(rawBody, signature, token) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !signature || !token) return false;
  const expected = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from(`${token}-`, "utf8"),
    rawBody
  ])).digest();
  const receivedText = String(signature).trim();
  if (!/^[a-f0-9]{64}$/i.test(receivedText)) return false;
  const received = Buffer.from(receivedText, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function paidPixCharge(payload) {
  const charges = Array.isArray(payload?.charges) ? payload.charges : [payload];
  return charges.find(charge => charge?.status === "PAID" && charge?.payment_method?.type === "PIX") || null;
}

function validatePaidPixNotification(order, payload) {
  const charge = paidPixCharge(payload);
  if (!charge || order?.paymentMethod !== "PAGBANK_PIX") return { ok: false, charge: null };
  const referenceId = String(payload?.reference_id || charge.reference_id || "");
  const amountCents = Number(charge.amount?.value ?? charge.amount?.summary?.paid ?? payload?.amount?.value);
  const pagBankOrderId = String(payload?.id || "");
  const chargeId = String(charge.id || "");
  const ok = Boolean(referenceId && referenceId === order.pagBankReferenceId) &&
    Number.isSafeInteger(amountCents) && amountCents === order.totalCentsSnapshot &&
    (!pagBankOrderId.startsWith("ORDE_") || pagBankOrderId === order.pagBankOrderId) &&
    (!order.pagBankChargeId || order.pagBankChargeId === chargeId);
  return { ok, charge, referenceId, amountCents, pagBankOrderId, chargeId };
}

module.exports = {
  PAGBANK_BASE_URLS,
  createPixOrder,
  pagBankConfig,
  pagBankReady,
  paidPixCharge,
  qrCodeData,
  validatePaidPixNotification,
  verifyWebhookSignature
};
