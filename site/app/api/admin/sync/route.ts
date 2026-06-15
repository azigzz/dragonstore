import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import { syncFallbackFromBot } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  try {
    const store = await syncFallbackFromBot();
    return NextResponse.json({ ok: true, products: store.products.length, categories: store.categories?.length || 0, source: store.source });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel sincronizar.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
