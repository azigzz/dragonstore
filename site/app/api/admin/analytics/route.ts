import { NextResponse } from "next/server";
import { analyticsSummary } from "@/lib/analytics";
import { isAdminAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  return NextResponse.json(await analyticsSummary(), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
