"use client";

/* eslint-disable @next/next/no-img-element */

import { ExternalLink, ShoppingBag } from "lucide-react";
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
    <header className="site-header">
      <div className="store-container flex h-[72px] items-center justify-between gap-4">
        <a href="/" className="group flex min-w-0 items-center gap-3" aria-label="Pagina inicial da Sávio Store">
          <span className="brand-mark">
            <img src="/savio-store-logo.png" alt="" className="h-full w-full object-cover" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-black text-white">{config.storeName}</span>
            <span className="block truncate text-[11px] font-semibold text-zinc-500">Loja digital oficial</span>
          </span>
        </a>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Navegacao principal">
          <a href="/#catalogo" className="nav-link">Catalogo</a>
          <a href="/#como-funciona" className="nav-link">Como funciona</a>
          <a href={discordUrl} target="_blank" rel="noreferrer" className="nav-link">Discord</a>
        </nav>

        <div className="flex items-center gap-2">
          <button type="button" onClick={onCartClick} className="header-cart" aria-label={`Abrir pedido com ${cartCount} itens`}>
            <ShoppingBag className="h-4 w-4" />
            <span className="hidden sm:inline">Pedido</span>
            <span className="cart-count">{cartCount}</span>
          </button>
          <a href={discordUrl} target="_blank" rel="noreferrer" className="header-discord">
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">Entrar</span>
          </a>
        </div>
      </div>
    </header>
  );
}
