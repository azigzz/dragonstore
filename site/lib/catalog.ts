import { formatBRL } from "@/lib/money";
import type { StoreCategory, StoreProduct } from "@/lib/types";

const DISCORD_INVITE_URL = "https://discord.gg/fQQrUk7c98";
const CATEGORY_DESCRIPTION = "Confira as opcoes disponiveis e gere seu pedido para atendimento no Discord.";
const PRODUCT_DESCRIPTION = "Produto digital disponivel na Sávio Store.";

const BAD_PUBLIC_TEXT = [
  "loja em configuracao",
  "produto da loja",
  "adicione produtos",
  "quando tudo estiver pronto",
  "precos e nomes seguem",
  "painel configurado",
  "fallback",
  "runtime",
  "teste",
  "json",
  "api",
  "token",
  "vercel",
  "render"
];

type CatalogKind = "steam" | "roblox" | "smm" | "discord" | "design" | "streaming" | "ai" | "dragon";

const KIND_LABELS: Record<CatalogKind, string> = {
  steam: "Steam Keys",
  roblox: "Roblox",
  smm: "Social Media",
  discord: "Discord",
  design: "Design",
  streaming: "Streaming",
  ai: "IA",
  dragon: "Sávio Store"
};

function plain(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasBadPublicText(value: string) {
  const text = plain(value);
  return BAD_PUBLIC_TEXT.some(fragment => text.includes(fragment));
}

export function publicDiscordInvite(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return DISCORD_INVITE_URL;
  if (/5fyPxMXBTC|Y2MqnVwXnq|rapp28qmR4|ZyxwUekHWh/i.test(raw)) return DISCORD_INVITE_URL;
  return raw;
}

export function cleanPublicText(value: string | undefined, fallback: string) {
  const text = String(value || "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text || hasBadPublicText(text)) return fallback;
  return text;
}

export function categoryDescription(value?: string) {
  return cleanPublicText(value, CATEGORY_DESCRIPTION);
}

export function productDescription(value?: string) {
  return cleanPublicText(value, PRODUCT_DESCRIPTION);
}

export function catalogKind(seed: string): CatalogKind {
  const text = plain(seed);
  if (/(steam|key|keys)/.test(text)) return "steam";
  if (/(roblox|blox|gamepass|fruta|fruits|set tft|tft|dragon puppet|party balloons)/.test(text)) return "roblox";
  if (/(instagram|tiktok|seguidores|curtidas|smm|visualizacoes|views)/.test(text)) return "smm";
  if (/(discord|membros|boost|nitro)/.test(text)) return "discord";
  if (/(design|pack|recursos|psd|template)/.test(text)) return "design";
  if (/(streaming|netflix|hbo|crunchyroll|prime video|disney)/.test(text)) return "streaming";
  if (/(ai|ia|chatgpt|claude|perplexity)/.test(text)) return "ai";
  return "dragon";
}

export function catalogTagsFor(categories: StoreCategory[]) {
  const tags = new Map<CatalogKind, string>();
  for (const category of categories) {
    const kind = catalogKind(`${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`);
    tags.set(kind, KIND_LABELS[kind]);
  }
  return Array.from(tags.entries()).map(([id, label]) => ({ id, label }));
}

export function catalogKindLabel(seed: string) {
  return KIND_LABELS[catalogKind(seed)];
}

export function fallbackCatalogImage(seed: string) {
  void seed;
  return "/savio-store-logo.png";
}

export function categoryImage(category: StoreCategory, fallbackImage = "/savio-store-logo.png") {
  if (category.imageUrl && !category.imageUrl.includes("dragon-store-hero.png")) return category.imageUrl;
  const seed = `${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`;
  return fallbackCatalogImage(seed || fallbackImage);
}

export function productImage(product: StoreProduct, fallbackImage = "/savio-store-logo.png", categorySeed = "") {
  if (product.imageUrl && !product.imageUrl.includes("dragon-store-hero.png")) return product.imageUrl;
  return fallbackCatalogImage(`${categorySeed} ${product.name} ${product.description}`);
}

export function categoryPriceLabel(category: StoreCategory) {
  return typeof category.minPrice === "number"
    ? `A partir de ${formatBRL(category.minPrice)}`
    : "Valores no atendimento";
}

export function stockLabel(value?: string) {
  const stock = cleanPublicText(value, "");
  if (!stock || /sob consulta|sob demanda/i.test(stock)) return "";
  return stock;
}
