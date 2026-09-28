import "server-only";
import { fromDoc, fromDocs, newId, store } from "@/db";
import { BUSINESS_DEFAULTS, type Membership, type User } from "@/db/schema";
import { audit } from "./audit";
import { membershipId } from "./auth";
import { ensureBotSettings } from "./bot/settings";
import { ensureOrderForm } from "./commerce/order-form";
import { hashPassword, verifyPassword } from "./crypto";
import { ApiError } from "./http";

export async function registerBusiness(input: { businessName: string; name: string; email: string; password: string }) {
  const s = await store();
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = newId();
  const businessId = newId();
  const now = new Date();
  const user: User = { id: userId, email, name: input.name.trim(), passwordHash, createdAt: now, updatedAt: now };

  await s.db.runTransaction(async (tx) => {
    const taken = await tx.get(s.userEmails.doc(email));
    if (taken.exists) throw new ApiError(409, "An account with this email already exists. Sign in instead.");
    tx.create(s.userEmails.doc(email), { userId });
    tx.create(s.users.doc(userId), { email, name: user.name, passwordHash, createdAt: now, updatedAt: now });
    tx.create(s.businesses.doc(businessId), { ...BUSINESS_DEFAULTS, name: input.businessName.trim(), createdAt: now, updatedAt: now });
    tx.create(s.memberships.doc(membershipId(businessId, userId)), { businessId, userId, role: "owner", createdAt: now });
  });
  await ensureBotSettings(businessId);
  await ensureOrderForm(businessId);
  await audit(businessId, { userId, name: user.name }, "business.registered", { type: "business", id: businessId });
  return { user, business: { id: businessId, name: input.businessName.trim() } };
}

const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

/** Always runs a hash comparison, even for unknown emails, so timing doesn't reveal accounts. */
export async function authenticate(emailRaw: string, password: string) {
  const s = await store();
  const email = emailRaw.trim().toLowerCase();
  const index = (await s.userEmails.doc(email).get()).data() as { userId?: string } | undefined;
  const user = index?.userId ? fromDoc<User>(await s.users.doc(index.userId).get()) : null;
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new ApiError(401, "Email or password is incorrect.");
  const [membership] = fromDocs<Membership>(await s.memberships.where("userId", "==", user.id).limit(1).get());
  if (!membership) throw new ApiError(403, "This account is not part of a business.");
  return { user, businessId: membership.businessId };
}
