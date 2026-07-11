const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_AUDIT_KEY = process.env.SITE_ADMIN_AUDIT_KV_KEY || "savio-store:site-admin-audit";
const MAX_EVENTS = 300;

type AdminAuditEvent = {
  id: string;
  action: string;
  ip: string;
  userAgent: string;
  details: unknown;
  createdAt: string;
};

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
}

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return depth > 1 ? `[${value.length} item(s)]` : value.slice(0, 30).map(item => scrub(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 2) return "[objeto]";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => {
      const lower = key.toLowerCase();
      if (lower.includes("token") || lower.includes("password") || lower.includes("secret") || lower.includes("pix")) {
        return [key, "[redigido]"];
      }
      return [key, scrub(item, depth + 1)];
    }));
  }
  return String(value).slice(0, 300);
}

async function readAuditEvents() {
  if (KV_REST_API_URL && KV_REST_API_TOKEN) {
    try {
      const response = await fetch(`${KV_REST_API_URL.replace(/\/$/, "")}/get/${encodeURIComponent(KV_AUDIT_KEY)}`, {
        headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({})) as { result?: unknown };
      if (response.ok && payload.result) {
        const parsed = typeof payload.result === "string" ? JSON.parse(payload.result) : payload.result;
        return Array.isArray(parsed) ? parsed as AdminAuditEvent[] : [];
      }
    } catch {
      return [];
    }
  }

  return [];
}

async function writeAuditEvents(events: AdminAuditEvent[]) {
  if (KV_REST_API_URL && KV_REST_API_TOKEN) {
    const response = await fetch(`${KV_REST_API_URL.replace(/\/$/, "")}/set/${encodeURIComponent(KV_AUDIT_KEY)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_REST_API_TOKEN}`,
        "Content-Type": "text/plain"
      },
      body: JSON.stringify(events)
    });
    if (response.ok) return;
  }

  console.info("Admin audit storage externo nao configurado; evento mantido apenas nos logs.");
}

export async function appendAdminAudit(request: Request, action: string, details: unknown = {}) {
  const event: AdminAuditEvent = {
    id: `admin_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    action,
    ip: requestIp(request),
    userAgent: (request.headers.get("user-agent") || "").slice(0, 300),
    details: scrub(details),
    createdAt: new Date().toISOString()
  };

  console.info(`Admin audit: ${action} (${event.ip})`);
  const events = [...await readAuditEvents(), event].slice(-MAX_EVENTS);
  await writeAuditEvents(events).catch(error => {
    console.warn(`Falha ao salvar admin audit: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  });
  return event;
}
