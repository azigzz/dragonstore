import { NextResponse } from "next/server";
import { appendAdminAudit } from "@/lib/admin-audit";
import { isAdminAuthenticated, requireAdminCsrf } from "@/lib/auth";
import { readSiteConfig } from "@/lib/config";
import { fetchBotStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }
  if (!await requireAdminCsrf(request)) {
    return NextResponse.json({ error: "CSRF invalido. Recarregue o painel e tente de novo." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const current = await readSiteConfig();
  const config = {
    ...current,
    botApiUrl: String(body.botApiUrl || current.botApiUrl || ""),
    botApiToken: String(body.botApiToken || current.botApiToken || "")
  };

  try {
    const store = await fetchBotStore(config);
    await appendAdminAudit(request, "admin.bot_tested", {
      ok: true,
      products: store.products?.length || 0,
      title: store.title || store.storeName,
      botApiUrl: config.botApiUrl
    });
    return NextResponse.json({ ok: true, products: store.products?.length || 0, title: store.title || store.storeName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao testar bot.";
    await appendAdminAudit(request, "admin.bot_test_failed", { error: message, botApiUrl: config.botApiUrl });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
