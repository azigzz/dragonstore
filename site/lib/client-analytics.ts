const VISITOR_KEY = "savio-store-visitor-id";

function visitorId() {
  if (typeof window === "undefined") return "server";
  try {
    const saved = window.localStorage.getItem(VISITOR_KEY);
    if (saved) return saved;
    const next = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(VISITOR_KEY, next);
    return next;
  } catch {
    return `session_${Date.now().toString(36)}`;
  }
}

export function trackEvent(payload: {
  type: "page_view" | "category_click" | "product_click" | "order_created";
  path?: string;
  productId?: string;
  productName?: string;
  categoryId?: string;
  categoryTitle?: string;
  orderId?: string;
}) {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify({
      ...payload,
      visitorId: visitorId(),
      path: payload.path || window.location.pathname
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/analytics/event", blob);
      return;
    }
    fetch("/api/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    }).catch(() => null);
  } catch {
    // Analytics nunca pode interromper a compra.
  }
}
