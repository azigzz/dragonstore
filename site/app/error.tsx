"use client";

import { publicDiscordInvite } from "@/lib/catalog";

export default function ErrorPage() {
  return (
    <main className="min-h-screen bg-[#07090f] text-white">
      <div className="dragon-container flex min-h-screen items-center justify-center">
        <div className="w-full max-w-lg rounded-lg border border-white/10 bg-white/[.04] p-6 text-center shadow-neon">
          <h1 className="text-2xl font-black">Nao conseguimos atualizar o catalogo agora</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Voce ainda pode entrar no Discord para consultar produtos e finalizar sua compra com a equipe.
          </p>
          <a
            href={publicDiscordInvite()}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex h-11 items-center justify-center rounded-md bg-emerald-300 px-5 text-sm font-black text-black transition hover:bg-cyan-200"
          >
            Entrar no Discord
          </a>
        </div>
      </div>
    </main>
  );
}
