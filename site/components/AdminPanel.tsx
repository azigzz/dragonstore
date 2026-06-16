"use client";

import { BarChart3, CheckCircle2, LogIn, LogOut, Plus, RefreshCw, Save, ShieldCheck, TestTube2, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AdminConfigPayload, AnalyticsSummary, StoreCategory, StoreProduct } from "@/lib/types";

type AdminPanelProps = {
  loggedIn: boolean;
  initialConfig: AdminConfigPayload | null;
};

const emptyConfig: AdminConfigPayload = {
  storeName: "Dragon Store",
  subtitle: "Loja digital pelo Discord",
  heroTitle: "Produtos digitais com compra rapida pelo Discord",
  heroText: "Escolha seus produtos, monte seu carrinho e finalize pelo Discord.",
  discordInviteUrl: "",
  ticketChannelUrl: "",
  botApiUrl: "",
  botApiToken: "",
  botApiTokenConfigured: false,
  primaryColor: "#28f6a1",
  heroImageUrl: "/dragon-store-hero.png",
  trustBadges: ["Carrinho rapido", "Atendimento por ADM", "Pagamento via Pix", "Produtos digitais", "Suporte no Discord"],
  manualCatalogEnabled: false,
  fallbackCategories: [],
  fallbackProducts: []
};

function slugify(value: string) {
  return String(value || "item")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";
}

function newProduct(index: number): StoreProduct {
  return {
    id: `produto-${Date.now().toString(36)}-${index}`,
    name: "Novo produto",
    price: "R$ 0,00",
    description: "Produto digital da Dragon Store",
    stock: "sob consulta",
    imageUrl: "/dragon-store-hero.png",
    type: "normal"
  };
}

function productsToCategory(products: StoreProduct[]): StoreCategory[] {
  if (!products.length) return [];
  return [{
    id: "catalogo",
    title: "Catalogo",
    description: "Produtos digitais da Dragon Store",
    imageUrl: "/dragon-store-hero.png",
    color: "#28f6a1",
    products
  }];
}

function normalizeCategories(config: AdminConfigPayload | null) {
  const categories = config?.fallbackCategories?.length
    ? config.fallbackCategories
    : productsToCategory(config?.fallbackProducts || []);
  return categories.map((category, index) => ({
    ...category,
    id: category.id || slugify(category.title || `categoria-${index + 1}`),
    products: (category.products || []).map((product, productIndex) => ({
      ...product,
      id: product.id || `${slugify(product.name)}-${productIndex + 1}`
    }))
  }));
}

function flattenProducts(categories: StoreCategory[]) {
  return categories.flatMap(category => category.products || []);
}

function productLabel(count: number) {
  return `${count} ${count === 1 ? "produto" : "produtos"}`;
}

export default function AdminPanel({ loggedIn, initialConfig }: AdminPanelProps) {
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
  const [password, setPassword] = useState("");
  const [config, setConfig] = useState<AdminConfigPayload>(initialConfig || emptyConfig);
  const [categories, setCategories] = useState<StoreCategory[]>(normalizeCategories(initialConfig || emptyConfig));
  const [selectedCategoryId, setSelectedCategoryId] = useState(categories[0]?.id || "");
  const [trustText, setTrustText] = useState((initialConfig?.trustBadges || emptyConfig.trustBadges).join("\n"));
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const tokenLabel = useMemo(() => config.botApiTokenConfigured ? "Token ja configurado" : "Token ainda nao salvo", [config.botApiTokenConfigured]);
  const selectedCategory = categories.find(category => category.id === selectedCategoryId) || categories[0] || null;

  useEffect(() => {
    if (isLoggedIn) loadAnalytics();
  }, [isLoggedIn]);

  async function loadConfig() {
    const response = await fetch("/api/admin/config", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as AdminConfigPayload;
    const nextCategories = normalizeCategories(data);
    setConfig(data);
    setCategories(nextCategories);
    setSelectedCategoryId(nextCategories[0]?.id || "");
    setTrustText((data.trustBadges || []).join("\n"));
    return data;
  }

  async function loadAnalytics() {
    const response = await fetch("/api/admin/analytics", { cache: "no-store" });
    if (!response.ok) return;
    setAnalytics(await response.json() as AnalyticsSummary);
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setStatus(data.error || "Login recusado.");
      return;
    }
    setIsLoggedIn(true);
    setPassword("");
    setStatus("Login aprovado.");
    await loadConfig();
    await loadAnalytics();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setIsLoggedIn(false);
  }

  function update<K extends keyof AdminConfigPayload>(key: K, value: AdminConfigPayload[K]) {
    setConfig(current => ({ ...current, [key]: value }));
  }

  function updateCategory(categoryId: string, patch: Partial<StoreCategory>) {
    setCategories(current => current.map(category => category.id === categoryId ? { ...category, ...patch } : category));
  }

  function changeCategoryId(oldId: string, value: string) {
    const nextId = slugify(value);
    if (!nextId) return;
    setCategories(current => current.map(category => category.id === oldId ? { ...category, id: nextId } : category));
    setSelectedCategoryId(nextId);
  }

  function updateProduct(categoryId: string, productId: string, patch: Partial<StoreProduct>) {
    setCategories(current => current.map(category => {
      if (category.id !== categoryId) return category;
      return {
        ...category,
        products: category.products.map(product => product.id === productId ? { ...product, ...patch } : product)
      };
    }));
  }

  function addCategory() {
    const id = `categoria-${Date.now().toString(36)}`;
    const category: StoreCategory = {
      id,
      title: "Nova categoria",
      description: "Produtos digitais da Dragon Store",
      imageUrl: "/dragon-store-hero.png",
      color: config.primaryColor || "#28f6a1",
      products: [newProduct(1)]
    };
    setCategories(current => [...current, category]);
    setSelectedCategoryId(id);
  }

  function removeCategory(categoryId: string) {
    setCategories(current => {
      const next = current.filter(category => category.id !== categoryId);
      setSelectedCategoryId(next[0]?.id || "");
      return next;
    });
  }

  function addProduct(categoryId: string) {
    setCategories(current => current.map(category => {
      if (category.id !== categoryId) return category;
      return { ...category, products: [...category.products, newProduct(category.products.length + 1)] };
    }));
  }

  function removeProduct(categoryId: string, productId: string) {
    setCategories(current => current.map(category => {
      if (category.id !== categoryId) return category;
      return { ...category, products: category.products.filter(product => product.id !== productId) };
    }));
  }

  async function saveConfig() {
    setBusy(true);
    setStatus("");
    try {
      const cleanCategories = categories.map((category, index) => ({
        ...category,
        id: category.id || slugify(category.title || `categoria-${index + 1}`),
        products: category.products.map((product, productIndex) => ({
          ...product,
          id: product.id || `${slugify(product.name)}-${productIndex + 1}`
        }))
      }));
      const payload = {
        ...config,
        trustBadges: trustText.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
        fallbackCategories: cleanCategories,
        fallbackProducts: flattenProducts(cleanCategories)
      };
      const response = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar.");
      setConfig(data);
      setCategories(normalizeCategories(data));
      setTrustText((data.trustBadges || []).join("\n"));
      setStatus("Config salva.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function testBot() {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/test-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botApiUrl: config.botApiUrl, botApiToken: config.botApiToken })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    setStatus(response.ok ? `Conexao OK: ${productLabel(data.products || 0)}.` : data.error || "Falha ao testar bot.");
  }

  async function syncProducts() {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/sync", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(data.error || "Falha ao sincronizar.");
      return;
    }
    const categoryCount = Number(data.categories || 0);
    setStatus(`Sincronizado: ${productLabel(data.products || 0)} em ${categoryCount} ${categoryCount === 1 ? "categoria" : "categorias"}.`);
    await loadConfig();
  }

  if (!isLoggedIn) {
    return (
      <main className="min-h-dvh bg-[#07090f] px-4 py-10 text-white">
        <section className="mx-auto flex min-h-[calc(100dvh-80px)] w-full max-w-md items-center">
          <form onSubmit={login} className="w-full rounded-lg border border-white/10 bg-[#10141f] p-6 shadow-violet">
            <div className="mb-6 flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-300/10 text-emerald-100">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <div>
                <h1 className="text-xl font-black">Painel Dragon Store</h1>
                <p className="text-sm text-slate-400">Acesso protegido</p>
              </div>
            </div>

            <label className="block text-sm font-bold text-slate-200" htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="mt-2 h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 text-white outline-none"
              autoComplete="current-password"
            />
            {status ? <p className="mt-3 text-sm text-amber-200">{status}</p> : null}
            <button
              type="submit"
              disabled={busy}
              className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-4 text-sm font-black text-black transition hover:bg-cyan-200 disabled:opacity-50"
            >
              <LogIn className="h-4 w-4" />
              Entrar
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#07090f] px-4 py-8 text-white">
      <section className="mx-auto w-full max-w-7xl">
        <header className="mb-6 flex flex-col justify-between gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-bold uppercase text-emerald-200">Dragon Store</p>
            <h1 className="text-3xl font-black">Painel do site</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={testBot} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold transition hover:bg-white/10 disabled:opacity-50">
              <TestTube2 className="h-4 w-4" />
              Testar bot
            </button>
            <button onClick={syncProducts} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold transition hover:bg-white/10 disabled:opacity-50">
              <RefreshCw className="h-4 w-4" />
              Sincronizar
            </button>
            <button onClick={loadAnalytics} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold transition hover:bg-white/10 disabled:opacity-50">
              <BarChart3 className="h-4 w-4" />
              Atualizar metricas
            </button>
            <button onClick={saveConfig} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-black text-black transition hover:bg-cyan-200 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar
            </button>
            <button onClick={logout} className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/30 bg-red-400/10 px-3 text-sm font-bold text-red-100 transition hover:bg-red-400/20">
              <LogOut className="h-4 w-4" />
              Sair
            </button>
          </div>
        </header>

        {status ? (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-3 text-sm text-emerald-100">
            <CheckCircle2 className="h-4 w-4" />
            {status}
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
          <section className="grid gap-5">
            <div className="grid gap-4 rounded-lg border border-white/10 bg-[#10141f] p-5 md:grid-cols-2">
              <Field label="Nome da loja" value={config.storeName} onChange={value => update("storeName", value)} />
              <Field label="Subtitulo" value={config.subtitle} onChange={value => update("subtitle", value)} />
              <Field label="Titulo da home" value={config.heroTitle} onChange={value => update("heroTitle", value)} />
              <Field label="Convite do Discord" value={config.discordInviteUrl} onChange={value => update("discordInviteUrl", value)} />
              <Field label="Link/canal de ticket" value={config.ticketChannelUrl} onChange={value => update("ticketChannelUrl", value)} />
              <Field label="Cor principal" value={config.primaryColor} onChange={value => update("primaryColor", value)} />
              <Field label="Imagem/logo/banner" value={config.heroImageUrl} onChange={value => update("heroImageUrl", value)} />
              <label className="flex min-h-11 items-center gap-3 rounded-md border border-white/10 bg-black/25 px-3">
                <input
                  type="checkbox"
                  checked={Boolean(config.manualCatalogEnabled)}
                  onChange={event => update("manualCatalogEnabled", event.target.checked)}
                  className="h-4 w-4 accent-emerald-300"
                />
                <span className="text-sm font-bold text-slate-200">Catalogo manual ativo</span>
              </label>
              <div className="md:col-span-2">
                <TextField label="Texto principal" value={config.heroText} onChange={value => update("heroText", value)} rows={3} />
              </div>
              <div className="md:col-span-2">
                <TextField label="Textos de confianca" value={trustText} onChange={setTrustText} rows={5} />
              </div>
            </div>

            <section className="rounded-lg border border-white/10 bg-[#10141f] p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-black">Produtos e categorias</h2>
                  <p className="text-sm text-slate-400">{categories.length} categorias, {productLabel(flattenProducts(categories).length)}</p>
                </div>
                <button onClick={addCategory} className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-3 text-sm font-black text-black transition hover:bg-emerald-200">
                  <Plus className="h-4 w-4" />
                  Categoria
                </button>
              </div>

              <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
                <div className="grid content-start gap-2">
                  {categories.map(category => (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => setSelectedCategoryId(category.id)}
                      className={`rounded-md border px-3 py-3 text-left text-sm transition ${selectedCategory?.id === category.id ? "border-emerald-300/50 bg-emerald-300/10 text-white" : "border-white/10 bg-white/[.04] text-slate-300 hover:bg-white/[.08]"}`}
                    >
                      <strong className="block truncate">{category.title}</strong>
                      <span className="text-xs text-slate-500">{productLabel(category.products.length)}</span>
                    </button>
                  ))}
                </div>

                {selectedCategory ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                      <Field label="ID da categoria" value={selectedCategory.id} onChange={value => changeCategoryId(selectedCategory.id, value)} />
                      <Field label="Titulo" value={selectedCategory.title} onChange={value => updateCategory(selectedCategory.id, { title: value })} />
                      <Field label="Imagem da categoria" value={selectedCategory.imageUrl || ""} onChange={value => updateCategory(selectedCategory.id, { imageUrl: value })} />
                      <Field label="Cor" value={selectedCategory.color || config.primaryColor} onChange={value => updateCategory(selectedCategory.id, { color: value })} />
                      <div className="md:col-span-2">
                        <TextField label="Descricao" value={selectedCategory.description} onChange={value => updateCategory(selectedCategory.id, { description: value })} rows={4} />
                      </div>
                      <div className="flex gap-2 md:col-span-2">
                        <button onClick={() => addProduct(selectedCategory.id)} className="inline-flex h-10 items-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-black text-black transition hover:bg-cyan-200">
                          <Plus className="h-4 w-4" />
                          Produto
                        </button>
                        <button onClick={() => removeCategory(selectedCategory.id)} className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/30 bg-red-400/10 px-3 text-sm font-bold text-red-100 transition hover:bg-red-400/20">
                          <Trash2 className="h-4 w-4" />
                          Remover categoria
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      {selectedCategory.products.map(product => (
                        <div key={product.id} className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                          <Field label="ID" value={product.id} onChange={value => updateProduct(selectedCategory.id, product.id, { id: slugify(value) })} />
                          <Field label="Nome" value={product.name} onChange={value => updateProduct(selectedCategory.id, product.id, { name: value })} />
                          <Field label="Preco" value={product.price} onChange={value => updateProduct(selectedCategory.id, product.id, { price: value })} />
                          <Field label="Estoque" value={product.stock} onChange={value => updateProduct(selectedCategory.id, product.id, { stock: value })} />
                          <Field label="Imagem do produto" value={product.imageUrl || ""} onChange={value => updateProduct(selectedCategory.id, product.id, { imageUrl: value })} />
                          <Field label="Tipo" value={product.type || "normal"} onChange={value => updateProduct(selectedCategory.id, product.id, { type: value })} />
                          <div className="md:col-span-2">
                            <TextField label="Descricao" value={product.description} onChange={value => updateProduct(selectedCategory.id, product.id, { description: value })} rows={3} />
                          </div>
                          <div className="md:col-span-2">
                            <button onClick={() => removeProduct(selectedCategory.id, product.id)} className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/30 bg-red-400/10 px-3 text-sm font-bold text-red-100 transition hover:bg-red-400/20">
                              <Trash2 className="h-4 w-4" />
                              Remover produto
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-white/15 p-6 text-sm text-slate-400">Nenhuma categoria cadastrada.</div>
                )}
              </div>
            </section>
          </section>

          <aside className="grid content-start gap-4">
            <section className="rounded-lg border border-white/10 bg-[#10141f] p-5">
              <h2 className="text-lg font-black">Bot</h2>
              <div className="mt-4 grid gap-4">
                <Field label="URL da API do bot" value={config.botApiUrl} onChange={value => update("botApiUrl", value)} />
                <Field label={`Token da API (${tokenLabel})`} value={config.botApiToken || ""} onChange={value => update("botApiToken", value)} type="password" />
              </div>
            </section>

            <section className="rounded-lg border border-white/10 bg-[#10141f] p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-black">Trafego</h2>
                <BarChart3 className="h-5 w-5 text-emerald-200" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Visitantes hoje" value={analytics?.totals.todayVisitors ?? 0} />
                <Metric label="Visitantes semana" value={analytics?.totals.weekVisitors ?? 0} />
                <Metric label="Views hoje" value={analytics?.totals.todayPageViews ?? 0} />
                <Metric label="Views semana" value={analytics?.totals.weekPageViews ?? 0} />
              </div>
              <div className="mt-5 space-y-2">
                <h3 className="text-sm font-black uppercase text-slate-300">Produtos mais clicados</h3>
                {analytics?.topProducts.length ? analytics.topProducts.slice(0, 8).map(product => (
                  <div key={product.productId} className="rounded-md border border-white/10 bg-black/20 p-3">
                    <strong className="block truncate text-sm text-white">{product.productName}</strong>
                    <p className="mt-1 text-xs text-slate-400">{product.totalClicks} total | {product.todayClicks} hoje | {product.weekClicks} semana</p>
                  </div>
                )) : (
                  <p className="rounded-md border border-dashed border-white/15 p-3 text-sm text-slate-400">Sem cliques registrados ainda.</p>
                )}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/25 p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-white">{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <input
        type={type}
        value={value || ""}
        onChange={event => onChange(event.target.value)}
        className="mt-2 h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 text-white outline-none"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  rows
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <textarea
        value={value || ""}
        onChange={event => onChange(event.target.value)}
        rows={rows}
        className="mt-2 w-full rounded-md border border-white/10 bg-black/30 p-3 text-white outline-none"
      />
    </label>
  );
}
