"use client";

import { CheckCircle2, LogIn, LogOut, RefreshCw, Save, ShieldCheck, TestTube2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { AdminConfigPayload, StoreProduct } from "@/lib/types";

type AdminPanelProps = {
  loggedIn: boolean;
  initialConfig: AdminConfigPayload | null;
};

const emptyConfig: AdminConfigPayload = {
  storeName: "Dragon Store",
  subtitle: "Loja digital pelo Discord",
  heroTitle: "Produtos digitais com compra rapida pelo Discord",
  heroText: "Escolha seus produtos, monte seu carrinho e finalize pelo Discord.",
  discordInviteUrl: "",
  ticketChannelUrl: "",
  botApiUrl: "",
  botApiToken: "",
  botApiTokenConfigured: false,
  primaryColor: "#28f6a1",
  heroImageUrl: "/dragon-store-hero.png",
  trustBadges: ["Carrinho rapido", "Atendimento por ADM", "Pagamento via Pix", "Produtos digitais", "Suporte no Discord"],
  fallbackProducts: []
};

export default function AdminPanel({ loggedIn, initialConfig }: AdminPanelProps) {
  const [isLoggedIn, setIsLoggedIn] = useState(loggedIn);
  const [password, setPassword] = useState("");
  const [config, setConfig] = useState<AdminConfigPayload>(initialConfig || emptyConfig);
  const [fallbackText, setFallbackText] = useState(JSON.stringify(initialConfig?.fallbackProducts || [], null, 2));
  const [trustText, setTrustText] = useState((initialConfig?.trustBadges || emptyConfig.trustBadges).join("\n"));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const tokenLabel = useMemo(() => config.botApiTokenConfigured ? "Token ja configurado" : "Token ainda nao salvo", [config.botApiTokenConfigured]);
  const productLabel = (count: number) => `${count} ${count === 1 ? "produto" : "produtos"}`;

  async function loadConfig() {
    const response = await fetch("/api/admin/config", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as AdminConfigPayload;
    setConfig(data);
    setFallbackText(JSON.stringify(data.fallbackProducts || [], null, 2));
    setTrustText((data.trustBadges || []).join("\n"));
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    setBusy(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setStatus(data.error || "Login recusado.");
      return;
    }
    setIsLoggedIn(true);
    setPassword("");
    setStatus("Login aprovado.");
    await loadConfig();
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setIsLoggedIn(false);
  }

  function update<K extends keyof AdminConfigPayload>(key: K, value: AdminConfigPayload[K]) {
    setConfig(current => ({ ...current, [key]: value }));
  }

  function parseFallbackProducts(): StoreProduct[] {
    const parsed = JSON.parse(fallbackText || "[]");
    if (!Array.isArray(parsed)) throw new Error("Produtos fallback precisam ser uma lista JSON.");
    return parsed;
  }

  async function saveConfig() {
    setBusy(true);
    setStatus("");
    try {
      const payload = {
        ...config,
        trustBadges: trustText.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
        fallbackProducts: parseFallbackProducts()
      };
      const response = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Nao foi possivel salvar.");
      setConfig(data);
      setFallbackText(JSON.stringify(data.fallbackProducts || [], null, 2));
      setTrustText((data.trustBadges || []).join("\n"));
      setStatus("Config salva.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Erro ao salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function testBot() {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/test-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botApiUrl: config.botApiUrl, botApiToken: config.botApiToken })
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    setStatus(response.ok ? `Conexao OK: ${productLabel(data.products || 0)}.` : data.error || "Falha ao testar bot.");
  }

  async function syncProducts() {
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/sync", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(data.error || "Falha ao sincronizar.");
      return;
    }
    setStatus(`Sincronizado: ${productLabel(data.products || 0)} salvos no fallback runtime.`);
    await loadConfig();
  }

  if (!isLoggedIn) {
    return (
      <main className="min-h-dvh bg-[#07090f] px-4 py-10 text-white">
        <section className="mx-auto flex min-h-[calc(100dvh-80px)] w-full max-w-md items-center">
          <form onSubmit={login} className="w-full rounded-lg border border-white/10 bg-[#10141f] p-6 shadow-violet">
            <div className="mb-6 flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-emerald-300/10 text-emerald-100">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <div>
                <h1 className="text-xl font-black">Painel Dragon Store</h1>
                <p className="text-sm text-slate-400">Acesso protegido</p>
              </div>
            </div>

            <label className="block text-sm font-bold text-slate-200" htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="mt-2 h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 text-white outline-none"
              autoComplete="current-password"
            />
            {status ? <p className="mt-3 text-sm text-amber-200">{status}</p> : null}
            <button
              type="submit"
              disabled={busy}
              className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-300 px-4 text-sm font-black text-black transition hover:bg-cyan-200 disabled:opacity-50"
            >
              <LogIn className="h-4 w-4" />
              Entrar
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#07090f] px-4 py-8 text-white">
      <section className="mx-auto w-full max-w-6xl">
        <header className="mb-6 flex flex-col justify-between gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-bold uppercase text-emerald-200">Dragon Store</p>
            <h1 className="text-3xl font-black">Painel do site</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={testBot} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold transition hover:bg-white/10 disabled:opacity-50">
              <TestTube2 className="h-4 w-4" />
              Testar bot
            </button>
            <button onClick={syncProducts} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-white/[.06] px-3 text-sm font-bold transition hover:bg-white/10 disabled:opacity-50">
              <RefreshCw className="h-4 w-4" />
              Sincronizar
            </button>
            <button onClick={saveConfig} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-emerald-300 px-3 text-sm font-black text-black transition hover:bg-cyan-200 disabled:opacity-50">
              <Save className="h-4 w-4" />
              Salvar
            </button>
            <button onClick={logout} className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/30 bg-red-400/10 px-3 text-sm font-bold text-red-100 transition hover:bg-red-400/20">
              <LogOut className="h-4 w-4" />
              Sair
            </button>
          </div>
        </header>

        {status ? (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-3 text-sm text-emerald-100">
            <CheckCircle2 className="h-4 w-4" />
            {status}
          </div>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
          <section className="grid gap-4 rounded-lg border border-white/10 bg-[#10141f] p-5">
            <Field label="Nome da loja" value={config.storeName} onChange={value => update("storeName", value)} />
            <Field label="Subtitulo" value={config.subtitle} onChange={value => update("subtitle", value)} />
            <Field label="Titulo da home" value={config.heroTitle} onChange={value => update("heroTitle", value)} />
            <TextField label="Texto principal" value={config.heroText} onChange={value => update("heroText", value)} rows={3} />
            <Field label="Convite do Discord" value={config.discordInviteUrl} onChange={value => update("discordInviteUrl", value)} />
            <Field label="Link/canal de ticket" value={config.ticketChannelUrl} onChange={value => update("ticketChannelUrl", value)} />
            <Field label="Cor principal" value={config.primaryColor} onChange={value => update("primaryColor", value)} />
            <Field label="Imagem/logo/banner" value={config.heroImageUrl} onChange={value => update("heroImageUrl", value)} />
            <TextField label="Textos de confianca" value={trustText} onChange={setTrustText} rows={5} />
          </section>

          <aside className="grid gap-4">
            <section className="rounded-lg border border-white/10 bg-[#10141f] p-5">
              <h2 className="text-lg font-black">Bot</h2>
              <div className="mt-4 grid gap-4">
                <Field label="URL da API do bot" value={config.botApiUrl} onChange={value => update("botApiUrl", value)} />
                <Field label={`Token da API (${tokenLabel})`} value={config.botApiToken || ""} onChange={value => update("botApiToken", value)} type="password" />
              </div>
            </section>

            <section className="rounded-lg border border-white/10 bg-[#10141f] p-5">
              <h2 className="text-lg font-black">Produtos fallback</h2>
              <textarea
                value={fallbackText}
                onChange={event => setFallbackText(event.target.value)}
                rows={17}
                className="mt-4 w-full rounded-md border border-white/10 bg-black/30 p-3 font-mono text-xs leading-5 text-slate-100 outline-none"
                spellCheck={false}
              />
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <input
        type={type}
        value={value || ""}
        onChange={event => onChange(event.target.value)}
        className="mt-2 h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 text-white outline-none"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  rows
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <textarea
        value={value || ""}
        onChange={event => onChange(event.target.value)}
        rows={rows}
        className="mt-2 w-full rounded-md border border-white/10 bg-black/30 p-3 text-white outline-none"
      />
    </label>
  );
}
