import crypto from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "dragon_store_admin";
const CSRF_COOKIE_NAME = "dragon_store_admin_csrf";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export function adminRouteSecret() {
  return process.env.ADMIN_ROUTE_SECRET || process.env.NEXT_PUBLIC_ADMIN_ROUTE_SECRET || "jpo33i48j";
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || "";
}
function cookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge
  };
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
function safeEquals(a: string, b: string) {
  const left = hashPassword(a);
  const right = hashPassword(b);
  return crypto.timingSafeEqual(left, right);
}
function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
}
export function loginRateLimitSeconds(request: Request) {
  const key = requestIp(request);
  const current = loginAttempts.get(key);
  if (!current || Date.now() > current.resetAt || current.count < LOGIN_MAX_ATTEMPTS) return 0;
  return Math.ceil((current.resetAt - Date.now()) / 1000);
}
export function recordLoginAttempt(request: Request, ok: boolean) {
  const key = requestIp(request);
  if (ok) {
    loginAttempts.delete(key);
    console.info(`Admin login aprovado para ${key}`);
    return;
  }

  const current = loginAttempts.get(key);
  const resetAt = !current || Date.now() > current.resetAt ? Date.now() + LOGIN_WINDOW_MS : current.resetAt;
  const count = (!current || Date.now() > current.resetAt ? 0 : current.count) + 1;
  loginAttempts.set(key, { count, resetAt });
  console.warn(`Admin login falhou para ${key} (${count}/${LOGIN_MAX_ATTEMPTS})`);
}
function newCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function safePasswordMatches(input: string) {
  const expected = adminPassword();
  if (!expected) return false;
  return safeEquals(input, expected);
}

export async function isAdminAuthenticated() {
  const cookieStore = await cookies();
  const value = cookieStore.get(COOKIE_NAME)?.value;
  return Boolean(adminPassword() && value && value === sessionValue());
}

export async function setAdminCookie() {
  const cookieStore = await cookies();
  const csrfToken = newCsrfToken();
  cookieStore.set(COOKIE_NAME, sessionValue(), {
    ...cookieOptions()
  });
  cookieStore.set(CSRF_COOKIE_NAME, csrfToken, cookieOptions());
  return csrfToken;
}

export async function clearAdminCookie() {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, "", {
    ...cookieOptions(0)
  });
  cookieStore.set(CSRF_COOKIE_NAME, "", cookieOptions(0));
}

export async function getOrCreateCsrfToken() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(CSRF_COOKIE_NAME)?.value;
  if (existing) return existing;
  const token = newCsrfToken();
  cookieStore.set(CSRF_COOKIE_NAME, token, cookieOptions());
  return token;
}

export async function requireAdminCsrf(request: Request) {
  const cookieStore = await cookies();
  const expected = cookieStore.get(CSRF_COOKIE_NAME)?.value || "";
  const received = request.headers.get("x-csrf-token") || "";
  return Boolean(expected && received && safeEquals(received, expected));
}
