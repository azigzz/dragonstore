const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function ntfyConfig(env = process.env) {
  return {
    baseUrl: String(env.NTFY_URL || "https://ntfy.sh").trim(),
    topic: String(env.NTFY_TOPIC || "").trim(),
    token: String(env.NTFY_TOKEN || "").trim()
  };
}

function parsedHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  url.hash = "";
  url.search = "";
  return url;
}

function ntfyEndpoint(config) {
  const rawTopic = String(config?.topic || "").trim();
  const topicAsUrl = rawTopic && (/^https?:\/\//i.test(rawTopic) || /^[^/]+\.[^/]+\//.test(rawTopic))
    ? parsedHttpUrl(rawTopic)
    : null;
  if (topicAsUrl && topicAsUrl.pathname !== "/") return topicAsUrl.toString().replace(/\/$/, "");

  const url = parsedHttpUrl(config?.baseUrl);
  if (!url) return "";
  if (rawTopic) {
    const topic = rawTopic.replace(/^\/+|\/+$/g, "");
    if (!topic || topic.includes("/")) return "";
    const currentTopic = url.pathname.replace(/\/+$/, "").split("/").pop();
    if (currentTopic && (currentTopic === topic || currentTopic === encodeURIComponent(topic))) {
      return url.toString().replace(/\/$/, "");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  } else if (!url.pathname || url.pathname === "/") {
    return "";
  }
  return url.toString();
}

function ntfyReady(env = process.env) {
  return Boolean(ntfyEndpoint(ntfyConfig(env)));
}

function encodedHeader(value) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function safeFilename(value) {
  return path.basename(String(value || "comprovante.bin"))
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 120) || "comprovante.bin";
}

function saoPauloTime(date = new Date()) {
  return date.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function notificationText(input) {
  const products = Array.isArray(input.products) && input.products.length
    ? input.products.join(", ")
    : "Pedido sem descricao";
  return [
    `Produto: ${products}`,
    `Valor: ${input.total || "R$ 0,00"}`,
    `Hora: ${saoPauloTime(input.at ? new Date(input.at) : new Date())}`,
    `Pagamento: ${input.paymentLabel}`,
    `Cliente: ${input.customerName || "cliente"} (${input.customerId || "ID indisponivel"})`,
    `Pedido: ${input.orderId}`
  ].join("\n").slice(0, 3500);
}

function notificationInput(kind, input) {
  const automatic = kind === "automatic";
  return {
    title: automatic ? "PAGAMENTO APROVADO" : "COMPROVANTE RECEBIDO",
    message: notificationText({
      ...input,
      paymentLabel: automatic ? "Automatico" : "Manual"
    }),
    tags: automatic ? "white_check_mark,money_with_wings" : "rotating_light,receipt",
    priority: automatic ? "high" : "max",
    click: input.discordUrl,
    idempotencyKey: input.idempotencyKey
  };
}

async function publishNtfy(input, options = {}) {
  const config = ntfyConfig(options.env || process.env);
  const endpoint = ntfyEndpoint(config);
  if (!endpoint) return { sent: false, reason: "not_configured" };
  const fetchImpl = options.fetchImpl || fetch;
  const headers = {
    Title: encodedHeader(input.title),
    Tags: String(input.tags || ""),
    Priority: String(input.priority || "default"),
    "X-Sequence-ID": crypto.createHash("sha256").update(String(input.idempotencyKey || crypto.randomUUID())).digest("hex").slice(0, 64)
  };
  if (input.click) headers.Click = String(input.click);
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  let tempDirectory = "";
  try {
    let body;
    let method = "POST";
    if (input.attachment?.buffer) {
      tempDirectory = await fs.mkdtemp(path.join(options.tmpRoot || os.tmpdir(), "dragon-store-proof-"));
      const filename = safeFilename(input.attachment.filename);
      const tempPath = path.join(tempDirectory, filename);
      await fs.writeFile(tempPath, input.attachment.buffer, { mode: 0o600 });
      body = await fs.readFile(tempPath);
      method = "PUT";
      headers.Filename = filename;
      headers.Message = encodedHeader(input.message);
      headers["Content-Type"] = String(input.attachment.contentType || "application/octet-stream");
    } else {
      body = String(input.message || "");
      headers["Content-Type"] = "text/plain; charset=utf-8";
    }
    const response = await fetchImpl(endpoint, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(Number(options.timeoutMs) || 12_000)
    });
    if (!response.ok) {
      let responseText = "";
      try {
        if (typeof response.text === "function") responseText = await response.text();
      } catch {
        responseText = "";
      }
      let detail = "";
      try {
        const parsed = JSON.parse(responseText);
        detail = String(parsed.error || parsed.message || "").replace(/[\r\n]+/g, " ").slice(0, 180);
      } catch {
        detail = responseText.replace(/[\r\n]+/g, " ").slice(0, 180);
      }
      const error = new Error(`ntfy HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      error.code = "ntfy_failed";
      throw error;
    }
    return { sent: true, status: response.status };
  } finally {
    if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => null);
  }
}

function sendAutomaticPaymentNotification(input, options = {}) {
  return publishNtfy(notificationInput("automatic", input), options);
}

function sendManualProofNotification(input, options = {}) {
  return publishNtfy({
    ...notificationInput("manual", input),
    attachment: input.attachment
  }, options);
}

function sendNtfyTestNotification(options = {}) {
  return publishNtfy({
    title: "Dragon Store - teste",
    message: "Teste de notificacao enviado com sucesso.",
    tags: "white_check_mark",
    priority: "default",
    idempotencyKey: `test:${Date.now()}`
  }, options);
}

module.exports = {
  notificationText,
  ntfyConfig,
  ntfyEndpoint,
  ntfyReady,
  publishNtfy,
  saoPauloTime,
  sendAutomaticPaymentNotification,
  sendManualProofNotification,
  sendNtfyTestNotification
};
