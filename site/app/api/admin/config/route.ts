import { NextResponse } from "next/server";
import { appendAdminAudit } from "@/lib/admin-audit";
import { getOrCreateCsrfToken, isAdminAuthenticated, requireAdminCsrf } from "@/lib/auth";
import { readSiteConfig, saveSiteConfig, toAdminPayload } from "@/lib/config";
import type { SiteConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

function changedFields(before: Partial<SiteConfig>, after: Partial<SiteConfig>) {
  const fields = ["storeName", "subtitle", "heroTitle", "heroText", "discordInviteUrl", "ticketChannelUrl", "botApiUrl", "primaryColor", "heroImageUrl", "manualCatalogEnabled", "safeCatalogEnabled", "safeProductKeys", "trustBadges", "fallbackCategories", "fallbackProducts"];
  return fields.filter(field => JSON.stringify(before[field as keyof SiteConfig] ?? null) !== JSON.stringify(after[field as keyof SiteConfig] ?? null));
}

export async function GET() {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  return NextResponse.json({
    ...toAdminPayload(await readSiteConfig()),
    csrfToken: await getOrCreateCsrfToken()
  });
}

export async function POST(request: Request) {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }
  if (!await requireAdminCsrf(request)) {
    return NextResponse.json({ error: "CSRF invalido. Recarregue o painel e tente de novo." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Partial<SiteConfig> | null;
  if (!body) return NextResponse.json({ error: "JSON invalido." }, { status: 400 });

  try {
    const previous = await readSiteConfig();
    const saved = await saveSiteConfig(body);
    await appendAdminAudit(request, "admin.config_saved", {
      changedFields: changedFields(previous, saved),
      categories: saved.fallbackCategories?.length || 0,
      products: saved.fallbackProducts?.length || 0,
      safeCatalogEnabled: Boolean(saved.safeCatalogEnabled),
      safeVisibleProducts: saved.safeProductKeys?.length || 0,
      botApiTokenChanged: Boolean(body.botApiToken)
    });
    return NextResponse.json(toAdminPayload(saved));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel salvar.";
    await appendAdminAudit(request, "admin.config_save_failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
