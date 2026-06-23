"use client";

import { motion } from "framer-motion";
import { ArrowRight, BadgeCheck, Headphones, Search, ShieldCheck, ShoppingCart, Sparkles, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import CartDrawer, { type CartItem } from "@/components/CartDrawer";
import CategoryCard from "@/components/CategoryCard";
import Header from "@/components/Header";
import { catalogKind, catalogTagsFor, publicDiscordInvite } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
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
  const [tag, setTag] = useState("todos");
  const heroImage = store.imageUrl || config.heroImageUrl || "/dragon-store-hero.png";
  const categories = store.categories?.length ? store.categories : [];
  const products = store.products || [];
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);
  const trust = useMemo(() => config.trustBadges.slice(0, 5), [config.trustBadges]);
  const discordUrl = publicDiscordInvite(config.discordInviteUrl || store.discordInviteUrl);
  const filters = useMemo(() => [{ id: "todos", label: "Todos" }, ...catalogTagsFor(categories)], [categories]);
  const productCountText = `${categories.length} ${categories.length === 1 ? "categoria" : "categorias"} · ${products.length} ${products.length === 1 ? "produto" : "produtos"}`;
  const filteredCategories = useMemo(() => {
    const term = query.trim().toLowerCase();
    const byTag = tag === "todos"
      ? categories
      : categories.filter(category => {
          const seed = `${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`;
          return catalogKind(seed) === tag;
        });
    if (!term) return byTag;
    return byTag.filter(category => {
      return [
        category.title,
        category.description,
        ...category.products.map(product => `${product.name} ${product.description} ${product.price}`)
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [categories, query, tag]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CART_STORAGE_KEY);
      if (saved) setCart(JSON.parse(saved));
    } catch {
      setCart([]);
    }
  }, []);

  useEffect(() => {
    trackEvent({ type: "page_view", path: "/" });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  function addProduct(product: StoreProduct) {
    setCart(current => {
      const existing = current.find(item => item.product.id === product.id);
      if (existing) {
        return current.map(item => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...current, { product, quantity: 1 }];
    });
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
          className="absolute inset-0 bg-cover bg-center opacity-30 blur-[2px]"
          style={{ backgroundImage: `url(${heroImage})` }}
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(7,9,15,.96),rgba(7,9,15,.84)_48%,rgba(7,9,15,.98))]" />
        <div className="grid-texture pointer-events-none absolute inset-0 opacity-25" />
        <div className="dragon-container relative grid gap-8 py-10 sm:py-12 lg:grid-cols-[1.05fr_.95fr] lg:items-center">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="max-w-2xl"
          >
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-emerald-300/30 bg-black/35 px-3 py-2 text-xs font-bold uppercase text-emerald-100 backdrop-blur">
              <BadgeCheck className="h-4 w-4" />
              Compra pelo Discord
            </div>
            <h1 className="text-4xl font-black leading-[1.05] text-white sm:text-5xl">
              Produtos digitais com compra rapida pelo Discord
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-200 sm:text-lg">
              Escolha seus produtos, monte seu carrinho e finalize com atendimento direto no nosso servidor.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href={discordUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-emerald-300 px-5 text-sm font-black text-black transition hover:bg-cyan-200"
              >
                Entrar no Discord
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="#categorias"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/[.06] px-5 text-sm font-black text-white transition hover:border-violet-300/40 hover:bg-violet-300/10"
              >
                Ver produtos
              </a>
            </div>
          </motion.div>

          <div className="grid gap-3 sm:grid-cols-2">
            {trust.slice(0, 4).map((label, index) => {
              const Icon = icons[index] || ShieldCheck;
              return (
                <div key={label} className="flex min-h-20 items-center gap-3 rounded-lg border border-white/10 bg-white/[.045] p-4 backdrop-blur">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-300/10 text-emerald-100">
                    <Icon className="h-5 w-5" />
                  </span>
                  <strong className="text-sm text-white">{label}</strong>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="categorias" className="bg-[#07090f] py-10 sm:py-14">
        <div className="dragon-container">
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-bold uppercase text-emerald-200">Catalogo</p>
              <h2 className="mt-2 text-3xl font-black text-white">Categorias da loja</h2>
              <p className="mt-2 text-xs font-semibold uppercase text-slate-500">{productCountText}</p>
            </div>
            <label className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Buscar categoria ou produto"
                className="h-11 w-full rounded-md border border-white/10 bg-white/[.06] pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300/50"
              />
            </label>
          </div>

          {filters.length > 1 ? (
            <div className="mb-6 flex flex-wrap gap-2">
              {filters.map(filter => (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setTag(filter.id)}
                  className={`h-9 rounded-md border px-3 text-sm font-bold transition ${
                    tag === filter.id
                      ? "border-emerald-300 bg-emerald-300 text-black"
                      : "border-white/10 bg-white/[.04] text-slate-200 hover:border-emerald-300/40"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          ) : null}

          {filteredCategories.length ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {filteredCategories.map(category => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  fallbackImage={heroImage}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/15 p-8 text-slate-300">
              Nenhum resultado encontrado. Voce ainda pode entrar no Discord para comprar.
            </div>
          )}
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#090d15] py-12">
        <div className="dragon-container grid gap-4 md:grid-cols-3">
          {[
            ["1", "Escolha a secao", "Abra a categoria que tem o produto desejado."],
            ["2", "Monte seu pedido", "Adicione itens ao carrinho e confira o total."],
            ["3", "Finalize no Discord", "Copie o resumo e fale com a equipe no servidor."]
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
    </main>
  );
}
