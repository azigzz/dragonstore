export type StoreProduct = {
  id: string;
  name: string;
  price: string;
  priceCents?: number | null;
  description: string;
  stock: string;
  imageUrl?: string;
  type?: string;
};

export type StoreCategory = {
  id: string;
  panelId?: string;
  scopeId?: string;
  title: string;
  description: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  color?: string;
  minPrice?: number | null;
  products: StoreProduct[];
};

export type StoreData = {
  storeName: string;
  title: string;
  description: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  color: string;
  discordInviteUrl?: string;
  ticketChannelId?: string;
  categories?: StoreCategory[];
  products: StoreProduct[];
  updatedAt?: string;
  source?: "bot" | "fallback";
  sourceMessage?: string;
};

export type SiteConfig = {
  storeName: string;
  subtitle: string;
  heroTitle: string;
  heroText: string;
  discordInviteUrl: string;
  ticketChannelUrl: string;
  botApiUrl: string;
  botApiToken?: string;
  primaryColor: string;
  heroImageUrl: string;
  trustBadges: string[];
  manualCatalogEnabled?: boolean;
  fallbackCategories?: StoreCategory[];
  fallbackProducts?: StoreProduct[];
};

export type AdminConfigPayload = Omit<SiteConfig, "botApiToken"> & {
  botApiToken?: string;
  botApiTokenConfigured?: boolean;
  csrfToken?: string;
};

export type AnalyticsProductSummary = {
  productId: string;
  productName: string;
  categoryId?: string;
  categoryTitle?: string;
  totalClicks: number;
  todayClicks: number;
  weekClicks: number;
  lastClickedAt?: string;
};

export type AnalyticsSummary = {
  updatedAt: string;
  totals: {
    todayVisitors: number;
    weekVisitors: number;
    todayPageViews: number;
    weekPageViews: number;
    totalPageViews: number;
    totalProductClicks: number;
  };
  topProducts: AnalyticsProductSummary[];
  recentEvents: Array<{
    type: string;
    path?: string;
    productName?: string;
    categoryTitle?: string;
    createdAt: string;
  }>;
};
