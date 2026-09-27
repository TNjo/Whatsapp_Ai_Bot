import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { businessMembers, businesses, users } from "@/db/schema";
import { audit } from "./audit";
import { ensureBotSettings } from "./bot/settings";
import { ensureOrderForm } from "./commerce/order-form";
import { hashPassword, verifyPassword } from "./crypto";
import { ApiError } from "./http";

export async function registerBusiness(input: { businessName: string; name: string; email: string; password: string }) {
  const db = await getDb();
  const email = input.email.trim().toLowerCase();
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (taken) throw new ApiError(409, "An account with this email already exists. Sign in instead.");
  const passwordHash = await hashPassword(input.password);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email, name: input.name.trim(), passwordHash }).returning();
    const [business] = await tx.insert(businesses).values({ name: input.businessName.trim() }).returning();
    await tx.insert(businessMembers).values({ businessId: business.id, userId: user.id, role: "owner" });
    await ensureBotSettings(business.id, tx);
    await ensureOrderForm(business.id, tx);
    return { user, business };
  });
  await audit(result.business.id, { userId: result.user.id, name: result.user.name }, "business.registered", { type: "business", id: result.business.id });
  return result;
}

/** Constant-time-ish login: always runs a hash comparison, even for unknown emails. */
export async function authenticate(emailRaw: string, password: string) {
  const db = await getDb();
  const email = emailRaw.trim().toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
  if (!user || !ok) throw new ApiError(401, "Email or password is incorrect.");
  const [membership] = await db.select().from(businessMembers).where(eq(businessMembers.userId, user.id)).limit(1);
  if (!membership) throw new ApiError(403, "This account is not part of a business.");
  return { user, businessId: membership.businessId };
}
