import fs from "node:fs/promises";
import path from "node:path";
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

const ANALYTICS_PATH = process.env.ANALYTICS_FILE_PATH || path.join(process.cwd(), "data", "analytics.runtime.json");
const ANALYTICS_TMP_PATH = path.join("/tmp", "dragon-store-analytics.json");
const MAX_EVENTS = 20000;

function emptyStore(): AnalyticsStore {
  return { events: [] };
}

async function readJsonFile(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Partial<AnalyticsStore>;
  } catch {
    return null;
  }
}

async function writeJsonFile(file: string, data: AnalyticsStore) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function readAnalyticsStore(): Promise<AnalyticsStore> {
  const data = await readJsonFile(ANALYTICS_PATH) || await readJsonFile(ANALYTICS_TMP_PATH);
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

async function writeAnalyticsStore(store: AnalyticsStore) {
  const data = { events: store.events.slice(-MAX_EVENTS) };
  try {
    await writeJsonFile(ANALYTICS_PATH, data);
  } catch {
    await writeJsonFile(ANALYTICS_TMP_PATH, data);
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
