import crypto from "node:crypto";
import type { AnalyticsSummary } from "@/lib/types";

type AnalyticsEventType = "page_view" | "category_click" | "product_click";

type AnalyticsEvent = {
  id: string;
  type: AnalyticsEventType;
  visitorId: string;
  path?: string;
  productId?: string;
  productName?: string;
  categoryId?: string;
  categoryTitle?: string;
  createdAt: string;
};

type AnalyticsStore = {
  events: AnalyticsEvent[];
};

const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_ANALYTICS_KEY = process.env.SITE_ANALYTICS_KV_KEY || "dragon-store:site-analytics";
const ANALYTICS_FILE_NAME = "analytics.runtime.json";
const MAX_EVENTS = 20000;

function emptyStore(): AnalyticsStore {
  return { events: [] };
}

function isProductionRuntime() {
  return Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
}

function normalizeStore(data: Partial<AnalyticsStore> | null): AnalyticsStore {
  if (!data || !Array.isArray(data.events)) return emptyStore();
  return {
    events: data.events
      .filter(Boolean)
      .map(event => ({
        id: String(event.id || crypto.randomUUID()),
        type: event.type as AnalyticsEventType,
        visitorId: String(event.visitorId || "anonimo").slice(0, 120),
        path: event.path ? String(event.path).slice(0, 300) : undefined,
        productId: event.productId ? String(event.productId).slice(0, 120) : undefined,
        productName: event.productName ? String(event.productName).slice(0, 160) : undefined,
        categoryId: event.categoryId ? String(event.categoryId).slice(0, 120) : undefined,
        categoryTitle: event.categoryTitle ? String(event.categoryTitle).slice(0, 160) : undefined,
        createdAt: event.createdAt ? String(event.createdAt) : new Date().toISOString()
      }))
      .filter(event => ["page_view", "category_click", "product_click"].includes(event.type))
      .slice(-MAX_EVENTS)
  };
}

async function readJsonFile(file: string) {
  const fs = await import("node:fs/promises");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Partial<AnalyticsStore>;
  } catch {
    return null;
  }
}

async function writeJsonFile(file: string, data: AnalyticsStore) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function localAnalyticsPaths() {
  const path = await import("node:path");
  return [
    process.env.ANALYTICS_FILE_PATH || path.join(process.cwd(), "data", ANALYTICS_FILE_NAME),
    path.join("/tmp", "dragon-store-analytics.json")
  ];
}

async function readKvAnalytics() {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return null;
  try {
    const response = await fetch(`${KV_REST_API_URL.replace(/\/$/, "")}/get/${encodeURIComponent(KV_ANALYTICS_KEY)}`, {
      headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
      cache: "no-store"
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({})) as { result?: unknown };
    if (!payload.result) return null;
    return typeof payload.result === "string"
      ? JSON.parse(payload.result) as Partial<AnalyticsStore>
      : payload.result as Partial<AnalyticsStore>;
  } catch {
    return null;
  }
}

async function writeKvAnalytics(store: AnalyticsStore) {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) return false;
  const response = await fetch(`${KV_REST_API_URL.replace(/\/$/, "")}/set/${encodeURIComponent(KV_ANALYTICS_KEY)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "text/plain"
    },
    body: JSON.stringify({ events: store.events.slice(-MAX_EVENTS) })
  });
  return response.ok;
}

export async function readAnalyticsStore(): Promise<AnalyticsStore> {
  const kvData = await readKvAnalytics();
  if (kvData) return normalizeStore(kvData);
  if (isProductionRuntime()) return emptyStore();

  for (const file of await localAnalyticsPaths()) {
    const data = await readJsonFile(file);
    if (data) return normalizeStore(data);
  }
  return emptyStore();
}

async function writeAnalyticsStore(store: AnalyticsStore) {
  const data = { events: store.events.slice(-MAX_EVENTS) };
  if (await writeKvAnalytics(data)) return;

  if (isProductionRuntime()) {
    console.info("Analytics storage externo nao configurado; evento mantido apenas nos logs.");
    return;
  }

  const paths = await localAnalyticsPaths();
  try {
    await writeJsonFile(paths[0], data);
  } catch {
    await writeJsonFile(paths[1], data);
  }
}

export async function recordAnalyticsEvent(input: Partial<AnalyticsEvent>) {
  const type = input.type;
  if (!type || !["page_view", "category_click", "product_click"].includes(type)) {
    throw new Error("Tipo de evento invalido.");
  }

  const store = await readAnalyticsStore();
  store.events.push({
    id: crypto.randomUUID(),
    type,
    visitorId: String(input.visitorId || "anonimo").slice(0, 120),
    path: input.path ? String(input.path).slice(0, 300) : undefined,
    productId: input.productId ? String(input.productId).slice(0, 120) : undefined,
    productName: input.productName ? String(input.productName).slice(0, 160) : undefined,
    categoryId: input.categoryId ? String(input.categoryId).slice(0, 120) : undefined,
    categoryTitle: input.categoryTitle ? String(input.categoryTitle).slice(0, 160) : undefined,
    createdAt: new Date().toISOString()
  });
  await writeAnalyticsStore(store);
}

function saoPauloParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value || "01";
  return { year: part("year"), month: part("month"), day: part("day") };
}

function dayKey(date = new Date()) {
  const parts = saoPauloParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekKey(date = new Date()) {
  const parts = saoPauloParts(date);
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function analyticsSummary(): Promise<AnalyticsSummary> {
  const store = await readAnalyticsStore();
  const today = dayKey();
  const week = weekKey();
  const productMap = new Map<string, {
    productId: string;
    productName: string;
    categoryId?: string;
    categoryTitle?: string;
    totalClicks: number;
    todayClicks: number;
    weekClicks: number;
    lastClickedAt?: string;
  }>();
  const todayVisitors = new Set<string>();
  const weekVisitors = new Set<string>();
  let todayPageViews = 0;
  let weekPageViews = 0;
  let totalPageViews = 0;
  let totalProductClicks = 0;

  for (const event of store.events) {
    const created = new Date(event.createdAt);
    const eventDay = dayKey(created);
    const eventWeek = weekKey(created);

    if (event.type === "page_view") {
      totalPageViews += 1;
      if (eventDay === today) {
        todayPageViews += 1;
        todayVisitors.add(event.visitorId);
      }
      if (eventWeek === week) {
        weekPageViews += 1;
        weekVisitors.add(event.visitorId);
      }
    }

    if (event.type === "product_click" && event.productId) {
      totalProductClicks += 1;
      const key = event.productId;
      const row = productMap.get(key) || {
        productId: event.productId,
        productName: event.productName || "Produto",
        categoryId: event.categoryId,
        categoryTitle: event.categoryTitle,
        totalClicks: 0,
        todayClicks: 0,
        weekClicks: 0,
        lastClickedAt: event.createdAt
      };
      row.productName = event.productName || row.productName;
      row.categoryId = event.categoryId || row.categoryId;
      row.categoryTitle = event.categoryTitle || row.categoryTitle;
      row.totalClicks += 1;
      if (eventDay === today) row.todayClicks += 1;
      if (eventWeek === week) row.weekClicks += 1;
      row.lastClickedAt = event.createdAt;
      productMap.set(key, row);
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    totals: {
      todayVisitors: todayVisitors.size,
      weekVisitors: weekVisitors.size,
      todayPageViews,
      weekPageViews,
      totalPageViews,
      totalProductClicks
    },
    topProducts: [...productMap.values()]
      .sort((a, b) => b.totalClicks - a.totalClicks || b.weekClicks - a.weekClicks || a.productName.localeCompare(b.productName))
      .slice(0, 25),
    recentEvents: store.events
      .slice(-20)
      .reverse()
      .map(event => ({
        type: event.type,
        path: event.path,
        productName: event.productName,
        categoryTitle: event.categoryTitle,
        createdAt: event.createdAt
      }))
  };
}
