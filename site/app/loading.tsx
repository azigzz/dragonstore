export default function Loading() {
  return (
    <main className="min-h-screen bg-[#07090f] text-white">
      <div className="dragon-container flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-lg border border-white/10 bg-white/[.04] p-6 text-center shadow-neon">
          <div className="mx-auto h-10 w-10 animate-pulse rounded-md bg-emerald-300/30" />
          <h1 className="mt-5 text-2xl font-black">Carregando catalogo...</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Estamos preparando as categorias e produtos disponiveis.
          </p>
        </div>
      </div>
    </main>
  );
}
