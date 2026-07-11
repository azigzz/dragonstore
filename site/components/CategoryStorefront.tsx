"use client";

/* eslint-disable @next/next/no-img-element */

import { ArrowLeft, CheckCircle2, Layers3, Search, ShoppingBag } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import CartDrawer from "@/components/CartDrawer";
import Header from "@/components/Header";
import ProductCard from "@/components/ProductCard";
import { categoryDescription, categoryImage, categoryPriceLabel, publicDiscordInvite } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { SiteConfig, StoreCategory, StoreData } from "@/lib/types";
import { useStoreCart } from "@/lib/use-store-cart";

type CategoryStorefrontProps = {
  store: StoreData;
  config: SiteConfig;
  category: StoreCategory;
};

export default function CategoryStorefront({ store, config, category }: CategoryStorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [query, setQuery] = useState("");
  const cart = useStoreCart();
  const heroImage = categoryImage(category, store.imageUrl || config.heroImageUrl || "/savio-store-logo.png");
  const description = categoryDescription(category.description);
  const discordUrl = publicDiscordInvite(config.discordInviteUrl || store.discordInviteUrl);
  const style = { "--brand": config.primaryColor || "#55f28b" } as CSSProperties;
  const filteredProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term
      ? category.products.filter(product => `${product.name} ${product.description} ${product.price} ${product.stock}`.toLowerCase().includes(term))
      : category.products;
  }, [category.products, query]);

  useEffect(() => {
    trackEvent({ type: "page_view", path: `/categoria/${category.id}`, categoryId: category.id, categoryTitle: category.title });
  }, [category.id, category.title]);

  return (
    <main className="brand-root" style={style}>
      <Header config={config} cartCount={cart.cartCount} onCartClick={() => setCartOpen(true)} />

      <section className="category-hero">
        <img src={heroImage} alt="" className="category-hero-image" />
        <div className="category-hero-veil" />
        <div className="cinematic-lines" />
        <div className="store-container relative flex min-h-[540px] items-end pb-14 pt-28 sm:items-center sm:pb-12">
          <div className="hero-content max-w-3xl">
            <Link href="/#catalogo" className="back-link"><ArrowLeft className="h-4 w-4" /> Voltar ao catalogo</Link>
            <div className="mt-7"><p className="section-kicker">{categoryPriceLabel(category)}</p></div>
            <h1 className="mt-3 text-5xl font-black leading-none text-white sm:text-6xl">{category.title}</h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-300 sm:text-lg">{description}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href="#produtos" className="primary-command"><ShoppingBag className="h-4 w-4" /> Ver produtos</a>
              <span className="hero-count"><Layers3 className="h-4 w-4" /> {category.products.length} opcoes disponiveis</span>
            </div>
          </div>
        </div>
      </section>

      <section id="produtos" className="catalog-band">
        <div className="store-container py-14 sm:py-20">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Escolha sua opcao</p>
              <h2>{category.title}</h2>
              <p>Precos e disponibilidade sincronizados com o painel do Discord.</p>
            </div>
            <label className="search-field">
              <Search className="h-4 w-4" />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar nesta categoria" />
            </label>
          </div>

          {filteredProducts.length ? (
            <div className="product-grid">
              {filteredProducts.map(product => (
                <div key={product.id}>
                  <ProductCard product={product} fallbackImage={heroImage} categoryId={category.id} categoryTitle={category.title} discordUrl={discordUrl} onAdd={cart.addProduct} />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state min-h-60">
              <Search className="h-8 w-8 text-zinc-600" />
              <h3 className="mt-4 text-lg font-black text-white">Nenhum produto encontrado</h3>
              <button type="button" onClick={() => setQuery("")} className="secondary-command mt-5">Limpar busca</button>
            </div>
          )}
        </div>
      </section>

      <footer className="site-footer">
        <div className="store-container flex flex-col gap-4 py-7 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
          <span>Sávio Store | Produtos digitais</span>
          <a href={discordUrl} target="_blank" rel="noreferrer" className="transition hover:text-white">Atendimento no Discord oficial</a>
        </div>
      </footer>

      <CartDrawer open={cartOpen} items={cart.cart} store={store} config={config} onClose={() => setCartOpen(false)} onAdd={cart.addProduct} onDecrease={cart.decreaseProduct} onRemove={cart.removeProduct} onClear={cart.clearCart} />

      <AnimatePresence>
        {cart.notice ? (
          <motion.button type="button" onClick={() => setCartOpen(true)} initial={{ opacity: 0, y: 18, x: "-50%" }} animate={{ opacity: 1, y: 0, x: "-50%" }} exit={{ opacity: 0, y: 18, x: "-50%" }} className="cart-toast">
            <CheckCircle2 className="h-4 w-4" /> {cart.notice} <span>Ver pedido</span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
