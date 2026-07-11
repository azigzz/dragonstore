"use client";

import { CheckCircle2, Copy, ExternalLink, LoaderCircle, Minus, Plus, ReceiptText, ShoppingCart, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { publicDiscordInvite } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import { cartTotal, formatBRL, hasUnknownPrices, parsePrice } from "@/lib/money";
import type { SiteConfig, StoreData, StoreProduct, WebOrderReceipt } from "@/lib/types";

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

function expandedItems(items: CartItem[]) {
  return items.flatMap(item => Array.from({ length: item.quantity }, () => item.product));
}

function newRequestKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const [receipt, setReceipt] = useState<WebOrderReceipt | null>(null);
  const [requestKey, setRequestKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const products = expandedItems(items);
  const total = cartTotal(products);
  const unknown = hasUnknownPrices(products);
  const discordUrl = publicDiscordInvite(config.ticketChannelUrl || store.discordInviteUrl || config.discordInviteUrl);
  const signature = items.map(item => `${item.product.id}:${item.quantity}`).sort().join("|");

  useEffect(() => {
    setRequestKey(newRequestKey());
    setReceipt(null);
    setMessage("");
    setError("");
  }, [signature]);

  const summary = useMemo(() => {
    const lines = items.map(item => {
      const subtotal = parsePrice(item.product.price) === null
        ? item.product.price
        : formatBRL((parsePrice(item.product.price) || 0) * item.quantity);
      return `- ${item.product.name} | ${item.quantity}x | ${subtotal}`;
    });
    return [
      `PEDIDO SAVIO STORE ${receipt ? `#${receipt.id}` : ""}`.trim(),
      "",
      ...lines,
      "",
      `Total: ${receipt?.total || (unknown ? `${formatBRL(total)} + itens a combinar` : formatBRL(total))}`,
      receipt ? "" : "",
      receipt ? `Codigo para atendimento: ${receipt.id}` : "Gere o ID antes de chamar o atendimento.",
      "Quero finalizar esta compra pelo Discord."
    ].join("\n");
  }, [items, receipt, total, unknown]);

  async function registerOrder() {
    if (!items.length || creating) return null;
    setCreating(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey,
          items: items.map(item => ({ productId: item.product.id, quantity: item.quantity }))
        })
      });
      const payload = await response.json() as WebOrderReceipt & { error?: string };
      if (!response.ok || !payload.id) throw new Error(payload.error || "Nao foi possivel gerar o pedido.");
      setReceipt(payload);
      trackEvent({ type: "order_created", orderId: payload.id, path: "/pedido" });
      setMessage("Pedido registrado. Agora use esse ID no Discord.");
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nao foi possivel gerar o pedido.");
      return null;
    } finally {
      setCreating(false);
    }
  }

  function summaryFor(order: WebOrderReceipt | null) {
    if (!order) return summary;
    const lines = items.map(item => `- ${item.product.name} | ${item.quantity}x`);
    return [
      `PEDIDO SAVIO STORE #${order.id}`,
      "",
      ...lines,
      "",
      `Total confirmado: ${order.total}`,
      `Codigo para atendimento: ${order.id}`,
      "Quero finalizar esta compra pelo Discord."
    ].join("\n");
  }

  async function copyText(text: string, success: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(success);
      setError("");
    } catch {
      setError("Nao consegui copiar automaticamente. Selecione o resumo e copie manualmente.");
    }
  }

  async function finishOnDiscord() {
    const order = receipt || await registerOrder();
    if (!order) return;
    await copyText(summaryFor(order), "Pedido copiado. Cole a mensagem no atendimento do Discord.");
    window.open(discordUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[460px] flex-col border-l border-white/10 bg-[#080c0b] shadow-2xl"
            aria-label="Carrinho"
          >
            <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-white/10 px-4 sm:px-5">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#55f28b] text-black">
                  <ShoppingCart className="h-5 w-5" />
                </span>
                <div>
                  <strong className="text-base text-white">Seu pedido</strong>
                  <p className="text-xs text-zinc-500">{products.length} {products.length === 1 ? "item" : "itens"}</p>
                </div>
              </div>
              <button type="button" onClick={onClose} className="icon-button" aria-label="Fechar carrinho" title="Fechar carrinho">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
              {items.length ? items.map(item => (
                <div key={item.product.id} className="cart-line">
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-sm text-white">{item.product.name}</strong>
                    <p className="mt-1 text-sm font-bold text-[#8fffb1]">{item.product.price}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Subtotal: {parsePrice(item.product.price) === null ? "a combinar" : formatBRL((parsePrice(item.product.price) || 0) * item.quantity)}
                    </p>
                  </div>
                  <button type="button" onClick={() => onRemove(item.product.id)} className="icon-button danger" aria-label={`Remover ${item.product.name}`} title="Remover">
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <div className="col-span-2 mt-3 inline-flex h-9 items-center rounded-md border border-white/10 bg-black/20">
                    <button type="button" onClick={() => onDecrease(item.product.id)} className="h-full px-3 text-zinc-300 hover:text-white" aria-label="Diminuir quantidade">
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="min-w-9 text-center text-sm font-black text-white">{item.quantity}</span>
                    <button type="button" onClick={() => onAdd(item.product)} className="h-full px-3 text-zinc-300 hover:text-white" aria-label="Aumentar quantidade">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )) : (
                <div className="empty-state min-h-52">
                  <ShoppingCart className="h-8 w-8 text-zinc-600" />
                  <strong className="mt-4 text-white">Seu carrinho esta vazio</strong>
                  <p className="mt-2 max-w-xs text-center text-sm leading-6 text-zinc-500">Escolha uma categoria e adicione os produtos que deseja.</p>
                </div>
              )}
            </div>

            <div className="shrink-0 space-y-3 border-t border-white/10 bg-[#0b100e] p-4 sm:p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase text-zinc-500">Total estimado</p>
                  <p className="mt-1 text-2xl font-black text-white">{receipt?.total || (unknown ? `${formatBRL(total)} + a combinar` : formatBRL(total))}</p>
                </div>
                {items.length ? (
                  <button type="button" onClick={onClear} className="text-xs font-bold text-zinc-500 transition hover:text-red-200">Limpar tudo</button>
                ) : null}
              </div>

              {receipt ? (
                <div className="order-receipt">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-bold uppercase text-[#8fffb1]">ID confirmado</p>
                      <p className="mt-1 font-mono text-xl font-black text-white">{receipt.id}</p>
                    </div>
                    <CheckCircle2 className="h-5 w-5 text-[#55f28b]" />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">Informe esse codigo no atendimento para a equipe localizar seu pedido.</p>
                </div>
              ) : null}

              <AnimatePresence mode="wait">
                {message ? <motion.p key="message" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="status-message success">{message}</motion.p> : null}
                {error ? <motion.p key="error" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="status-message error">{error}</motion.p> : null}
              </AnimatePresence>

              {receipt ? (
                <button type="button" onClick={() => copyText(summaryFor(receipt), "Resumo e ID copiados.")} className="secondary-command w-full">
                  <Copy className="h-4 w-4" />
                  Copiar pedido e ID
                </button>
              ) : (
                <button type="button" onClick={registerOrder} disabled={!items.length || creating} className="secondary-command w-full">
                  {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
                  {creating ? "Confirmando precos..." : "Gerar ID do pedido"}
                </button>
              )}

              <button type="button" onClick={finishOnDiscord} disabled={!items.length || creating} className="primary-command w-full">
                {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                {receipt ? "Abrir atendimento no Discord" : "Gerar ID e continuar no Discord"}
              </button>
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
