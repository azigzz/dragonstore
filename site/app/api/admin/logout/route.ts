import { NextResponse } from "next/server";
import { appendAdminAudit } from "@/lib/admin-audit";
import { clearAdminCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await clearAdminCookie();
  await appendAdminAudit(request, "admin.logout");
  return NextResponse.json({ ok: true });
}
