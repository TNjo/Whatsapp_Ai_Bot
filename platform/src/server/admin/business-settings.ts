import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLogs, businessMembers, businesses, sessions, users } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { hashPassword } from "../crypto";
import { ApiError, cleanText, forbidden, notFound } from "../http";

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
  const db = await getDb();
  const [row] = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      logoUrl: businesses.logoUrl,
      description: businesses.description,
      phone: businesses.phone,
      email: businesses.email,
      address: businesses.address,
      website: businesses.website,
      whatsappNumber: businesses.whatsappNumber,
      openingHours: businesses.openingHours,
      deliveryInfo: businesses.deliveryInfo,
      deliveryFee: businesses.deliveryFee,
      paymentMethods: businesses.paymentMethods,
      bankDetails: businesses.bankDetails,
      returnPolicy: businesses.returnPolicy,
      exchangePolicy: businesses.exchangePolicy,
      currency: businesses.currency,
      timezone: businesses.timezone,
      lowStockThreshold: businesses.lowStockThreshold,
      updatedAt: businesses.updatedAt,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!row) throw notFound("Business not found");
  return row;
}

export async function updateBusinessProfile(businessId: string, input: Partial<z.infer<typeof BusinessInput>>, actor: AuditActor) {
  const db = await getDb();
  if (Object.keys(input).length) {
    const [row] = await db.update(businesses).set(input).where(eq(businesses.id, businessId)).returning({ id: businesses.id });
    if (!row) throw notFound("Business not found");
    await audit(businessId, actor, "business.updated", { type: "business", id: businessId }, { fields: Object.keys(input) });
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

export async function listMembers(businessId: string) {
  const db = await getDb();
  return db
    .select({
      id: businessMembers.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: businessMembers.role,
      joinedAt: businessMembers.createdAt,
    })
    .from(businessMembers)
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(eq(businessMembers.businessId, businessId))
    .orderBy(asc(businessMembers.createdAt));
}

export type MemberRow = Awaited<ReturnType<typeof listMembers>>[number];

const EMAIL_TAKEN = "An account with this email already exists. Use a different email address.";

export async function addStaffMember(businessId: string, input: z.infer<typeof MemberInput>, actor: AuditActor) {
  const db = await getDb();
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (taken) throw new ApiError(409, EMAIL_TAKEN);
  const passwordHash = await hashPassword(input.password);
  try {
    const member = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash }).returning();
      const [row] = await tx.insert(businessMembers).values({ businessId, userId: user.id, role: "staff" }).returning();
      return { id: row.id, userId: user.id, name: user.name, email: user.email, role: row.role, joinedAt: row.createdAt };
    });
    await audit(businessId, actor, "member.added", { type: "user", id: member.userId }, { email: member.email, role: "staff" });
    return member;
  } catch (err) {
    // Two requests racing for the same email hit the unique index.
    if (isUniqueViolation(err)) throw new ApiError(409, EMAIL_TAKEN);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth += 1) {
    if (e.code === "23505") return true;
  }
  return false;
}

/**
 * Removes a staff member and signs them out of this business. A user that no
 * longer belongs to any business is deleted so the email can be invited again.
 */
export async function removeMember(businessId: string, memberId: string, actor: AuditActor) {
  if (!z.uuid().safeParse(memberId).success) throw notFound("Team member not found");
  const db = await getDb();
  const [member] = await db
    .select({ id: businessMembers.id, userId: businessMembers.userId, role: businessMembers.role, email: users.email })
    .from(businessMembers)
    .innerJoin(users, eq(users.id, businessMembers.userId))
    .where(and(eq(businessMembers.id, memberId), eq(businessMembers.businessId, businessId)))
    .limit(1);
  if (!member) throw notFound("Team member not found");
  if (member.userId === actor.userId) throw forbidden("You can't remove yourself.");
  if (member.role === "owner") throw forbidden("The business owner can't be removed.");

  await db.transaction(async (tx) => {
    await tx.delete(businessMembers).where(eq(businessMembers.id, member.id));
    await tx.delete(sessions).where(and(eq(sessions.userId, member.userId), eq(sessions.businessId, businessId)));
    const [other] = await tx.select({ id: businessMembers.id }).from(businessMembers).where(eq(businessMembers.userId, member.userId)).limit(1);
    if (!other) await tx.delete(users).where(eq(users.id, member.userId));
  });
  await audit(businessId, actor, "member.removed", { type: "user", id: member.userId }, { email: member.email });
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

export async function listAuditLogs(businessId: string, limit = 100) {
  const db = await getDb();
  return db
    .select({
      id: auditLogs.id,
      actor: auditLogs.actor,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(eq(auditLogs.businessId, businessId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Math.max(1, limit), 100));
}

export type AuditRow = Awaited<ReturnType<typeof listAuditLogs>>[number];
