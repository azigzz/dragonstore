import fallbackStore from "@/data/fallback-store.json";
import { readSiteConfig, saveSiteConfig } from "@/lib/config";
import type { SiteConfig, StoreData, StoreProduct } from "@/lib/types";

function normalizeProducts(products: unknown, defaultImage: string): StoreProduct[] {
  if (!Array.isArray(products)) return [];
  return products
    .filter(Boolean)
    .map((item, index) => {
      const product = item as Partial<StoreProduct>;
      return {
        id: String(product.id || `product-${index + 1}`),
        name: String(product.name || "Produto"),
        price: String(product.price || "A combinar"),
        description: String(product.description || "Produto digital da Dragon Store"),
        stock: String(product.stock || "sob consulta"),
        imageUrl: product.imageUrl ? String(product.imageUrl) : defaultImage,
        type: product.type ? String(product.type) : "normal"
      };
    })
    .slice(0, 25);
}

function fallbackData(config: SiteConfig, message?: string): StoreData {
  const image = config.heroImageUrl || fallbackStore.imageUrl || "/dragon-store-hero.png";
  return {
    storeName: config.storeName || fallbackStore.storeName,
    title: config.heroTitle || fallbackStore.title,
    description: config.heroText || fallbackStore.description,
    imageUrl: image,
    thumbnailUrl: fallbackStore.thumbnailUrl,
    color: config.primaryColor || fallbackStore.color,
    discordInviteUrl: config.discordInviteUrl || fallbackStore.discordInviteUrl,
    ticketChannelId: fallbackStore.ticketChannelId,
    products: normalizeProducts(config.fallbackProducts || fallbackStore.products, image),
    source: "fallback",
    sourceMessage: message || "Usando produtos fallback."
  };
}

function mergeBotData(raw: StoreData, config: SiteConfig): StoreData {
  const image = raw.imageUrl || config.heroImageUrl || "/dragon-store-hero.png";
  const botProducts = normalizeProducts(raw.products, image);
  const fallbackProducts = normalizeProducts(config.fallbackProducts || fallbackStore.products, image);
  return {
    storeName: config.storeName || raw.storeName || "Dragon Store",
    title: raw.title || config.heroTitle,
    description: raw.description || config.heroText,
    imageUrl: image,
    thumbnailUrl: raw.thumbnailUrl || "",
    color: raw.color || config.primaryColor,
    discordInviteUrl: config.discordInviteUrl || raw.discordInviteUrl || "",
    ticketChannelId: raw.ticketChannelId || "",
    products: botProducts.length ? botProducts : fallbackProducts,
    updatedAt: raw.updatedAt,
    source: "bot",
    sourceMessage: "Produtos sincronizados do bot."
  };
}

export async function fetchBotStore(config: SiteConfig) {
  if (!config.botApiUrl || !config.botApiToken) {
    throw new Error("API do bot ou token nao configurado.");
  }

  const response = await fetch(config.botApiUrl, {
    headers: { Authorization: `Bearer ${config.botApiToken}` },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Bot respondeu HTTP ${response.status}.`);
  }

  return response.json() as Promise<StoreData>;
}

export async function getStoreData(): Promise<StoreData> {
  const config = await readSiteConfig();
  try {
    const botStore = await fetchBotStore(config);
    return mergeBotData(botStore, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao conectar no bot.";
    return fallbackData(config, message);
  }
}

export async function syncFallbackFromBot() {
  const config = await readSiteConfig();
  const botStore = mergeBotData(await fetchBotStore(config), config);
  await saveSiteConfig({
    fallbackProducts: botStore.products,
    heroImageUrl: botStore.imageUrl || config.heroImageUrl,
    primaryColor: botStore.color || config.primaryColor
  });
  return botStore;
}
