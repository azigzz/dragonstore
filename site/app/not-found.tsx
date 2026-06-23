import Link from "next/link";
import { publicDiscordInvite } from "@/lib/catalog";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[#07090f] text-white">
      <div className="dragon-container flex min-h-screen items-center justify-center">
        <div className="w-full max-w-lg rounded-lg border border-white/10 bg-white/[.04] p-6 text-center shadow-neon">
          <h1 className="text-2xl font-black">Categoria nao encontrada</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Esse link pode ter mudado. Veja as categorias atuais ou fale com a equipe no Discord.
          </p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/#categorias"
              className="inline-flex h-11 items-center justify-center rounded-md bg-white px-5 text-sm font-black text-black transition hover:bg-emerald-200"
            >
              Ver produtos
            </Link>
            <a
              href={publicDiscordInvite()}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/10 bg-white/[.06] px-5 text-sm font-black text-white transition hover:border-emerald-300/40"
            >
              Entrar no Discord
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
