import { NextResponse } from "next/server";
import { recordAnalyticsEvent } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "JSON invalido." }, { status: 400 });

  try {
    await recordAnalyticsEvent({
      type: String(body.type || "") as "page_view" | "category_click" | "product_click" | "order_created",
      visitorId: String(body.visitorId || ""),
      path: body.path ? String(body.path) : undefined,
      productId: body.productId ? String(body.productId) : undefined,
      productName: body.productName ? String(body.productName) : undefined,
      categoryId: body.categoryId ? String(body.categoryId) : undefined,
      categoryTitle: body.categoryTitle ? String(body.categoryTitle) : undefined,
      orderId: body.orderId ? String(body.orderId) : undefined
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evento invalido.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
