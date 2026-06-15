"use client";

import { ArrowLeft, ExternalLink, Search, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import CartDrawer, { type CartItem } from "@/components/CartDrawer";
import Header from "@/components/Header";
import ProductCard from "@/components/ProductCard";
import { formatBRL } from "@/lib/money";
import type { SiteConfig, StoreCategory, StoreData, StoreProduct } from "@/lib/types";

type CategoryStorefrontProps = {
  store: StoreData;
  config: SiteConfig;
  category: StoreCategory;
};

const CART_STORAGE_KEY = "dragon-store-cart";

function cleanDescription(text: string) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

function priceLabel(category: StoreCategory) {
  return typeof category.minPrice === "number"
    ? `A partir de ${formatBRL(category.minPrice)}`
    : "Valores no atendimento";
}

export default function CategoryStorefront({ store, config, category }: CategoryStorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const heroImage = category.imageUrl || store.imageUrl || config.heroImageUrl || "/dragon-store-hero.png";
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

      <section
        className="relative overflow-hidden border-b border-white/10 bg-cover bg-center pt-24"
        style={{
          backgroundImage: `linear-gradient(90deg, rgba(7,9,15,.42) 0%, rgba(7,9,15,.78) 44%, rgba(7,9,15,.98) 100%), url(${heroImage})`
        }}
      >
        <div className="grid-texture pointer-events-none absolute inset-0 opacity-30" />
        <div className="dragon-container relative grid min-h-[58vh] content-center pb-14">
          <div className="max-w-3xl">
            <Link href="/#categorias" className="mb-5 inline-flex items-center gap-2 rounded-md border border-white/15 bg-black/35 px-3 py-2 text-sm font-bold text-slate-100 transition hover:border-emerald-300/40 hover:text-white">
              <ArrowLeft className="h-4 w-4" />
              Voltar ao catalogo
            </Link>
            <p className="text-sm font-bold uppercase text-emerald-200">{priceLabel(category)}</p>
            <h1 className="mt-3 text-4xl font-black leading-[1.05] text-white sm:text-5xl lg:text-6xl">{category.title}</h1>
            <p className="mt-5 whitespace-pre-line text-base leading-7 text-slate-200 sm:text-lg">
              {cleanDescription(category.description)}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="#produtos"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-black text-black transition hover:bg-cyan-200"
              >
                Ver produtos
                <ShoppingCart className="h-4 w-4" />
              </a>
              {config.discordInviteUrl ? (
                <a
                  href={config.discordInviteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/[.06] px-5 text-sm font-black text-white transition hover:border-violet-300/40 hover:bg-violet-300/10"
                >
                  Entrar no Discord
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section id="produtos" className="bg-[#07090f] py-14 sm:py-20">
        <div className="dragon-container">
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-bold uppercase text-emerald-200">Produtos</p>
              <h2 className="mt-2 text-3xl font-black text-white">{category.title}</h2>
              <p className="mt-2 text-sm text-slate-400">
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
                  onAdd={addProduct}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/15 p-8 text-slate-300">
              Nenhum produto encontrado nessa busca.
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
