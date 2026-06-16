import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "dragon_store_admin";

export function adminRouteSecret() {
  return process.env.ADMIN_ROUTE_SECRET || process.env.NEXT_PUBLIC_ADMIN_ROUTE_SECRET || "jpo33i48j";
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || "";
}

function sessionValue() {
  return crypto
    .createHmac("sha256", adminPassword())
    .update(`dragon-store:${adminRouteSecret()}`)
    .digest("base64url");
}

function hashPassword(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

export function safePasswordMatches(input: string) {
  const expected = adminPassword();
  if (!expected) return false;
  const a = hashPassword(input);
  const b = hashPassword(expected);
  return crypto.timingSafeEqual(a, b);
}

export async function isAdminAuthenticated() {
  const cookieStore = await cookies();
  const value = cookieStore.get(COOKIE_NAME)?.value;
  return Boolean(adminPassword() && value && value === sessionValue());
}

export async function setAdminCookie() {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, sessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12
  });
}

export async function clearAdminCookie() {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });
}
