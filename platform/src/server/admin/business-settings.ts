import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, newId, store } from "@/db";
import type { AuditLog, Business, Membership, Session, User } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { membershipId } from "../auth";
import { hashPassword } from "../crypto";
import { ApiError, cleanText, docId, forbidden, notFound } from "../http";

/* ------------------------------------------------------------------ */
/* Business profile                                                    */
/* ------------------------------------------------------------------ */

/** Prices arrive in major units from forms ("350") and are stored in minor units. */
const money = z.coerce.number().min(0).max(100_000_000).transform((v) => Math.round(v * 100));

const optionalEmail = cleanText(200).pipe(z.union([z.literal(""), z.email("Enter a valid email")]));

/** Accepts "shop.lk" or "https://shop.lk"; stores a full http(s) URL or "". */
const website = cleanText(200)
  .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v))
  .refine((v) => {
    if (!v) return true;
    try {
      const url = new URL(v);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
    } catch {
      return false;
    }
  }, "Enter a valid website address");

/** Uploaded logos are same-origin paths ("/uploads/…") or absolute http(s) URLs. */
const logoUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\//i.test(v), "Invalid logo URL")
  .nullable();

const timezone = z
  .string()
  .trim()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone");

export const BusinessInput = z.object({
  name: cleanText(80).pipe(z.string().min(2, "Business name is too short")),
  logoUrl,
  description: cleanText(2000),
  phone: cleanText(40),
  email: optionalEmail,
  address: cleanText(500),
  website,
  whatsappNumber: cleanText(40),
  openingHours: cleanText(1000),
  deliveryInfo: cleanText(2000),
  deliveryFee: money,
  paymentMethods: z
    .array(cleanText(60))
    .max(20, "Up to 20 payment methods")
    .transform((list) => [...new Set(list.filter(Boolean))])
    .pipe(z.array(z.string()).min(1, "Add at least one payment method")),
  bankDetails: cleanText(2000),
  returnPolicy: cleanText(3000),
  exchangePolicy: cleanText(3000),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code like LKR"),
  timezone,
  lowStockThreshold: z.coerce.number().int().min(0).max(100_000),
});

export type BusinessProfile = Awaited<ReturnType<typeof getBusinessProfile>>;

export async function getBusinessProfile(businessId: string) {
  const s = await store();
  const row = fromDoc<Business>(await s.businesses.doc(businessId).get());
  if (!row) throw notFound("Business not found");
  return {
    id: row.id,
    name: row.name,
    logoUrl: row.logoUrl,
    description: row.description,
    phone: row.phone,
    email: row.email,
    address: row.address,
    website: row.website,
    whatsappNumber: row.whatsappNumber,
    openingHours: row.openingHours,
    deliveryInfo: row.deliveryInfo,
    deliveryFee: row.deliveryFee,
    paymentMethods: row.paymentMethods,
    bankDetails: row.bankDetails,
    returnPolicy: row.returnPolicy,
    exchangePolicy: row.exchangePolicy,
    currency: row.currency,
    timezone: row.timezone,
    lowStockThreshold: row.lowStockThreshold,
    updatedAt: row.updatedAt,
  };
}

export async function updateBusinessProfile(businessId: string, input: Partial<z.infer<typeof BusinessInput>>, actor: AuditActor) {
  const s = await store();
  const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (Object.keys(fields).length) {
    const ref = s.businesses.doc(businessId);
    await s.db.runTransaction(async (tx) => {
      if (!(await tx.get(ref)).exists) throw notFound("Business not found");
      tx.update(ref, { ...fields, updatedAt: new Date() });
    });
    await audit(businessId, actor, "business.updated", { type: "business", id: businessId }, { fields: Object.keys(fields) });
  }
  return getBusinessProfile(businessId);
}

/* ------------------------------------------------------------------ */
/* Team                                                                */
/* ------------------------------------------------------------------ */

export const MemberInput = z.object({
  name: cleanText(80).pipe(z.string().min(2, "Name is too short")),
  email: z.string().trim().toLowerCase().max(200).pipe(z.email("Enter a valid email")),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export type MemberRow = {
  /** Membership document id ({businessId}_{userId}). */
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Membership["role"];
  joinedAt: Date;
};

export async function listMembers(businessId: string): Promise<MemberRow[]> {
  const s = await store();
  const members = fromDocs<Membership>(await s.memberships.where("businessId", "==", businessId).get());
  if (!members.length) return [];
  const userSnaps = await s.db.getAll(...members.map((m) => s.users.doc(m.userId)));
  const users = new Map(userSnaps.map((snap) => fromDoc<User>(snap)).filter((u): u is User => Boolean(u)).map((u) => [u.id, u]));
  return members
    .filter((m) => users.has(m.userId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => {
      const user = users.get(m.userId)!;
      return { id: m.id, userId: user.id, name: user.name, email: user.email, role: m.role, joinedAt: m.createdAt };
    });
}

const EMAIL_TAKEN = "An account with this email already exists. Use a different email address.";

export async function addStaffMember(businessId: string, input: z.infer<typeof MemberInput>, actor: AuditActor): Promise<MemberRow> {
  const s = await store();
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = newId();
  const now = new Date();
  const id = membershipId(businessId, userId);

  // userEmails/{email} is the unique index: two requests racing for one email can't both win.
  await s.db.runTransaction(async (tx) => {
    const taken = await tx.get(s.userEmails.doc(email));
    if (taken.exists) throw new ApiError(409, EMAIL_TAKEN);
    tx.create(s.userEmails.doc(email), { userId });
    tx.create(s.users.doc(userId), { email, name: input.name, passwordHash, createdAt: now, updatedAt: now });
    tx.create(s.memberships.doc(id), { businessId, userId, role: "staff", createdAt: now });
  });

  const member: MemberRow = { id, userId, name: input.name, email, role: "staff", joinedAt: now };
  await audit(businessId, actor, "member.added", { type: "user", id: userId }, { email, role: "staff" });
  return member;
}

/**
 * Removes a staff member and signs them out of this business. A user that no
 * longer belongs to any business is deleted so the email can be invited again.
 */
export async function removeMember(businessId: string, memberId: string, actor: AuditActor) {
  if (!docId.safeParse(memberId).success) throw notFound("Team member not found");
  const s = await store();
  const memberRef = s.memberships.doc(memberId);
  const member = fromDoc<Membership>(await memberRef.get());
  if (!member || member.businessId !== businessId) throw notFound("Team member not found");
  if (member.userId === actor.userId) throw forbidden("You can't remove yourself.");
  if (member.role === "owner") throw forbidden("The business owner can't be removed.");

  const email = await s.db.runTransaction(async (tx) => {
    const [memberSnap, userSnap, others, sessions] = await Promise.all([
      tx.get(memberRef),
      tx.get(s.users.doc(member.userId)),
      tx.get(s.memberships.where("userId", "==", member.userId)),
      tx.get(s.sessions.where("userId", "==", member.userId)),
    ]);
    if (!memberSnap.exists) throw notFound("Team member not found");
    const user = fromDoc<User>(userSnap);
    const orphaned = Boolean(user) && !others.docs.some((doc) => doc.id !== memberId);
    // Firestore transactions read everything before the first write.
    const emailIndex = orphaned && user ? await tx.get(s.userEmails.doc(user.email)) : null;

    tx.delete(memberRef);
    for (const session of fromDocs<Session>(sessions)) {
      if (session.businessId === businessId) tx.delete(s.sessions.doc(session.id));
    }
    if (orphaned && user) {
      tx.delete(s.users.doc(user.id));
      // Only drop the email index if it still points at this user.
      if ((emailIndex?.data() as { userId?: string } | undefined)?.userId === user.id) tx.delete(s.userEmails.doc(user.email));
    }
    return user?.email ?? null;
  });
  await audit(businessId, actor, "member.removed", { type: "user", id: member.userId }, { email });
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

export async function listAuditLogs(businessId: string, limit = 100) {
  const s = await store();
  const rows = fromDocs<AuditLog>(
    await s
      .auditLogs(businessId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(1, limit), 100))
      .get(),
  );
  return rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: row.metadata,
    ip: row.ip,
    createdAt: row.createdAt,
  }));
}

export type AuditRow = Awaited<ReturnType<typeof listAuditLogs>>[number];
