"use client";

/* eslint-disable @next/next/no-img-element */

import { ArrowUpRight, Layers3 } from "lucide-react";
import Link from "next/link";
import { categoryDescription, categoryImage, categoryPriceLabel } from "@/lib/catalog";
import { trackEvent } from "@/lib/client-analytics";
import type { StoreCategory } from "@/lib/types";

type CategoryCardProps = {
  category: StoreCategory;
  fallbackImage: string;
};

export default function CategoryCard({ category, fallbackImage }: CategoryCardProps) {
  const image = categoryImage(category, fallbackImage);
  const description = categoryDescription(category.description);

  return (
    <Link
      href={`/categoria/${category.id}`}
      onClick={() => trackEvent({
        type: "category_click",
        categoryId: category.id,
        categoryTitle: category.title,
        path: `/categoria/${category.id}`
      })}
      className="category-card group"
    >
      <div className="category-media">
        <img src={image} alt={category.title} className="h-full w-full object-cover" loading="lazy" />
        <div className="category-shade" />
        <span className="category-count"><Layers3 className="h-3.5 w-3.5" /> {category.products.length} opcoes</span>
      </div>
      <div className="flex min-h-[198px] flex-col p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="truncate text-xl font-black text-white">{category.title}</h3>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">{description}</p>
          </div>
          <span className="category-arrow"><ArrowUpRight className="h-4 w-4" /></span>
        </div>
        <div className="mt-auto border-t border-white/8 pt-4">
          <span className="block text-[10px] font-bold uppercase text-zinc-600">Menor preco</span>
          <strong className="mt-1 block text-lg text-[#8fffb1]">{categoryPriceLabel(category)}</strong>
        </div>
      </div>
    </Link>
  );
}
