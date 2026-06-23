import fallbackStore from "@/data/fallback-store.json";
import { categoryDescription, categoryImage, productDescription, productImage, publicDiscordInvite } from "@/lib/catalog";
import { normalizeDiscordInvite, readSiteConfig, saveSiteConfig } from "@/lib/config";
import { parsePrice } from "@/lib/money";
import type { SiteConfig, StoreCategory, StoreData, StoreProduct } from "@/lib/types";

function slugify(value: string) {
  return String(value || "categoria")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "categoria";
}

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
        priceCents: typeof product.priceCents === "number" ? product.priceCents : null,
        description: productDescription(product.description),
        stock: String(product.stock || "sob consulta"),
        imageUrl: productImage({
          id: String(product.id || `product-${index + 1}`),
          name: String(product.name || "Produto"),
          price: String(product.price || "A combinar"),
          description: productDescription(product.description),
          stock: String(product.stock || "sob consulta"),
          imageUrl: product.imageUrl ? String(product.imageUrl) : "",
          type: product.type ? String(product.type) : "normal"
        }, defaultImage),
        type: product.type ? String(product.type) : "normal"
      };
    })
    .slice(0, 200);
}

function minProductPrice(products: StoreProduct[]) {
  const values = products
    .map(product => typeof product.priceCents === "number" ? product.priceCents / 100 : parsePrice(product.price))
    .filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}

function normalizeCategories(categories: unknown, defaultImage: string, fallbackTitle = "Catalogo"): StoreCategory[] {
  if (!Array.isArray(categories)) return [];
  const seen = new Set<string>();
  return categories
    .filter(Boolean)
    .map((item, index) => {
      const category = item as Partial<StoreCategory>;
      const title = String(category.title || `${fallbackTitle} ${index + 1}`);
      const idBase = String(category.id || category.scopeId || category.panelId || title);
      let id = slugify(idBase);
      let suffix = 2;
      while (seen.has(id)) id = `${slugify(idBase)}-${suffix++}`;
      seen.add(id);

      const image = category.imageUrl ? String(category.imageUrl) : "";
      const products = normalizeProducts(category.products, image);
      const normalizedCategory = {
        id,
        panelId: category.panelId ? String(category.panelId) : undefined,
        scopeId: category.scopeId ? String(category.scopeId) : undefined,
        title,
        description: categoryDescription(category.description),
        imageUrl: image,
        thumbnailUrl: category.thumbnailUrl ? String(category.thumbnailUrl) : "",
        color: category.color ? String(category.color) : undefined,
        minPrice: typeof category.minPrice === "number" ? category.minPrice : minProductPrice(products),
        products
      };
      return {
        ...normalizedCategory,
        imageUrl: categoryImage(normalizedCategory, defaultImage),
        products: products.map(product => ({
          ...product,
          imageUrl: productImage(product, categoryImage(normalizedCategory, defaultImage), `${title} ${normalizedCategory.description}`)
        }))
      };
    })
    .filter(category => category.products.length)
    .slice(0, 50);
}

function categoryFromProducts(products: StoreProduct[], store: Pick<StoreData, "title" | "description" | "imageUrl" | "color">): StoreCategory[] {
  if (!products.length) return [];
  return [{
    id: slugify(store.title || "catalogo"),
    title: store.title || "Catalogo Dragon Store",
    description: categoryDescription(store.description),
    imageUrl: store.imageUrl || "/dragon-store-hero.png",
    color: store.color,
    minPrice: minProductPrice(products),
    products
  }];
}

function fallbackData(config: SiteConfig, message?: string): StoreData {
  const image = config.heroImageUrl || fallbackStore.imageUrl || "/dragon-store-hero.png";
  const fallbackCategories = (fallbackStore as { categories?: unknown }).categories;
  const categories = normalizeCategories(config.fallbackCategories || fallbackCategories, image, fallbackStore.title);
  const products = categories.length
    ? categories.flatMap(category => category.products)
    : normalizeProducts(config.fallbackProducts || fallbackStore.products, image);
  const finalCategories = categories.length
    ? categories
    : categoryFromProducts(products, {
        title: config.heroTitle || fallbackStore.title,
        description: config.heroText || fallbackStore.description,
        imageUrl: image,
        color: config.primaryColor || fallbackStore.color
      });

  return {
    storeName: config.storeName || fallbackStore.storeName,
    title: config.heroTitle || fallbackStore.title,
    description: config.heroText || fallbackStore.description,
    imageUrl: image,
    thumbnailUrl: fallbackStore.thumbnailUrl,
    color: config.primaryColor || fallbackStore.color,
    discordInviteUrl: normalizeDiscordInvite(config.discordInviteUrl || fallbackStore.discordInviteUrl),
    ticketChannelId: fallbackStore.ticketChannelId,
    categories: finalCategories,
    products,
    source: "fallback",
    sourceMessage: message || "Catalogo carregado."
  };
}

function mergeBotData(raw: StoreData, config: SiteConfig): StoreData {
  const image = raw.imageUrl || config.heroImageUrl || "/dragon-store-hero.png";
  const fallbackCategoriesSource = (fallbackStore as { categories?: unknown }).categories;
  const botProducts = normalizeProducts(raw.products, image);
  const botCategories = normalizeCategories(raw.categories, image, raw.title);
  const fallbackProducts = normalizeProducts(config.fallbackProducts || fallbackStore.products, image);
  const fallbackCategories = normalizeCategories(config.fallbackCategories || fallbackCategoriesSource, image, raw.title || config.heroTitle);
  const manualCategories = config.manualCatalogEnabled ? fallbackCategories : [];
  const products = manualCategories.length ? manualCategories.flatMap(category => category.products) : botCategories.length ? botCategories.flatMap(category => category.products) : botProducts;
  const finalProducts = products.length ? products : fallbackProducts;
  const finalCategories = manualCategories.length
    ? manualCategories
    : botCategories.length
      ? botCategories
    : fallbackCategories.length
      ? fallbackCategories
      : categoryFromProducts(finalProducts, {
          title: raw.title || config.heroTitle,
          description: raw.description || config.heroText,
          imageUrl: image,
          color: raw.color || config.primaryColor
        });

  return {
    storeName: config.storeName || raw.storeName || "Dragon Store",
    title: raw.title || config.heroTitle,
    description: raw.description || config.heroText,
    imageUrl: image,
    thumbnailUrl: raw.thumbnailUrl || "",
    color: raw.color || config.primaryColor,
    discordInviteUrl: publicDiscordInvite(config.discordInviteUrl || raw.discordInviteUrl || ""),
    ticketChannelId: raw.ticketChannelId || "",
    categories: finalCategories,
    products: finalProducts,
    updatedAt: raw.updatedAt,
    source: "bot",
    sourceMessage: "Catalogo carregado."
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
    fallbackCategories: botStore.categories,
    fallbackProducts: botStore.products,
    heroImageUrl: botStore.imageUrl || config.heroImageUrl,
    primaryColor: botStore.color || config.primaryColor
  });
  return botStore;
}
