"use client";

/* eslint-disable @next/next/no-img-element */

import { ExternalLink, Plus, PackageCheck, Tag } from "lucide-react";
import { motion } from "framer-motion";
import { catalogKindLabel, productDescription, productImage, stockLabel } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { StoreProduct } from "@/lib/types";

type ProductCardProps = {
  product: StoreProduct;
  fallbackImage: string;
  categoryId?: string;
  categoryTitle?: string;
  discordUrl: string;
  onAdd: (product: StoreProduct) => void;
};

export default function ProductCard({ product, fallbackImage, categoryId, categoryTitle, discordUrl, onAdd }: ProductCardProps) {
  const image = productImage(product, fallbackImage, categoryTitle);
  const description = productDescription(product.description);
  const stock = stockLabel(product.stock);
  const kindLabel = catalogKindLabel(`${categoryTitle || ""} ${product.name} ${product.description}`);

  function handleAdd() {
    trackEvent({
      type: "product_click",
      productId: product.id,
      productName: product.name,
      categoryId,
      categoryTitle
    });
    onAdd(product);
  }

  return (
    <motion.article
      layout
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.995 }}
      transition={{ duration: 0.18 }}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-[#10141f] shadow-neon transition-colors hover:border-emerald-300/35 hover:bg-[#131a27]"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-950">
        <img
          src={image}
          alt={product.name}
          className="h-full w-full object-cover opacity-90 transition duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#10141f] via-transparent to-transparent" />
        {stock ? (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md border border-emerald-300/30 bg-black/55 px-2 py-1 text-xs font-semibold text-emerald-100 backdrop-blur">
            <PackageCheck className="h-3.5 w-3.5" />
            {stock}
          </span>
        ) : null}
        <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/50 px-2 py-1 text-xs font-bold uppercase text-slate-100 backdrop-blur">
          <Tag className="h-3.5 w-3.5 text-cyan-100" />
          {kindLabel}
        </span>
      </div>

      <div className="flex flex-1 flex-col space-y-4 p-4">
        <div className="space-y-2">
          <h3 className="text-base font-black leading-tight text-white">{product.name}</h3>
          <p className="text-3xl font-black tracking-normal text-emerald-100">{product.price}</p>
          <p className="line-clamp-3 text-sm leading-6 text-slate-300">{description}</p>
        </div>

        <div className="mt-auto grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-black text-black transition hover:bg-cyan-200 hover:shadow-[0_0_30px_rgba(40,246,161,.25)]"
          >
            <Plus className="h-4 w-4" />
            Adicionar
            <span className="hidden xl:inline">ao carrinho</span>
          </button>
          <a
            href={discordUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackEvent({ type: "product_click", productId: product.id, productName: product.name, categoryId, categoryTitle })}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-black text-white transition hover:border-violet-300/45 hover:bg-violet-300/10"
          >
            <ExternalLink className="h-4 w-4" />
            Comprar
            <span className="hidden xl:inline">pelo Discord</span>
          </a>
        </div>
      </div>
    </motion.article>
  );
}
