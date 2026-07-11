"use client";

/* eslint-disable @next/next/no-img-element */

import { PackageCheck, Plus, Tag } from "lucide-react";
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

export default function ProductCard({ product, fallbackImage, categoryId, categoryTitle, onAdd }: ProductCardProps) {
  const image = productImage(product, fallbackImage, categoryTitle);
  const description = productDescription(product.description);
  const stock = stockLabel(product.stock);
  const kindLabel = catalogKindLabel(`${categoryTitle || ""} ${product.name} ${product.description}`);

  function handleAdd() {
    onAdd(product);
    trackEvent({ type: "product_click", productId: product.id, productName: product.name, categoryId, categoryTitle });
  }

  return (
    <motion.article layout whileHover={{ y: -3 }} transition={{ duration: 0.2 }} className="product-card">
      <div className="product-media">
        <img src={image} alt={product.name} className="h-full w-full object-cover" loading="lazy" />
        <div className="product-shade" />
        {stock ? <span className="stock-chip"><PackageCheck className="h-3.5 w-3.5" /> {stock}</span> : null}
        <span className="kind-chip"><Tag className="h-3.5 w-3.5" /> {kindLabel}</span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-black leading-tight text-white">{product.name}</h3>
        <p className="mt-2 text-2xl font-black text-[#8fffb1]">{product.price}</p>
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-zinc-500">{description}</p>
        <button type="button" onClick={handleAdd} className="primary-command mt-5 w-full">
          <Plus className="h-4 w-4" /> Adicionar ao pedido
        </button>
      </div>
    </motion.article>
  );
}
