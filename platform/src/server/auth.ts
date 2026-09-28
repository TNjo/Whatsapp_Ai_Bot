import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { fromDoc, store } from "@/db";
import type { Business, Membership, MemberRole, Session, User } from "@/db/schema";
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

export const membershipId = (businessId: string, userId: string) => `${businessId}_${userId}`;

export async function createSession(userId: string, businessId: string) {
  const s = await store();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  const userAgent = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await s.sessions.doc(sha256(token)).set({ userId, businessId, expiresAt, userAgent, createdAt: new Date() });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    expires: expiresAt,
  });
  if (Math.random() < 0.05) {
    const expired = await s.sessions.where("expiresAt", "<", new Date()).limit(200).get();
    const batch = s.db.batch();
    expired.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const s = await store();
    await s.sessions.doc(sha256(token)).delete();
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Resolves the signed-in user and the business they act for. The business id
 * always comes from the server-side session, never from the request.
 */
export async function getAuth(): Promise<AuthContext | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await store();
  const session = fromDoc<Session>(await s.sessions.doc(sha256(token)).get());
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const [userSnap, businessSnap, memberSnap] = await s.db.getAll(
    s.users.doc(session.userId),
    s.businesses.doc(session.businessId),
    s.memberships.doc(membershipId(session.businessId, session.userId)),
  );
  const user = fromDoc<User>(userSnap);
  const business = fromDoc<Business>(businessSnap);
  const membership = fromDoc<Membership>(memberSnap);
  if (!user || !business || !membership) return null;
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return {
    sessionId: session.id,
    user: { id: user.id, name: user.name, email: user.email },
    business: { id: business.id, name: business.name, currency: business.currency, timezone: business.timezone },
    role: membership.role,
    actor: { userId: user.id, name: user.name, ip },
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
