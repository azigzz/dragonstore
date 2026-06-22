import { NextResponse } from "next/server";
import { appendAdminAudit } from "@/lib/admin-audit";
import { isAdminAuthenticated, requireAdminCsrf } from "@/lib/auth";
import { syncFallbackFromBot } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }
  if (!await requireAdminCsrf(request)) {
    return NextResponse.json({ error: "CSRF invalido. Recarregue o painel e tente de novo." }, { status: 403 });
  }

  try {
    const store = await syncFallbackFromBot();
    await appendAdminAudit(request, "admin.products_synced", {
      products: store.products.length,
      categories: store.categories?.length || 0,
      source: store.source
    });
    return NextResponse.json({ ok: true, products: store.products.length, categories: store.categories?.length || 0, source: store.source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel sincronizar.";
    await appendAdminAudit(request, "admin.products_sync_failed", { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
