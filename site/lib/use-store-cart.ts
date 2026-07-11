"use client";

import { useEffect, useState } from "react";
import type { CartItem } from "@/components/CartDrawer";
import type { StoreProduct } from "@/lib/types";

const CART_STORAGE_KEY = "savio-store-cart-v1";

export function useStoreCart() {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CART_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as CartItem[];
        setCart(Array.isArray(parsed) ? parsed.filter(item => item?.product?.id && item.quantity > 0).slice(0, 50) : []);
      }
    } catch {
      setCart([]);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart, hydrated]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function addProduct(product: StoreProduct) {
    setCart(current => {
      const existing = current.find(item => item.product.id === product.id);
      if (existing) {
        return current.map(item => item.product.id === product.id
          ? { ...item, quantity: Math.min(100, item.quantity + 1) }
          : item);
      }
      return [...current, { product, quantity: 1 }].slice(0, 50);
    });
    setNotice(`${product.name} adicionado ao pedido.`);
  }

  function decreaseProduct(productId: string) {
    setCart(current => current
      .map(item => item.product.id === productId ? { ...item, quantity: item.quantity - 1 } : item)
      .filter(item => item.quantity > 0));
  }

  function removeProduct(productId: string) {
    setCart(current => current.filter(item => item.product.id !== productId));
  }

  return {
    cart,
    notice,
    cartCount: cart.reduce((total, item) => total + item.quantity, 0),
    addProduct,
    decreaseProduct,
    removeProduct,
    clearCart: () => setCart([])
  };
}
