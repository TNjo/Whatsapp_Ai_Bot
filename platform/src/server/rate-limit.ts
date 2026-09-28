import "server-only";
import { keyId, store } from "@/db";
import type { RateLimit } from "@/db/schema";
import { ApiError } from "./http";

/**
 * Fixed-window counter in Firestore (rateLimits/{key}_{window}) so limits hold
 * across restarts and instances. `expireAt` can drive a Firestore TTL policy.
 * Throws a 429 ApiError when the window is exhausted.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const s = await store();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const ref = s.rateLimits.doc(`${keyId(key)}_${windowStart.getTime()}`);
  const count = await s.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = ((snap.data() as RateLimit | undefined)?.count ?? 0) + 1;
    tx.set(ref, { count: next, windowStart, expireAt: new Date(windowStart.getTime() + windowMs + 3600_000) });
    return next;
  });
  if (count > limit) {
    const retryAfter = Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);
    throw new ApiError(429, "Too many requests. Please wait a moment and try again.", { retryAfter });
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
}
