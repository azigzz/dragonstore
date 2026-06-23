"use client";

import { Copy, ExternalLink, Minus, Plus, ShoppingCart, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { publicDiscordInvite } from "@/lib/catalog";
import { cartTotal, formatBRL, hasUnknownPrices, parsePrice } from "@/lib/money";
import type { SiteConfig, StoreData, StoreProduct } from "@/lib/types";

export type CartItem = {
  product: StoreProduct;
  quantity: number;
};

type CartDrawerProps = {
  open: boolean;
  items: CartItem[];
  store: StoreData;
  config: SiteConfig;
  onClose: () => void;
  onAdd: (product: StoreProduct) => void;
  onDecrease: (productId: string) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
};

function orderCode() {
  return `DS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function expandedItems(items: CartItem[]) {
  return items.flatMap(item => Array.from({ length: item.quantity }, () => item.product));
}

export default function CartDrawer({
  open,
  items,
  store,
  config,
  onClose,
  onAdd,
  onDecrease,
  onRemove,
  onClear
}: CartDrawerProps) {
  const [code, setCode] = useState("DS-000000");
  const [message, setMessage] = useState("");
  const products = expandedItems(items);
  const total = cartTotal(products);
  const unknown = hasUnknownPrices(products);
  const discordUrl = publicDiscordInvite(config.ticketChannelUrl || store.discordInviteUrl || config.discordInviteUrl);

  useEffect(() => {
    setCode(orderCode());
  }, []);

  const summary = useMemo(() => {
    const lines = items.map(item => `${item.product.name} ${item.quantity}x - ${item.product.price}`);
    return [
      `PEDIDO DRAGON STORE #${code}`,
      "",
      ...lines,
      "",
      `Total: ${unknown ? `${formatBRL(total)} + itens a combinar` : formatBRL(total)}`,
      "",
      "Quero finalizar essa compra pelo Discord."
    ].join("\n");
  }, [code, items, total, unknown]);

  async function copyOrder() {
    if (!items.length) return;
    try {
      await navigator.clipboard.writeText(summary);
      setMessage("Resumo copiado. Envie no Discord para finalizar com a equipe.");
    } catch {
      setMessage("Nao consegui copiar automaticamente. Selecione o resumo do pedido e copie manualmente.");
    }
  }

  async function finishOnDiscord() {
    await copyOrder();
    if (discordUrl) window.open(discordUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <>
      <div
        className={`fixed inset-0 z-50 bg-black/60 transition ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-dvh w-full max-w-md flex-col border-l border-white/10 bg-[#0b0f18] shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
        aria-label="Carrinho"
      >
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-emerald-200" />
            <div>
              <strong>Carrinho</strong>
              <p className="text-xs text-slate-500">Pedido #{code}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label="Fechar carrinho">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4">
          {items.length ? items.map(item => (
            <div key={item.product.id} className="rounded-lg border border-white/10 bg-white/[.04] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong className="text-sm text-white">{item.product.name}</strong>
                  <p className="mt-1 text-sm text-slate-400">{item.product.price}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Subtotal: {parsePrice(item.product.price) === null ? "a combinar" : formatBRL((parsePrice(item.product.price) || 0) * item.quantity)}
                  </p>
                </div>
                <button type="button" onClick={() => onRemove(item.product.id)} className="rounded-md p-2 text-slate-400 transition hover:bg-red-400/10 hover:text-red-200" aria-label="Remover item">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="inline-flex items-center rounded-md border border-white/10">
                  <button type="button" onClick={() => onDecrease(item.product.id)} className="p-2 text-slate-300 transition hover:bg-white/10" aria-label="Diminuir quantidade">
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="min-w-10 text-center text-sm font-black">{item.quantity}</span>
                  <button type="button" onClick={() => onAdd(item.product)} className="p-2 text-slate-300 transition hover:bg-white/10" aria-label="Aumentar quantidade">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )) : (
            <div className="rounded-lg border border-dashed border-white/15 p-5 text-sm text-slate-400">
              Seu carrinho esta vazio. Escolha um produto para montar o pedido.
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-white/10 p-4">
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="text-xs uppercase text-slate-400">Total estimado</p>
            <p className="mt-1 text-xl font-black text-white">{unknown ? `${formatBRL(total)} + a combinar` : formatBRL(total)}</p>
          </div>

          {items.length ? (
            <label className="block">
              <span className="text-xs uppercase text-slate-500">Resumo do pedido</span>
              <textarea
                value={summary}
                readOnly
                rows={6}
                className="mt-2 w-full resize-none rounded-md border border-white/10 bg-black/25 p-3 font-mono text-xs leading-5 text-slate-200 outline-none"
              />
            </label>
          ) : null}

          {message ? <p className="rounded-md border border-emerald-300/30 bg-emerald-300/10 p-3 text-sm text-emerald-100">{message}</p> : null}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={copyOrder}
              disabled={!items.length}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[.06] text-sm font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Copy className="h-4 w-4" />
              Copiar pedido
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={!items.length}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[.06] text-sm font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Trash2 className="h-4 w-4" />
              Limpar
            </button>
          </div>

          <button
            type="button"
            onClick={finishOnDiscord}
            disabled={!items.length}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-4 text-sm font-black text-black transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ExternalLink className="h-4 w-4" />
            Finalizar pelo Discord
          </button>
        </div>
      </aside>
    </>
  );
}
