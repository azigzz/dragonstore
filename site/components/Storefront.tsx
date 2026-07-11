"use client";

/* eslint-disable @next/next/no-img-element */

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowRight, BadgeCheck, CheckCircle2, Clock3, Headphones, PackageOpen, Search, ShieldCheck, ShoppingBag } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import CartDrawer from "@/components/CartDrawer";
import CategoryCard from "@/components/CategoryCard";
import Header from "@/components/Header";
import { catalogKind, catalogTagsFor, publicDiscordInvite } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { SiteConfig, StoreData } from "@/lib/types";
import { useStoreCart } from "@/lib/use-store-cart";

type StorefrontProps = {
  store: StoreData;
  config: SiteConfig;
};

export default function Storefront({ store, config }: StorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("todos");
  const cart = useStoreCart();
  const categories = store.categories?.length ? store.categories : [];
  const products = store.products || [];
  const discordUrl = publicDiscordInvite(config.discordInviteUrl || store.discordInviteUrl);
  const filters = useMemo(() => [{ id: "todos", label: "Tudo" }, ...catalogTagsFor(categories)], [categories]);
  const heroImage = config.heroImageUrl || "/savio-store-logo.png";
  const style = { "--brand": config.primaryColor || "#55f28b" } as CSSProperties;

  const filteredCategories = useMemo(() => {
    const term = query.trim().toLowerCase();
    return categories.filter(category => {
      const seed = `${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`;
      const matchesTag = tag === "todos" || catalogKind(seed) === tag;
      const matchesQuery = !term || `${seed} ${category.products.map(product => product.price).join(" ")}`.toLowerCase().includes(term);
      return matchesTag && matchesQuery;
    });
  }, [categories, query, tag]);

  useEffect(() => {
    trackEvent({ type: "page_view", path: "/" });
  }, []);

  return (
    <main className="brand-root" style={style}>
      <Header config={config} cartCount={cart.cartCount} onCartClick={() => setCartOpen(true)} />

      <section className="store-hero" aria-labelledby="store-title">
        <img src={heroImage} alt="" className="store-hero-image" />
        <div className="store-hero-veil" />
        <div className="cinematic-lines" />
        <div className="store-container relative flex min-h-[calc(100svh-120px)] max-h-[700px] items-end pb-20 pt-32 sm:items-center sm:pb-16 sm:pt-24">
          <div className="hero-content max-w-[670px]">
            <div className="hero-kicker"><BadgeCheck className="h-4 w-4" /> Loja oficial no Discord</div>
            <h1 id="store-title" className="hero-title">{config.storeName}</h1>
            <p className="hero-copy">{config.heroText}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#catalogo" className="primary-command min-w-44">
                Explorar catalogo <ArrowDown className="h-4 w-4" />
              </a>
              <a href={discordUrl} target="_blank" rel="noreferrer" className="secondary-command min-w-44">
                Falar com a equipe <ArrowRight className="h-4 w-4" />
              </a>
            </div>
            <div className="hero-facts">
              <span><ShieldCheck className="h-4 w-4" /> Pedido validado</span>
              <span><Clock3 className="h-4 w-4" /> Atendimento direto</span>
              <span><ShoppingBag className="h-4 w-4" /> Catalogo atualizado</span>
            </div>
          </div>
        </div>
        <a href="#catalogo" className="hero-peek" aria-label="Ir para o catalogo"><ArrowDown className="h-4 w-4" /></a>
      </section>

      <section id="catalogo" className="catalog-band">
        <div className="store-container py-14 sm:py-20">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Catalogo ao vivo</p>
              <h2>Encontre o que voce procura</h2>
              <p>{categories.length} {categories.length === 1 ? "categoria" : "categorias"} e {products.length} {products.length === 1 ? "produto" : "produtos"}</p>
            </div>
            <label className="search-field">
              <Search className="h-4 w-4" />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar produto ou categoria" />
            </label>
          </div>

          {filters.length > 2 ? (
            <div className="filter-strip" role="group" aria-label="Filtrar catalogo">
              {filters.map(filter => (
                <button key={filter.id} type="button" onClick={() => setTag(filter.id)} className={tag === filter.id ? "active" : ""}>
                  {filter.label}
                </button>
              ))}
            </div>
          ) : null}

          {filteredCategories.length ? (
            <div className="category-grid">
              {filteredCategories.map(category => (
                <div key={category.id}>
                  <CategoryCard category={category} fallbackImage={heroImage} />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state min-h-72">
              <PackageOpen className="h-9 w-9 text-zinc-600" />
              <h3 className="mt-4 text-xl font-black text-white">{query ? "Nenhum resultado encontrado" : "Catalogo sendo atualizado"}</h3>
              <p className="mt-2 max-w-md text-center text-sm leading-6 text-zinc-500">
                {query ? "Tente outro termo ou veja todas as categorias." : "Os produtos publicados pelo bot aparecerao aqui automaticamente."}
              </p>
              <a href={discordUrl} target="_blank" rel="noreferrer" className="secondary-command mt-6">Consultar no Discord</a>
            </div>
          )}
        </div>
      </section>

      <section id="como-funciona" className="process-band">
        <div className="store-container grid gap-8 py-12 md:grid-cols-[1fr_1.6fr] md:items-center sm:py-16">
          <div>
            <p className="section-kicker">Compra identificada</p>
            <h2 className="text-3xl font-black text-white">Do catalogo ao atendimento, sem perder seu pedido.</h2>
          </div>
          <div className="process-line">
            <div><span>01</span><strong>Escolha</strong><small>Produtos e quantidades</small></div>
            <div><span>02</span><strong>Gere o ID</strong><small>Total validado pelo bot</small></div>
            <div><span>03</span><strong>Conclua</strong><small>Atendimento no Discord</small></div>
          </div>
        </div>
      </section>

      <section className="support-band">
        <div className="store-container flex flex-col gap-6 py-12 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="support-icon"><Headphones className="h-5 w-5" /></span>
            <div>
              <p className="section-kicker">Suporte humano</p>
              <h2 className="text-2xl font-black text-white">Ficou com alguma duvida?</h2>
              <p className="mt-2 text-sm text-zinc-500">Nossa equipe atende diretamente no servidor oficial.</p>
            </div>
          </div>
          <a href={discordUrl} target="_blank" rel="noreferrer" className="primary-command">Abrir Discord <ArrowRight className="h-4 w-4" /></a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="store-container flex flex-col gap-4 py-7 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
          <span>Sávio Store | Produtos digitais</span>
          <span>Atendimento e pagamento realizados no Discord oficial.</span>
        </div>
      </footer>

      <CartDrawer
        open={cartOpen}
        items={cart.cart}
        store={store}
        config={config}
        onClose={() => setCartOpen(false)}
        onAdd={cart.addProduct}
        onDecrease={cart.decreaseProduct}
        onRemove={cart.removeProduct}
        onClear={cart.clearCart}
      />

      <AnimatePresence>
        {cart.notice ? (
          <motion.button
            type="button"
            onClick={() => setCartOpen(true)}
            initial={{ opacity: 0, y: 18, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: 18, x: "-50%" }}
            className="cart-toast"
          >
            <CheckCircle2 className="h-4 w-4" /> {cart.notice} <span>Ver pedido</span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
