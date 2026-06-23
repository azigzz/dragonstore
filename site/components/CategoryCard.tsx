"use client";

/* eslint-disable @next/next/no-img-element */

import { ArrowRight, Boxes, PackageCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { catalogKindLabel, categoryDescription, categoryImage, categoryPriceLabel } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { StoreCategory } from "@/lib/types";

type CategoryCardProps = {
  category: StoreCategory;
  fallbackImage: string;
};

export default function CategoryCard({ category, fallbackImage }: CategoryCardProps) {
  const image = categoryImage(category, fallbackImage);
  const description = categoryDescription(category.description);
  const kindLabel = catalogKindLabel(`${category.title} ${category.description} ${category.products.map(product => `${product.name} ${product.description}`).join(" ")}`);

  return (
    <Link
      href={`/categoria/${category.id}`}
      onClick={() => trackEvent({
        type: "category_click",
        categoryId: category.id,
        categoryTitle: category.title,
        path: `/categoria/${category.id}`
      })}
      className="group block h-full overflow-hidden rounded-lg border border-white/10 bg-[#10141f] shadow-neon transition duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:bg-[#131a27] hover:shadow-violet"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-950">
        <img
          src={image}
          alt={category.title}
          className="h-full w-full object-cover opacity-95 transition duration-300 group-hover:scale-[1.03]"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#10141f] via-[#10141f]/10 to-transparent" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/70 to-transparent opacity-0 transition group-hover:opacity-100" />
        <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md border border-emerald-300/30 bg-black/55 px-2 py-1 text-xs font-semibold text-emerald-100 backdrop-blur">
          <Boxes className="h-3.5 w-3.5" />
          {category.products.length} {category.products.length === 1 ? "produto" : "produtos"}
        </span>
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-xs font-bold uppercase text-white backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-cyan-100" />
          {kindLabel}
        </span>
      </div>

      <div className="flex min-h-[230px] flex-col space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-black leading-tight text-white">{category.title}</h3>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-300">{description}</p>
          </div>
          <PackageCheck className="mt-1 h-5 w-5 shrink-0 text-emerald-200" />
        </div>

        <div className="mt-auto flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <span>
            <span className="block text-[11px] font-bold uppercase text-slate-500">Menor preco</span>
            <span className="text-base font-black text-emerald-100">{categoryPriceLabel(category)}</span>
          </span>
          <span className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-white px-3 text-sm font-black text-black transition group-hover:bg-emerald-200 group-hover:shadow-[0_0_28px_rgba(40,246,161,.24)]">
            Ver produtos
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}
