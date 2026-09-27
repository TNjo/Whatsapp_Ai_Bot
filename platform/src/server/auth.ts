import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { businessMembers, businesses, sessions, users, type MemberRole } from "@/db/schema";
import { randomToken, sha256 } from "./crypto";
import { env } from "./env";
import { ApiError } from "./http";
import type { AuditActor } from "./audit";

export const SESSION_COOKIE = "wab_session";
const SESSION_DAYS = 14;

export type AuthContext = {
  sessionId: string;
  user: { id: string; name: string; email: string };
  business: { id: string; name: string; currency: string; timezone: string };
  role: MemberRole;
  actor: AuditActor;
};

export async function createSession(userId: string, businessId: string) {
  const db = await getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  const userAgent = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await db.insert(sessions).values({ id: sha256(token), userId, businessId, expiresAt, userAgent });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    expires: expiresAt,
  });
  if (Math.random() < 0.05) await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Resolves the signed-in user and the business they act for. The business id
 * always comes from the server-side session, never from the request.
 */
export async function getAuth(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      userName: users.name,
      email: users.email,
      businessId: businesses.id,
      businessName: businesses.name,
      currency: businesses.currency,
      timezone: businesses.timezone,
      role: businessMembers.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(businesses, eq(businesses.id, sessions.businessId))
    .innerJoin(
      businessMembers,
      and(eq(businessMembers.businessId, sessions.businessId), eq(businessMembers.userId, sessions.userId)),
    )
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return {
    sessionId: row.sessionId,
    user: { id: row.userId, name: row.userName, email: row.email },
    business: { id: row.businessId, name: row.businessName, currency: row.currency, timezone: row.timezone },
    role: row.role,
    actor: { userId: row.userId, name: row.userName, ip },
  };
}

/** For Server Components: redirects to /login when signed out. */
export async function requirePageAuth(role?: MemberRole): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (role === "owner" && auth.role !== "owner") redirect("/dashboard?denied=1");
  return auth;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Mutating browser requests must come from our own origin (defence in depth next to SameSite cookies). */
export function assertSameOrigin(request: Request) {
  if (!MUTATING.has(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    host = null;
  }
  const expected = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  if (host !== expected) throw new ApiError(403, "Cross-site request blocked");
}

/** For Route Handlers: 401 when signed out, 403 when the role is too low. */
export async function requireApiAuth(request: Request, role?: MemberRole): Promise<AuthContext> {
  assertSameOrigin(request);
  const auth = await getAuth();
  if (!auth) throw new ApiError(401, "Please sign in again.");
  if (role === "owner" && auth.role !== "owner") throw new ApiError(403, "Only the business owner can do that.");
  return auth;
}
