"use client";

import { BarChart3, CheckCircle2, Copy, Eye, EyeOff, LogIn, LogOut, Plus, RefreshCw, Save, ShieldCheck, TestTube2, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AdminConfigPayload, AnalyticsSummary, StoreCategory, StoreProduct } from "@/lib/types";

type AdminPanelProps = {
  loggedIn: boolean;
  initialConfig: AdminConfigPayload | null;
};

const emptyConfig: AdminConfigPayload = {
  storeName: "Sávio Store",
  subtitle: "Loja digital pelo Discord",
  heroTitle: "Produtos digitais com compra rapida pelo Discord",
  heroText: "Escolha seus produtos, monte seu carrinho e finalize pelo Discord.",
  discordInviteUrl: "",
  ticketChannelUrl: "",
  botApiUrl: "",
  botApiToken: "",
  botApiTokenConfigured: false,
  primaryColor: "#28f6a1",
  heroImageUrl: "/savio-store-logo.png",
  trustBadges: ["Carrinho rapido", "Atendimento por ADM", "Pagamento via Pix", "Produtos digitais", "Suporte no Discord"],
  manualCatalogEnabled: false,
  safeCatalogEnabled: false,
  safeProductKeys: [],
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
function priceCentsFromLabel(value: string) {
  const raw = String(value || "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(raw);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function newProduct(index: number): StoreProduct {
  return {
    id: `produto-${Date.now().toString(36)}-${index}`,
    name: "Novo produto",
    price: "R$ 0,00",
    priceCents: 0,
    description: "Produto digital da Sávio Store",
    stock: "sob consulta",
    imageUrl: "/savio-store-logo.png",
    type: "normal"
  };
}

function productsToCategory(products: StoreProduct[]): StoreCategory[] {
  if (!products.length) return [];
  return [{
    id: "catalogo",
    title: "Catalogo",
    description: "Produtos digitais da Sávio Store",
    imageUrl: "/savio-store-logo.png",
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

function uniqueId(base: string, existing: Iterable<string>) {
  const cleanBase = slugify(base);
  const used = new Set([...existing]);
  if (!used.has(cleanBase)) return cleanBase;
  let suffix = 2;
  while (used.has(`${cleanBase}-${suffix}`)) suffix += 1;
  return `${cleanBase}-${suffix}`;
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
  const [csrfToken, setCsrfToken] = useState(initialConfig?.csrfToken || "");

  const tokenLabel = useMemo(() => config.botApiTokenConfigured ? "Token ja configurado" : "Token ainda nao salvo", [config.botApiTokenConfigured]);
  const selectedCategory = categories.find(category => category.id === selectedCategoryId) || categories[0] || null;
  const safeKeys = useMemo(() => new Set(config.safeProductKeys || []), [config.safeProductKeys]);
  const allProductKeys = useMemo(() => categories.flatMap(category => category.products.map(product => `${category.id}:${product.id}`)), [categories]);
  const visibleProductCount = allProductKeys.filter(key => safeKeys.has(key)).length;

  useEffect(() => {
    if (isLoggedIn) {
      loadConfig();
      loadAnalytics();
    }
  }, [isLoggedIn]);

  function adminHeaders(contentType = true) {
    return {
      ...(contentType ? { "Content-Type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {})
    };
  }

  async function loadConfig() {
    const response = await fetch("/api/admin/config", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as AdminConfigPayload;
    const nextCategories = normalizeCategories(data);
    setConfig(data);
    setCsrfToken(data.csrfToken || "");
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
    const data = await response.json().catch(() => ({}));
    setCsrfToken(String(data.csrfToken || ""));
    setIsLoggedIn(true);
    setPassword("");
    setStatus("Login aprovado.");
    await loadConfig();
    await loadAnalytics();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", headers: adminHeaders(false) });
    setIsLoggedIn(false);
    setCsrfToken("");
  }

  function update<K extends keyof AdminConfigPayload>(key: K, value: AdminConfigPayload[K]) {
    setConfig(current => ({ ...current, [key]: value }));
  }

  function updateCategory(categoryId: string, patch: Partial<StoreCategory>) {
    setCategories(current => current.map(category => category.id === categoryId ? { ...category, ...patch } : category));
  }

  function changeCategoryId(oldId: string, value: string) {
    const nextId = uniqueId(value, categories.filter(category => category.id !== oldId).map(category => category.id));
    if (!nextId) return;
    setCategories(current => current.map(category => category.id === oldId ? { ...category, id: nextId } : category));
    setSafeKeys([...safeKeys].map(key => key.startsWith(`${oldId}:`) ? `${nextId}:${key.slice(oldId.length + 1)}` : key));
    setSelectedCategoryId(nextId);
  }

  function updateProduct(categoryId: string, productId: string, patch: Partial<StoreProduct>) {
    const nextProductId = patch.id && patch.id !== productId ? patch.id : "";
    setCategories(current => current.map(category => {
      if (category.id !== categoryId) return category;
      return {
        ...category,
        products: category.products.map(product => product.id === productId ? { ...product, ...patch } : product)
      };
    }));
    if (nextProductId && safeKeys.has(`${categoryId}:${productId}`)) {
      const next = new Set(safeKeys);
      next.delete(`${categoryId}:${productId}`);
      next.add(`${categoryId}:${nextProductId}`);
      setSafeKeys(next);
    }
  }

  function setSafeKeys(keys: Iterable<string>) {
    update("safeProductKeys", [...new Set(keys)]);
  }

  function setProductVisibility(categoryId: string, productId: string, visible: boolean) {
    const key = `${categoryId}:${productId}`;
    const next = new Set(safeKeys);
    if (visible) next.add(key);
    else next.delete(key);
    setSafeKeys(next);
  }

  function setCategoryVisibility(category: StoreCategory, visible: boolean) {
    const next = new Set(safeKeys);
    for (const product of category.products) {
      const key = `${category.id}:${product.id}`;
      if (visible) next.add(key);
      else next.delete(key);
    }
    setSafeKeys(next);
  }

  function categoryVisibilityCount(category: StoreCategory) {
    return category.products.filter(product => safeKeys.has(`${category.id}:${product.id}`)).length;
  }

  function addCategory() {
    const id = uniqueId(`categoria-${Date.now().toString(36)}`, categories.map(category => category.id));
    const category: StoreCategory = {
      id,
      title: "Nova categoria",
      description: "Produtos digitais da Sávio Store",
      imageUrl: "/savio-store-logo.png",
      color: config.primaryColor || "#28f6a1",
      products: [newProduct(1)]
    };
    setCategories(current => [...current, category]);
    setSelectedCategoryId(id);
  }

  function duplicateCategory(categoryId: string) {
    const source = categories.find(category => category.id === categoryId);
    if (!source) return;
    const id = uniqueId(`${source.id}-copia`, categories.map(category => category.id));
    const category: StoreCategory = {
      ...source,
      id,
      title: `${source.title} copia`,
      products: source.products.map((product, index) => ({
        ...product,
        id: uniqueId(`${product.id}-copia`, source.products.map(item => item.id).concat(`${product.id}-${index}`))
      }))
    };
    setCategories(current => {
      const index = current.findIndex(item => item.id === categoryId);
      const next = [...current];
      next.splice(index + 1, 0, category);
      return next;
    });
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

  function duplicateProduct(categoryId: string, productId: string) {
    setCategories(current => current.map(category => {
      if (category.id !== categoryId) return category;
      const source = category.products.find(product => product.id === productId);
      if (!source) return category;
      const id = uniqueId(`${source.id}-copia`, category.products.map(product => product.id));
      const product = { ...source, id, name: `${source.name} copia` };
      const index = category.products.findIndex(item => item.id === productId);
      const products = [...category.products];
      products.splice(index + 1, 0, product);
      return { ...category, products };
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
          id: product.id || `${slugify(product.name)}-${productIndex + 1}`,
          priceCents: priceCentsFromLabel(product.price)
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
        headers: adminHeaders(),
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
      headers: adminHeaders(),
      body: JSON.stringify({ botApiUrl: config.botApiUrl, botApiToken: config.botApiToken })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    setStatus(response.ok ? `Conexao OK: ${productLabel(data.products || 0)}.` : data.error || "Falha ao testar bot.");
  }

  async function syncProducts() {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/sync", { method: "POST", headers: adminHeaders(false) });
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
                <h1 className="text-xl font-black">Painel Sávio Store</h1>
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
            <p className="text-sm font-bold uppercase text-emerald-200">Sávio Store</p>
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
              <div className="grid gap-3 rounded-md border border-emerald-300/20 bg-emerald-300/[.06] p-4 md:col-span-2 sm:grid-cols-[1fr_auto] sm:items-center">
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={Boolean(config.safeCatalogEnabled)}
                    onChange={event => update("safeCatalogEnabled", event.target.checked)}
                    className="h-4 w-4 accent-emerald-300"
                  />
                  <span>
                    <strong className="block text-sm text-white">Vitrine segura</strong>
                    <span className="text-xs text-slate-400">Publica somente os produtos marcados abaixo, sem apagar nada.</span>
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs font-bold text-emerald-100">{visibleProductCount}/{allProductKeys.length} visiveis</span>
                  <button type="button" onClick={() => setSafeKeys(allProductKeys)} title="Mostrar todos os produtos" className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-xs font-bold hover:bg-white/10">
                    <Eye className="h-4 w-4" /> Todos
                  </button>
                  <button type="button" onClick={() => setSafeKeys([])} title="Ocultar todos os produtos" className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-xs font-bold hover:bg-white/10">
                    <EyeOff className="h-4 w-4" /> Nenhum
                  </button>
                </div>
              </div>
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
                  {categories.map(category => {
                    const visibleCount = categoryVisibilityCount(category);
                    const allVisible = Boolean(category.products.length) && visibleCount === category.products.length;
                    return (
                      <div key={category.id} className={`grid grid-cols-[1fr_40px] overflow-hidden rounded-md border transition ${selectedCategory?.id === category.id ? "border-emerald-300/50 bg-emerald-300/10" : "border-white/10 bg-white/[.04]"}`}>
                        <button type="button" onClick={() => setSelectedCategoryId(category.id)} className="min-w-0 px-3 py-3 text-left text-sm text-slate-300 hover:bg-white/[.05]">
                          <strong className="block truncate text-white">{category.title}</strong>
                          <span className="text-xs text-slate-500">{visibleCount}/{category.products.length} no site</span>
                        </button>
                        <button type="button" onClick={() => setCategoryVisibility(category, !allVisible)} title={allVisible ? "Ocultar categoria da vitrine" : "Mostrar categoria na vitrine"} className="flex items-center justify-center border-l border-white/10 text-slate-300 hover:bg-white/10 hover:text-white">
                          {allVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      </div>
                    );
                  })}
                </div>

                {selectedCategory ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
                        <span className="text-sm font-bold text-slate-300">Visibilidade da categoria</span>
                        <button type="button" onClick={() => setCategoryVisibility(selectedCategory, categoryVisibilityCount(selectedCategory) !== selectedCategory.products.length)} className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-xs font-bold hover:bg-white/10">
                          {categoryVisibilityCount(selectedCategory) === selectedCategory.products.length ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          {categoryVisibilityCount(selectedCategory) === selectedCategory.products.length ? "Categoria visivel" : `${categoryVisibilityCount(selectedCategory)}/${selectedCategory.products.length} visiveis`}
                        </button>
                      </div>
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
                        <button onClick={() => duplicateCategory(selectedCategory.id)} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold text-white transition hover:bg-white/10">
                          <Copy className="h-4 w-4" />
                          Duplicar categoria
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
                          <label className="flex min-h-10 items-center gap-3 rounded-md border border-white/10 bg-white/[.04] px-3 md:col-span-2">
                            <input type="checkbox" checked={safeKeys.has(`${selectedCategory.id}:${product.id}`)} onChange={event => setProductVisibility(selectedCategory.id, product.id, event.target.checked)} className="h-4 w-4 accent-emerald-300" />
                            <span className="inline-flex items-center gap-2 text-sm font-bold text-slate-200">
                              {safeKeys.has(`${selectedCategory.id}:${product.id}`) ? <Eye className="h-4 w-4 text-emerald-200" /> : <EyeOff className="h-4 w-4 text-slate-500" />}
                              Mostrar na vitrine segura
                            </span>
                          </label>
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
                            <div className="flex flex-wrap gap-2">
                              <button onClick={() => duplicateProduct(selectedCategory.id, product.id)} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold text-white transition hover:bg-white/10">
                                <Copy className="h-4 w-4" />
                                Duplicar produto
                              </button>
                              <button onClick={() => removeProduct(selectedCategory.id, product.id)} className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/30 bg-red-400/10 px-3 text-sm font-bold text-red-100 transition hover:bg-red-400/20">
                                <Trash2 className="h-4 w-4" />
                                Remover produto
                              </button>
                            </div>
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
                <Metric label="Pedidos hoje" value={analytics?.totals.todayOrders ?? 0} />
                <Metric label="Pedidos total" value={analytics?.totals.totalOrders ?? 0} />
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
