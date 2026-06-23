"use client";

/* eslint-disable @next/next/no-img-element */

import { ExternalLink, ShoppingCart } from "lucide-react";
import { publicDiscordInvite } from "@/lib/catalog";
import type { SiteConfig } from "@/lib/types";

type HeaderProps = {
  config: SiteConfig;
  cartCount: number;
  onCartClick: () => void;
};

export default function Header({ config, cartCount, onCartClick }: HeaderProps) {
  const discordUrl = publicDiscordInvite(config.discordInviteUrl);

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-[#07090f]/78 shadow-[0_14px_60px_rgba(0,0,0,.22)] backdrop-blur-xl">
      <div className="dragon-container flex h-16 items-center justify-between gap-3">
        <a href="/" className="group flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-emerald-300/30 bg-[#061b2d] transition group-hover:border-emerald-200/70">
            <img
              src="/dragon-store-logo.png"
              alt="Dragon Store"
              className="h-full w-full object-cover"
            />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-black uppercase text-white transition group-hover:text-emerald-100">{config.storeName}</span>
            <span className="block truncate text-xs text-slate-400">{config.subtitle}</span>
          </span>
        </a>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCartClick}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-semibold text-white transition hover:border-emerald-300/40 hover:bg-emerald-300/10"
            aria-label="Abrir carrinho"
          >
            <ShoppingCart className="h-4 w-4" />
            <span className="hidden sm:inline">Carrinho</span>
            <span className="rounded bg-emerald-300 px-1.5 py-0.5 text-xs font-black text-black">{cartCount}</span>
          </button>

          <a
            href={discordUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-black text-black transition hover:bg-cyan-200 hover:shadow-[0_0_30px_rgba(40,246,161,.22)]"
          >
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">Entrar no Discord</span>
            <span className="sm:hidden">Discord</span>
          </a>
        </div>
      </div>
    </header>
  );
}
