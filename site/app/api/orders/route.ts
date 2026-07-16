import { NextResponse } from "next/server";
import { readSiteConfig } from "@/lib/config";
import { getStoreData } from "@/lib/store";
import type { WebOrderReceipt } from "@/lib/types";

export const dynamic = "force-dynamic";

const attempts = new Map<string, { count: number; resetAt: number }>();

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function rateLimited(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > 12;
}

function orderApiUrl(storeApiUrl: string) {
  const url = new URL(storeApiUrl);
  url.pathname = "/api/public-orders";
  url.search = "";
  return url.toString();
}

export async function POST(request: Request) {
  if (rateLimited(requestIp(request))) {
    return NextResponse.json({ error: "Muitas tentativas. Aguarde um minuto e tente novamente." }, { status: 429 });
  }

  try {
    const body = await request.json() as { requestKey?: string; items?: Array<{ productId?: string; quantity?: number }> };
    const items = Array.isArray(body.items) ? body.items.slice(0, 25).map(item => ({
      productId: String(item.productId || "").slice(0, 160),
      quantity: Math.min(100, Math.max(1, Number(item.quantity) || 1))
    })) : [];
    if (!items.length || items.some(item => !item.productId)) {
      return NextResponse.json({ error: "Seu carrinho esta vazio ou invalido." }, { status: 400 });
    }

    const config = await readSiteConfig();
    if (!config.botApiUrl || !config.botApiToken) {
      return NextResponse.json({ error: "A criacao de pedidos esta temporariamente indisponivel." }, { status: 503 });
    }
    if (config.safeCatalogEnabled) {
      const store = await getStoreData();
      const visibleProductIds = new Set((store.categories || []).flatMap(category => category.products.map(product => product.id)));
      if (items.some(item => !visibleProductIds.has(item.productId))) {
        return NextResponse.json({ error: "Um produto do carrinho nao esta disponivel na vitrine publica." }, { status: 400 });
      }
    }
    const response = await fetch(orderApiUrl(config.botApiUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.botApiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requestKey: String(body.requestKey || "").slice(0, 80), items }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => ({})) as Partial<WebOrderReceipt> & { error?: string };
    if (!response.ok || !payload.id) {
      return NextResponse.json({ error: payload.error || "Nao foi possivel registrar o pedido agora." }, { status: response.status || 502 });
    }
    return NextResponse.json(payload, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "O bot demorou para responder. Tente novamente em alguns segundos."
      : "Nao foi possivel registrar o pedido agora.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
