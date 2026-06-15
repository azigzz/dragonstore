"use client";

import { motion } from "framer-motion";
import { ArrowRight, BadgeCheck, Headphones, Search, ShieldCheck, ShoppingCart, Sparkles, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import CartDrawer, { type CartItem } from "@/components/CartDrawer";
import Header from "@/components/Header";
import ProductCard from "@/components/ProductCard";
import type { SiteConfig, StoreData, StoreProduct } from "@/lib/types";

type StorefrontProps = {
  store: StoreData;
  config: SiteConfig;
};

const icons = [ShoppingCart, Headphones, WalletCards, Sparkles, ShieldCheck];
const CART_STORAGE_KEY = "dragon-store-cart";

export default function Storefront({ store, config }: StorefrontProps) {
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const heroImage = store.imageUrl || config.heroImageUrl || "/dragon-store-hero.png";
  const products = store.products || [];
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);
  const trust = useMemo(() => config.trustBadges.slice(0, 5), [config.trustBadges]);
  const productCountText = `${products.length} ${products.length === 1 ? "produto disponivel" : "produtos disponiveis"} para atendimento.`;
  const filteredProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return products;
    return products.filter(product => {
      return [product.name, product.description, product.price, product.stock]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [products, query]);

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
        className="relative min-h-[76vh] overflow-hidden border-b border-white/10 bg-cover bg-center pt-24"
        style={{
          backgroundImage: `linear-gradient(90deg, rgba(7,9,15,.48) 0%, rgba(7,9,15,.72) 38%, rgba(7,9,15,.98) 100%), url(${heroImage})`
        }}
      >
        <div className="grid-texture pointer-events-none absolute inset-0 opacity-35" />
        <div className="dragon-container relative grid min-h-[calc(76vh-96px)] content-center pb-20 lg:justify-items-end">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="max-w-2xl"
          >
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-emerald-300/30 bg-black/35 px-3 py-2 text-xs font-bold uppercase text-emerald-100 backdrop-blur">
              <BadgeCheck className="h-4 w-4" />
              Catalogo atualizado
            </div>
            <h1 className="text-4xl font-black leading-[1.05] text-white sm:text-5xl lg:text-6xl">
              {config.heroTitle || store.title}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-200 sm:text-lg">
              {config.heroText || store.description}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="#produtos"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-black text-black transition hover:bg-cyan-200"
              >
                Ver produtos
                <ArrowRight className="h-4 w-4" />
              </a>
              {config.discordInviteUrl ? (
                <a
                  href={config.discordInviteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/[.06] px-5 text-sm font-black text-white transition hover:border-violet-300/40 hover:bg-violet-300/10"
                >
                  Entrar no Discord
                </a>
              ) : null}
            </div>
          </motion.div>
        </div>
      </section>

      <section className="border-b border-white/10 bg-[#090d15] py-8">
        <div className="dragon-container grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {trust.map((label, index) => {
            const Icon = icons[index] || ShieldCheck;
            return (
              <div key={label} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[.04] p-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300/10 text-emerald-100">
                  <Icon className="h-5 w-5" />
                </span>
                <strong className="text-sm text-white">{label}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section id="produtos" className="bg-[#07090f] py-14 sm:py-20">
        <div className="dragon-container">
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-bold uppercase text-emerald-200">Catalogo</p>
              <h2 className="mt-2 text-3xl font-black text-white">Produtos digitais</h2>
              <p className="mt-2 text-sm text-slate-400">{productCountText}</p>
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

      <section className="border-t border-white/10 bg-[#090d15] py-12">
        <div className="dragon-container grid gap-4 md:grid-cols-3">
          {[
            ["1", "Monte seu pedido", "Adicione os produtos desejados ao carrinho."],
            ["2", "Copie o resumo", "O site gera um codigo organizado para atendimento."],
            ["3", "Finalize no Discord", "Abra o servidor e envie o pedido para a equipe."]
          ].map(([step, title, text]) => (
            <div key={step} className="rounded-lg border border-white/10 bg-white/[.04] p-5">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-300 text-sm font-black text-black">{step}</span>
              <h3 className="mt-4 text-lg font-black text-white">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#0b0f18] py-12">
        <div className="dragon-container flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-bold uppercase text-violet-200">Dragon Store</p>
            <h2 className="mt-2 text-2xl font-black text-white">Finalize pelo Discord com atendimento manual.</h2>
          </div>
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-white px-5 text-sm font-black text-black transition hover:bg-emerald-200"
          >
            <ShoppingCart className="h-4 w-4" />
            Abrir carrinho
          </button>
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
