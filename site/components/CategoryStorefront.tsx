"use client";

/* eslint-disable @next/next/no-img-element */

import { ArrowLeft, ExternalLink, Search, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import CartDrawer, { type CartItem } from "@/components/CartDrawer";
import Header from "@/components/Header";
import ProductCard from "@/components/ProductCard";
import { categoryDescription, categoryImage, categoryPriceLabel, publicDiscordInvite } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { SiteConfig, StoreCategory, StoreData, StoreProduct } from "@/lib/types";

type CategoryStorefrontProps = {
  store: StoreData;
  config: SiteConfig;
  category: StoreCategory;
};

const CART_STORAGE_KEY = "dragon-store-cart";

export default function CategoryStorefront({ store, config, category }: CategoryStorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const heroImage = categoryImage(category, store.imageUrl || config.heroImageUrl || "/dragon-store-hero.png");
  const description = categoryDescription(category.description);
  const discordUrl = publicDiscordInvite(config.discordInviteUrl || store.discordInviteUrl);
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);
  const filteredProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return category.products;
    return category.products.filter(product => {
      return [product.name, product.description, product.price, product.stock]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [category.products, query]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CART_STORAGE_KEY);
      if (saved) setCart(JSON.parse(saved));
    } catch {
      setCart([]);
    }
  }, []);

  useEffect(() => {
    trackEvent({
      type: "page_view",
      path: `/categoria/${category.id}`,
      categoryId: category.id,
      categoryTitle: category.title
    });
  }, [category.id, category.title]);

  useEffect(() => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function addProduct(product: StoreProduct) {
    setCart(current => {
      const existing = current.find(item => item.product.id === product.id);
      if (existing) {
        return current.map(item => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...current, { product, quantity: 1 }];
    });
    setNotice(`${product.name} adicionado ao carrinho.`);
  }

  function decreaseProduct(productId: string) {
    setCart(current => current
      .map(item => item.product.id === productId ? { ...item, quantity: item.quantity - 1 } : item)
      .filter(item => item.quantity > 0));
  }

  function removeProduct(productId: string) {
    setCart(current => current.filter(item => item.product.id !== productId));
  }

  return (
    <main>
      <Header config={config} cartCount={cartCount} onCartClick={() => setCartOpen(true)} />

      <section className="relative overflow-hidden border-b border-white/10 bg-[#07090f] pt-20">
        <div
          className="absolute inset-y-0 right-0 hidden w-1/2 bg-cover bg-center opacity-35 lg:block"
          style={{ backgroundImage: `url(${heroImage})` }}
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#07090f_0%,rgba(7,9,15,.94)_54%,rgba(7,9,15,.72)_100%)]" />
        <div className="grid-texture pointer-events-none absolute inset-0 opacity-30" />
        <div className="dragon-container relative grid gap-6 py-8 sm:py-10 lg:grid-cols-[1fr_360px] lg:items-center">
          <div className="max-w-3xl">
            <Link href="/#categorias" className="mb-5 inline-flex items-center gap-2 rounded-md border border-white/15 bg-black/35 px-3 py-2 text-sm font-bold text-slate-100 transition hover:border-emerald-300/40 hover:text-white">
              <ArrowLeft className="h-4 w-4" />
              Voltar ao catalogo
            </Link>
            <p className="text-sm font-bold uppercase text-emerald-200">{categoryPriceLabel(category)}</p>
            <h1 className="mt-3 text-4xl font-black leading-[1.05] text-white sm:text-5xl">{category.title}</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-200">
              {description}
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <a
                href="#produtos"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-black text-black transition hover:bg-cyan-200"
              >
                Ver produtos
                <ShoppingCart className="h-4 w-4" />
              </a>
              <a
                href={discordUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/[.06] px-5 text-sm font-black text-white transition hover:border-violet-300/40 hover:bg-violet-300/10"
              >
                Entrar no Discord
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
          <div className="hidden overflow-hidden rounded-lg border border-white/10 bg-white/[.04] shadow-neon lg:block">
            <img src={heroImage} alt={category.title} className="aspect-[4/3] w-full object-cover" />
          </div>
        </div>
      </section>

      <section id="produtos" className="bg-[#07090f] py-10 sm:py-14">
        <div className="dragon-container">
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-bold uppercase text-emerald-200">Produtos</p>
              <h2 className="mt-2 text-3xl font-black text-white">{category.title}</h2>
              <p className="mt-2 text-xs font-semibold uppercase text-slate-500">
                {category.products.length} {category.products.length === 1 ? "produto disponivel" : "produtos disponiveis"} nesta secao.
              </p>
            </div>
            <label className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Buscar produto"
                className="h-11 w-full rounded-md border border-white/10 bg-white/[.06] pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300/50"
              />
            </label>
          </div>

          {filteredProducts.length ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {filteredProducts.map(product => (
                <ProductCard
                  key={product.id}
                  product={product}
                  fallbackImage={heroImage}
                  categoryId={category.id}
                  categoryTitle={category.title}
                  discordUrl={discordUrl}
                  onAdd={addProduct}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/15 p-8 text-slate-300">
              Nenhum produto disponivel nesta categoria no momento.
            </div>
          )}
        </div>
      </section>

      <CartDrawer
        open={cartOpen}
        items={cart}
        store={store}
        config={config}
        onClose={() => setCartOpen(false)}
        onAdd={addProduct}
        onDecrease={decreaseProduct}
        onRemove={removeProduct}
        onClear={() => setCart([])}
      />

      {notice ? (
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-32px)] max-w-md -translate-x-1/2 rounded-lg border border-emerald-300/30 bg-[#10141f] px-4 py-3 text-left text-sm font-bold text-emerald-100 shadow-neon transition hover:bg-[#151b29]"
        >
          {notice} <span className="text-white">Ver carrinho</span>
        </button>
      ) : null}
    </main>
  );
}
