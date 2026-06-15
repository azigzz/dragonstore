"use client";

/* eslint-disable @next/next/no-img-element */

import { ArrowRight, Boxes, PackageCheck } from "lucide-react";
import Link from "next/link";
import { formatBRL } from "@/lib/money";
import type { StoreCategory } from "@/lib/types";

type CategoryCardProps = {
  category: StoreCategory;
  fallbackImage: string;
};

function cleanPreview(text: string) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function priceLabel(category: StoreCategory) {
  return typeof category.minPrice === "number"
    ? `A partir de ${formatBRL(category.minPrice)}`
    : "Valores no detalhe";
}

export default function CategoryCard({ category, fallbackImage }: CategoryCardProps) {
  const image = category.imageUrl || fallbackImage || "/dragon-store-hero.png";

  return (
    <Link
      href={`/categoria/${category.id}`}
      className="group overflow-hidden rounded-lg border border-white/10 bg-[#10141f] shadow-neon transition hover:-translate-y-1 hover:border-emerald-300/35"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-950">
        <img
          src={image}
          alt={category.title}
          className="h-full w-full object-cover opacity-90 transition duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#10141f] via-transparent to-transparent" />
        <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md border border-emerald-300/30 bg-black/55 px-2 py-1 text-xs font-semibold text-emerald-100 backdrop-blur">
          <Boxes className="h-3.5 w-3.5" />
          {category.products.length} {category.products.length === 1 ? "produto" : "produtos"}
        </span>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-black leading-tight text-white">{category.title}</h3>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-300">{cleanPreview(category.description)}</p>
          </div>
          <PackageCheck className="mt-1 h-5 w-5 shrink-0 text-emerald-200" />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
          <span className="rounded-md border border-violet-300/30 bg-violet-300/10 px-2 py-1 text-sm font-black text-violet-100">
            {priceLabel(category)}
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-black text-emerald-100">
            Ver detalhes
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}
