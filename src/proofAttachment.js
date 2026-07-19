const path = require("node:path");

const ALLOWED_PROOF_TYPES = Object.freeze({
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/webp": new Set([".webp"]),
  "application/pdf": new Set([".pdf"])
});
const DEFAULT_MAX_PROOF_BYTES = 8 * 1024 * 1024;

function normalizedMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function proofExtension(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function proofMaxBytes(env = process.env) {
  const configured = Number(env.PAYMENT_PROOF_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured < 1024) return DEFAULT_MAX_PROOF_BYTES;
  return Math.min(configured, 15 * 1024 * 1024);
}

function validateProofMetadata(attachment, options = {}) {
  if (!attachment || typeof attachment !== "object" || !attachment.url) {
    return { ok: false, code: "missing_attachment", message: "Envie uma imagem ou um arquivo PDF do comprovante antes de confirmar o pagamento." };
  }
  const contentType = normalizedMime(attachment.contentType);
  const extension = proofExtension(attachment.name);
  const size = Number(attachment.size);
  const maxBytes = Number(options.maxBytes) || proofMaxBytes(options.env);
  const extensions = ALLOWED_PROOF_TYPES[contentType];
  if (!extensions) {
    return { ok: false, code: "mime_not_allowed", message: "Formato invalido. Envie PNG, JPG, JPEG, WEBP ou PDF." };
  }
  if (!extensions.has(extension)) {
    return { ok: false, code: "extension_mismatch", message: "A extensao do arquivo nao corresponde ao tipo informado pelo Discord." };
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, code: "invalid_size", message: "O anexo esta vazio ou sem tamanho valido." };
  }
  if (size > maxBytes) {
    return { ok: false, code: "too_large", message: `O comprovante passa do limite de ${Math.floor(maxBytes / 1024 / 1024)} MB.` };
  }
  let url;
  try {
    url = new URL(String(attachment.url));
  } catch {
    return { ok: false, code: "invalid_url", message: "O link temporario do anexo e invalido." };
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    return { ok: false, code: "invalid_url", message: "O link temporario do anexo e invalido." };
  }
  return {
    ok: true,
    contentType,
    extension,
    size,
    maxBytes,
    kind: contentType === "application/pdf" ? "pdf" : "image",
    name: String(attachment.name || `comprovante${extension}`)
  };
}

function hasBytes(buffer, offset, values) {
  return values.every((value, index) => buffer[offset + index] === value);
}

function validProofMagic(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (contentType === "image/png") {
    return buffer.length >= 8 && hasBytes(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg") {
    return buffer.length >= 4 &&
      hasBytes(buffer, 0, [0xff, 0xd8, 0xff]) &&
      hasBytes(buffer, buffer.length - 2, [0xff, 0xd9]);
  }
  if (contentType === "image/webp") {
    return buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (contentType === "application/pdf") {
    const header = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("latin1");
    const trailer = buffer.subarray(Math.max(0, buffer.length - 4096)).toString("latin1");
    return header.startsWith("%PDF-") && trailer.includes("%%EOF");
  }
  return false;
}

async function responseBufferLimited(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error("O arquivo baixado passa do limite permitido.");
    error.code = "too_large";
    throw error;
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          const error = new Error("O arquivo baixado passa do limite permitido.");
          error.code = "too_large";
          throw error;
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    const error = new Error("O arquivo baixado passa do limite permitido.");
    error.code = "too_large";
    throw error;
  }
  return buffer;
}

async function downloadAndValidateProof(attachment, options = {}) {
  const metadata = validateProofMetadata(attachment, options);
  if (!metadata.ok) {
    const error = new Error(metadata.message);
    error.code = metadata.code;
    throw error;
  }
  let response;
  try {
    response = await (options.fetchImpl || fetch)(attachment.url, {
      signal: AbortSignal.timeout(Number(options.timeoutMs) || 15_000)
    });
  } catch (cause) {
    const error = new Error("Nao foi possivel baixar o comprovante enviado no Discord.");
    error.code = "download_failed";
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Nao foi possivel baixar o comprovante enviado no Discord (HTTP ${response.status}).`);
    error.code = "download_failed";
    throw error;
  }
  const buffer = await responseBufferLimited(response, metadata.maxBytes);
  if (buffer.length !== metadata.size) {
    const error = new Error("O tamanho baixado nao corresponde ao anexo informado pelo Discord.");
    error.code = "size_mismatch";
    throw error;
  }
  if (!validProofMagic(buffer, metadata.contentType)) {
    const error = new Error("O conteudo real do arquivo nao corresponde a PNG, JPG, WEBP ou PDF valido.");
    error.code = "invalid_content";
    throw error;
  }
  return { ...metadata, buffer };
}

function attachmentValues(message) {
  if (!message?.attachments) return [];
  if (typeof message.attachments.values === "function") return [...message.attachments.values()];
  if (Array.isArray(message.attachments)) return message.attachments;
  return [];
}

function findLatestProofAttachment(messages, ownerId, options = {}) {
  const list = typeof messages?.values === "function" ? [...messages.values()] : Array.from(messages || []);
  const candidates = [];
  for (const message of list) {
    if (String(message?.author?.id || "") !== String(ownerId || "")) continue;
    for (const attachment of attachmentValues(message)) {
      const metadata = validateProofMetadata(attachment, options);
      if (!metadata.ok) continue;
      candidates.push({
        attachment,
        message,
        metadata,
        timestamp: Number(message.createdTimestamp) || Date.parse(message.createdAt || "") || 0
      });
    }
  }
  candidates.sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0] || null;
}

function safeProofFilename(orderId, metadata) {
  const cleanId = String(orderId || "pedido").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "pedido";
  return `comprovante-pedido-${cleanId}${metadata.extension}`;
}

module.exports = {
  ALLOWED_PROOF_TYPES,
  DEFAULT_MAX_PROOF_BYTES,
  downloadAndValidateProof,
  findLatestProofAttachment,
  proofMaxBytes,
  safeProofFilename,
  validProofMagic,
  validateProofMetadata
};
