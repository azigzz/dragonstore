import { formatBRL } from "@/lib/money";
import type { StoreCategory, StoreProduct } from "@/lib/types";

const DISCORD_INVITE_URL = "https://discord.gg/ZyxwUekHWh";
const CATEGORY_DESCRIPTION = "Confira as opcoes disponiveis nesta categoria e finalize sua compra pelo Discord.";
const PRODUCT_DESCRIPTION = "Produto digital disponivel para compra via atendimento no Discord.";

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
  dragon: "Dragon Store"
};

const KIND_THEMES: Record<CatalogKind, { from: string; via: string; to: string; accent: string }> = {
  steam: { from: "#07111f", via: "#12385d", to: "#0ea5e9", accent: "#70d6ff" },
  roblox: { from: "#190d12", via: "#3f1424", to: "#ef4444", accent: "#fecdd3" },
  smm: { from: "#120e26", via: "#46227c", to: "#ec4899", accent: "#fbcfe8" },
  discord: { from: "#0d1024", via: "#28306f", to: "#5865f2", accent: "#c7d2fe" },
  design: { from: "#111827", via: "#365314", to: "#84cc16", accent: "#d9f99d" },
  streaming: { from: "#160b16", via: "#4c1d95", to: "#f97316", accent: "#fed7aa" },
  ai: { from: "#051619", via: "#075985", to: "#22d3ee", accent: "#cffafe" },
  dragon: { from: "#061016", via: "#0f2d32", to: "#28f6a1", accent: "#d9fff1" }
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
  if (/5fyPxMXBTC|Y2MqnVwXnq|rapp28qmR4/i.test(raw)) return DISCORD_INVITE_URL;
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
  const kind = catalogKind(seed);
  const theme = KIND_THEMES[kind];
  const title = KIND_LABELS[kind];
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760" role="img" aria-label="${title}">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${theme.from}"/>
          <stop offset=".52" stop-color="${theme.via}"/>
          <stop offset="1" stop-color="${theme.to}"/>
        </linearGradient>
        <radialGradient id="glow" cx="78%" cy="22%" r="52%">
          <stop offset="0" stop-color="${theme.accent}" stop-opacity=".55"/>
          <stop offset="1" stop-color="${theme.accent}" stop-opacity="0"/>
        </radialGradient>
        <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
          <path d="M64 0H0v64" fill="none" stroke="rgba(255,255,255,.11)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="1200" height="760" rx="44" fill="url(#bg)"/>
      <rect width="1200" height="760" rx="44" fill="url(#glow)"/>
      <rect width="1200" height="760" rx="44" fill="url(#grid)" opacity=".45"/>
      <path d="M-80 620C170 470 290 720 538 574 700 480 771 314 1014 334c115 10 193 74 286 161v265H-80Z" fill="rgba(0,0,0,.28)"/>
      <path d="M70 650C220 540 408 690 590 582 770 475 824 214 1116 260" fill="none" stroke="${theme.accent}" stroke-width="10" stroke-linecap="round" opacity=".72"/>
      <path d="M70 650C220 540 408 690 590 582 770 475 824 214 1116 260" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".42"/>
      <circle cx="918" cy="228" r="122" fill="rgba(255,255,255,.10)"/>
      <circle cx="918" cy="228" r="74" fill="rgba(0,0,0,.22)"/>
      <rect x="74" y="548" width="252" height="58" rx="18" fill="rgba(0,0,0,.30)" stroke="rgba(255,255,255,.18)"/>
      <text x="105" y="586" fill="${theme.accent}" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900">COMPRA PELO DISCORD</text>
      <text x="74" y="116" fill="rgba(255,255,255,.72)" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="800" letter-spacing="4">DRAGON STORE</text>
      <text x="74" y="414" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="96" font-weight="900">${title}</text>
      <text x="78" y="482" fill="rgba(255,255,255,.72)" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="700">Produtos digitais pelo Discord</text>
    </svg>
  `.replace(/\s+/g, " ").trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function categoryImage(category: StoreCategory, fallbackImage = "/dragon-store-hero.png") {
  if (category.imageUrl && !category.imageUrl.includes("dragon-store-hero.png")) return category.imageUrl;
  const seed = `${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`;
  return fallbackCatalogImage(seed || fallbackImage);
}

export function productImage(product: StoreProduct, fallbackImage = "/dragon-store-hero.png", categorySeed = "") {
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
