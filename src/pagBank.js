const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const PAGBANK_BASE_URLS = Object.freeze({
  sandbox: "https://sandbox.api.pagseguro.com",
  production: "https://api.pagseguro.com"
});

function pagBankConfig(env = process.env) {
  const environment = String(env.PAGBANK_ENV || "sandbox").trim().toLowerCase();
  if (!PAGBANK_BASE_URLS[environment]) throw new Error("PAGBANK_ENV deve ser sandbox ou production.");
  return {
    token: String(env.PAGBANK_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim(),
    environment,
    baseUrl: PAGBANK_BASE_URLS[environment],
    webhookUrl: String(env.PAGBANK_WEBHOOK_URL || "").trim()
  };
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function validCpf(value) {
  const digits = digitsOnly(value);
  if (!/^\d{11}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const check = length => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return Number(digits[length]) === (remainder === 10 ? 0 : remainder);
  };
  return check(9) && check(10);
}

function validCnpj(value) {
  const digits = digitsOnly(value);
  if (!/^\d{14}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const digitAt = length => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return Number(digits[12]) === digitAt(12) && Number(digits[13]) === digitAt(13);
}

function normalizeCustomer(customer = {}) {
  const name = String(customer.name || "").trim().replace(/\s+/g, " ");
  const email = String(customer.email || "").trim().toLowerCase();
  const taxId = digitsOnly(customer.taxId || customer.tax_id);
  if (name.length < 5 || name.length > 100 || !/[a-zA-ZÀ-ÿ]/.test(name) || !/\s/.test(name)) throw new Error("Informe seu nome completo valido.");
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("Informe um e-mail valido.");
  if (!(validCpf(taxId) || validCnpj(taxId))) throw new Error("Informe um CPF ou CNPJ valido.");
  return { name, email, tax_id: taxId };
}

function pagBankItems(items, amountCents) {
  if (!Array.isArray(items) || !items.length) throw new Error("O pedido precisa ter pelo menos um item.");
  const normalized = items.slice(0, 100).map((item, index) => {
    const quantity = Number(item.quantity);
    const unitAmount = Number(item.priceCents);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error(`Quantidade invalida no item ${index + 1}.`);
    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) throw new Error(`Valor invalido no item ${index + 1}.`);
    return {
      reference_id: String(item.productId || `item-${index + 1}`).slice(0, 64),
      name: String(item.name || "Produto digital").slice(0, 100),
      quantity,
      unit_amount: unitAmount
    };
  });
  const sum = normalized.reduce((total, item) => total + item.quantity * item.unit_amount, 0);
  if (sum === amountCents) return normalized;
  return [{
    reference_id: String(normalized[0].reference_id || "pedido").slice(0, 64),
    name: String(normalized.length === 1 ? normalized[0].name : "Produtos do pedido").slice(0, 100),
    quantity: 1,
    unit_amount: amountCents
  }];
}

function pagBankErrorDetails(status, payload) {
  const source = Array.isArray(payload?.error_messages) ? payload.error_messages : [];
  const errors = (source.length ? source : [payload || {}]).map(item => ({
    code: String(item?.code || payload?.code || "").slice(0, 80),
    description: String(item?.description || item?.message || payload?.message || "Requisicao recusada").slice(0, 300),
    parameterName: String(item?.parameter_name || "").slice(0, 120)
  }));
  return { status: Number(status), errors };
}

function pagBankReady(env = process.env) {
  try {
    const config = pagBankConfig(env);
    return Boolean(config.token && /^https:\/\//i.test(config.webhookUrl));
  } catch {
    return false;
  }
}

function redactPagBankDetails(details, sensitiveValues = []) {
  const secrets = sensitiveValues.map(value => String(value || "").trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  return {
    ...details,
    errors: details.errors.map(item => ({
      ...item,
      description: secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), item.description)
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email-redacted]")
        .replace(/\b\d{11,14}\b/g, "[document-redacted]")
    }))
  };
}

function sanitizedHomologationResponse(payload, sensitiveValues = []) {
  const details = redactPagBankDetails(pagBankErrorDetails(0, payload), sensitiveValues);
  return {
    id: String(payload?.id || ""),
    reference_id: String(payload?.reference_id || ""),
    created_at: String(payload?.created_at || ""),
    qr_codes: (Array.isArray(payload?.qr_codes) ? payload.qr_codes : []).map(qr => ({
      expiration_date: String(qr?.expiration_date || ""),
      links: (Array.isArray(qr?.links) ? qr.links : []).map(link => ({
        rel: String(link?.rel || ""),
        media: String(link?.media || ""),
        type: String(link?.type || "")
      }))
    })),
    error_messages: details.errors.filter(item => item.code || item.description !== "Requisicao recusada").map(item => ({
      code: item.code,
      description: item.description,
      parameter_name: item.parameterName
    }))
  };
}

function buildHomologationReport({ at, endpoint, requestBody, status, responseBody, sensitiveValues = [] }) {
  const sanitizedRequest = {
    reference_id: String(requestBody?.reference_id || ""),
    customer: { name: "[NOME REMOVIDO]", email: "[EMAIL REMOVIDO]", tax_id: "[DOCUMENTO REMOVIDO]" },
    items: (Array.isArray(requestBody?.items) ? requestBody.items : []).map(item => ({
      reference_id: String(item?.reference_id || ""),
      name: "Produto digital",
      quantity: Number(item?.quantity) || 0,
      unit_amount: Number(item?.unit_amount) || 0
    })),
    qr_codes: (Array.isArray(requestBody?.qr_codes) ? requestBody.qr_codes : []).map(qr => ({
      amount: { value: Number(qr?.amount?.value) || 0 },
      expiration_date: String(qr?.expiration_date || "")
    })),
    notification_urls: (Array.isArray(requestBody?.notification_urls) ? requestBody.notification_urls : []).map(() => "[WEBHOOK REMOVIDO]")
  };
  const sanitizedResponse = sanitizedHomologationResponse(responseBody, sensitiveValues);
  return [
    "PAGBANK - EVIDENCIA DE HOMOLOGACAO",
    `Data e hora: ${at}`,
    "Metodo HTTP: POST",
    `Endpoint: ${endpoint}`,
    "Headers:",
    JSON.stringify({ Authorization: "Bearer [TOKEN REMOVIDO]", Accept: "application/json", "Content-Type": "application/json", "x-idempotency-key": "[IDEMPOTENCY REMOVIDA]" }, null, 2),
    "Request JSON:",
    JSON.stringify(sanitizedRequest, null, 2),
    `Status HTTP recebido: ${status}`,
    "Response JSON:",
    JSON.stringify(sanitizedResponse, null, 2),
    "=".repeat(72),
    ""
  ].join("\n");
}

async function exportHomologationEvidence(input, options = {}) {
  const report = buildHomologationReport(input);
  const outputPath = path.resolve(options.path || process.env.PAGBANK_HOMOLOGATION_PATH || "pagbank-homologacao.txt");
  await fs.appendFile(outputPath, report, { encoding: "utf8", mode: 0o600 });
  return outputPath;
}

function safePagBankError(status, payload, sensitiveValues = []) {
  const details = redactPagBankDetails(pagBankErrorDetails(status, payload), sensitiveValues);
  const code = details.errors[0]?.code || "";
  const error = new Error(`PagBank HTTP ${status}${code ? ` (${code})` : ""}`);
  error.pagBank = details;
  return error;
}

function qrCodeData(payload) {
  const qr = Array.isArray(payload?.qr_codes) ? payload.qr_codes[0] : null;
  const links = Array.isArray(qr?.links) ? qr.links : [];
  const image = links.find(link => /png|image/i.test(`${link?.media || ""} ${link?.rel || ""}`));
  return {
    pagBankOrderId: String(payload?.id || ""),
    copyPaste: String(qr?.text || links.find(link => /pix|text\/plain/i.test(`${link?.rel || ""} ${link?.media || ""}`))?.href || ""),
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

  const customer = normalizeCustomer(input.customer);
  const expiresAt = input.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error("Data de expiracao PagBank invalida.");
  const body = {
    reference_id: String(input.referenceId).slice(0, 64),
    customer,
    items: pagBankItems(input.items, input.amountCents),
    qr_codes: [{
      amount: { value: input.amountCents },
      expiration_date: expiresAt
    }],
    notification_urls: [config.webhookUrl]
  };

  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  const endpoint = `${config.baseUrl}/orders`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-idempotency-key": idempotencyKey
  };
  let response;
  let payload;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await (options.fetchImpl || fetch)(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(options.timeoutMs) || 15_000)
    });
    payload = await response.json().catch(() => ({}));
    if (response.status !== 429 || attempt === 2) break;
    const retryAfter = Math.min(5000, Math.max(250, Number(response.headers?.get?.("retry-after") || payload?.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, retryAfter));
  }
  const exportEnabled = options.exportHomologation === true || String((options.env || process.env).PAGBANK_HOMOLOGATION_EXPORT || "").trim().toLowerCase() === "true";
  if (config.environment === "sandbox" && exportEnabled) {
    await exportHomologationEvidence({
      at: new Date().toISOString(),
      endpoint,
      requestBody: body,
      status: response.status,
      responseBody: payload,
      sensitiveValues: [config.token, customer.name, customer.email, customer.tax_id, qrCodeData(payload).copyPaste]
    }, { path: options.homologationPath }).catch(() => null);
  }
  if (!response.ok) throw safePagBankError(response.status, payload, [config.token, customer.name, customer.email, customer.tax_id]);
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
  buildHomologationReport,
  createPixOrder,
  normalizeCustomer,
  pagBankConfig,
  pagBankErrorDetails,
  pagBankItems,
  pagBankReady,
  paidPixCharge,
  qrCodeData,
  validatePaidPixNotification,
  validCnpj,
  validCpf,
  verifyWebhookSignature
};
