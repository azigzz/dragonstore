import fs from "node:fs/promises";
import path from "node:path";
import baseConfig from "@/data/site-config.json";
import fallbackStore from "@/data/fallback-store.json";
import type { AdminConfigPayload, SiteConfig, StoreCategory, StoreProduct } from "@/lib/types";

const CONFIG_PATH = path.join(process.cwd(), "data", "site-config.json");
const RUNTIME_CONFIG_PATH = path.join(process.cwd(), "data", "site-config.runtime.json");

function asProducts(value: unknown): StoreProduct[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(Boolean)
    .map((item, index) => {
      const product = item as Partial<StoreProduct>;
      return {
        id: String(product.id || `fallback-${index + 1}`),
        name: String(product.name || "Produto"),
        price: String(product.price || "A combinar"),
        description: String(product.description || "Produto digital da Dragon Store"),
        stock: String(product.stock || "sob consulta"),
        imageUrl: product.imageUrl ? String(product.imageUrl) : "/dragon-store-hero.png",
        type: product.type ? String(product.type) : "normal"
      };
    })
    .slice(0, 25);
}

function asCategories(value: unknown): StoreCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(Boolean)
    .map((item, index) => {
      const category = item as Partial<StoreCategory>;
      const products = asProducts(category.products);
      return {
        id: String(category.id || `categoria-${index + 1}`),
        panelId: category.panelId ? String(category.panelId) : undefined,
        scopeId: category.scopeId ? String(category.scopeId) : undefined,
        title: String(category.title || `Categoria ${index + 1}`).slice(0, 120),
        description: String(category.description || "Produtos digitais da Dragon Store").slice(0, 1200),
        imageUrl: category.imageUrl ? String(category.imageUrl).slice(0, 500) : "/dragon-store-hero.png",
        thumbnailUrl: category.thumbnailUrl ? String(category.thumbnailUrl).slice(0, 500) : "",
        color: category.color ? normalizeColor(String(category.color)) : undefined,
        minPrice: typeof category.minPrice === "number" ? category.minPrice : null,
        products
      };
    })
    .filter(category => category.products.length)
    .slice(0, 50);
}

function cleanConfig(input: Partial<SiteConfig>): Partial<SiteConfig> {
  const output: Partial<SiteConfig> = {};
  if (typeof input.storeName === "string") output.storeName = input.storeName.slice(0, 80);
  if (typeof input.subtitle === "string") output.subtitle = input.subtitle.slice(0, 120);
  if (typeof input.heroTitle === "string") output.heroTitle = input.heroTitle.slice(0, 140);
  if (typeof input.heroText === "string") output.heroText = input.heroText.slice(0, 320);
  if (typeof input.discordInviteUrl === "string") output.discordInviteUrl = input.discordInviteUrl.slice(0, 300);
  if (typeof input.ticketChannelUrl === "string") output.ticketChannelUrl = input.ticketChannelUrl.slice(0, 300);
  if (typeof input.botApiUrl === "string") output.botApiUrl = input.botApiUrl.slice(0, 300);
  if (typeof input.botApiToken === "string" && input.botApiToken.trim()) output.botApiToken = input.botApiToken.trim();
  if (typeof input.primaryColor === "string") output.primaryColor = normalizeColor(input.primaryColor);
  if (typeof input.heroImageUrl === "string") output.heroImageUrl = input.heroImageUrl.slice(0, 500);
  if (Array.isArray(input.trustBadges)) {
    output.trustBadges = input.trustBadges.map(item => String(item).slice(0, 60)).filter(Boolean).slice(0, 8);
  }
  if (Array.isArray(input.fallbackCategories)) output.fallbackCategories = asCategories(input.fallbackCategories);
  if (Array.isArray(input.fallbackProducts)) output.fallbackProducts = asProducts(input.fallbackProducts);
  return output;
}

function normalizeColor(value?: string) {
  const raw = String(value || "#28f6a1").trim();
  const color = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#28f6a1";
}

async function readJsonFile(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Partial<SiteConfig>;
  } catch {
    return {};
  }
}

export async function readSiteConfig(): Promise<SiteConfig> {
  const fileConfig = await readJsonFile(CONFIG_PATH);
  const runtimeConfig = await readJsonFile(RUNTIME_CONFIG_PATH);
  const merged = cleanConfig({
    ...(baseConfig as SiteConfig),
    ...fileConfig,
    ...runtimeConfig,
    storeName: process.env.DRAGON_STORE_NAME || runtimeConfig.storeName || fileConfig.storeName || baseConfig.storeName,
    subtitle: process.env.STORE_SUBTITLE || runtimeConfig.subtitle || fileConfig.subtitle || baseConfig.subtitle,
    heroTitle: process.env.STORE_HERO_TITLE || runtimeConfig.heroTitle || fileConfig.heroTitle || baseConfig.heroTitle,
    heroText: process.env.STORE_HERO_TEXT || runtimeConfig.heroText || fileConfig.heroText || baseConfig.heroText,
    discordInviteUrl: process.env.DISCORD_INVITE_URL || runtimeConfig.discordInviteUrl || fileConfig.discordInviteUrl || baseConfig.discordInviteUrl,
    botApiUrl: process.env.BOT_PUBLIC_STORE_API_URL || runtimeConfig.botApiUrl || fileConfig.botApiUrl || "",
    botApiToken: process.env.BOT_PUBLIC_STORE_API_TOKEN || runtimeConfig.botApiToken || fileConfig.botApiToken || "",
    primaryColor: process.env.PRIMARY_COLOR || runtimeConfig.primaryColor || fileConfig.primaryColor || baseConfig.primaryColor
  });

  return {
    storeName: merged.storeName || "Dragon Store",
    subtitle: merged.subtitle || "Loja digital pelo Discord",
    heroTitle: merged.heroTitle || "Produtos digitais com compra rapida pelo Discord",
    heroText: merged.heroText || "Escolha seus produtos, monte seu carrinho e finalize pelo Discord.",
    discordInviteUrl: merged.discordInviteUrl || "",
    ticketChannelUrl: merged.ticketChannelUrl || "",
    botApiUrl: merged.botApiUrl || "",
    botApiToken: merged.botApiToken || "",
    primaryColor: normalizeColor(merged.primaryColor),
    heroImageUrl: merged.heroImageUrl || "/dragon-store-hero.png",
    trustBadges: merged.trustBadges?.length ? merged.trustBadges : baseConfig.trustBadges,
    fallbackCategories: merged.fallbackCategories?.length
      ? merged.fallbackCategories
      : asCategories((fallbackStore as { categories?: unknown }).categories),
    fallbackProducts: merged.fallbackProducts?.length ? merged.fallbackProducts : asProducts(fallbackStore.products)
  };
}

export async function saveSiteConfig(input: Partial<SiteConfig>) {
  const current = await readSiteConfig();
  const cleaned = cleanConfig(input);
  const nextConfig = {
    ...current,
    ...cleaned,
    botApiToken: cleaned.botApiToken || current.botApiToken || ""
  };
  await fs.mkdir(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
  await fs.writeFile(RUNTIME_CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
  return nextConfig;
}

export function toAdminPayload(config: SiteConfig): AdminConfigPayload {
  return {
    ...config,
    botApiToken: "",
    botApiTokenConfigured: Boolean(config.botApiToken)
  };
}
