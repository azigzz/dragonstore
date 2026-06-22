import { NextResponse } from "next/server";
import { appendAdminAudit } from "@/lib/admin-audit";
import { loginRateLimitSeconds, recordLoginAttempt, safePasswordMatches, setAdminCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const retryAfter = loginRateLimitSeconds(request);
  if (retryAfter > 0) {
    await appendAdminAudit(request, "admin.login_rate_limited", { retryAfter });
    return NextResponse.json(
      { error: `Muitas tentativas. Tente novamente em ${retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  const body = await request.json().catch(() => ({}));
  const password = String(body.password || "");

  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "ADMIN_PASSWORD nao configurado." }, { status: 503 });
  }

  const ok = safePasswordMatches(password);
  recordLoginAttempt(request, ok);
  if (!ok) {
    await appendAdminAudit(request, "admin.login_failed");
    return NextResponse.json({ error: "Senha invalida." }, { status: 401 });
  }

  const csrfToken = await setAdminCookie();
  await appendAdminAudit(request, "admin.login_success");
  return NextResponse.json({ ok: true, csrfToken });
}
