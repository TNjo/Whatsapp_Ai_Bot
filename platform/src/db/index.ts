import "server-only";
import crypto from "node:crypto";
import type { DocumentReference, DocumentSnapshot, Firestore, QuerySnapshot } from "firebase-admin/firestore";
import { MemoryFirestore } from "./memory-firestore";

export type { Firestore };
export * as schema from "./schema";

const globalRef = globalThis as unknown as { __wabFirestore?: Firestore };

export class DatabaseConfigError extends Error {}

function serviceAccount(): { projectId: string; clientEmail: string; privateKey: string } | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { project_id: string; client_email: string; private_key: string };
    return { projectId: parsed.project_id, clientEmail: parsed.client_email, privateKey: parsed.private_key };
  }
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (clientEmail && privateKey && projectId) return { projectId, clientEmail, privateKey };
  return null;
}

/**
 * Cloud Firestore via the Firebase Admin SDK (server only — the browser never
 * talks to the database). Credentials, in order:
 *   FIREBASE_SERVICE_ACCOUNT (JSON or base64 JSON), or
 *   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or
 *   Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / Google Cloud runtime) with FIREBASE_PROJECT_ID, or
 *   FIRESTORE_EMULATOR_HOST for the local emulator.
 * FIREBASE_USE_MEMORY=true (and tests) use a throwaway in-memory database.
 */
async function open(): Promise<Firestore> {
  if (process.env.FIREBASE_USE_MEMORY === "true" || process.env.NODE_ENV === "test") {
    return new MemoryFirestore() as unknown as Firestore;
  }
  const { initializeApp, getApps, cert, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const account = serviceAccount();
  const projectId = account?.projectId ?? process.env.FIREBASE_PROJECT_ID?.trim();
  if (!account && !projectId) {
    throw new DatabaseConfigError(
      "Firebase is not configured. Set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY). See .env.example.",
    );
  }
  const app =
    getApps().find((a) => a.name === "wab") ??
    initializeApp(
      {
        credential: account ? cert(account) : process.env.FIRESTORE_EMULATOR_HOST ? undefined : applicationDefault(),
        projectId,
      },
      "wab",
    );
  const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)");
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

let opening: Promise<Firestore> | null = null;

export async function getDb(): Promise<Firestore> {
  if (globalRef.__wabFirestore) return globalRef.__wabFirestore;
  opening ??= open()
    .then((db) => {
      globalRef.__wabFirestore = db;
      return db;
    })
    .catch((err) => {
      opening = null;
      throw err;
    });
  return opening;
}

/** Tests: start from an empty database. */
export async function closeDb() {
  const db = globalRef.__wabFirestore;
  globalRef.__wabFirestore = undefined;
  opening = null;
  await db?.terminate().catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

export function collections(db: Firestore) {
  const business = (businessId: string) => db.collection("businesses").doc(businessId);
  const settings = (businessId: string) => business(businessId).collection("settings");
  return {
    users: db.collection("users"),
    userEmails: db.collection("userEmails"),
    sessions: db.collection("sessions"),
    memberships: db.collection("memberships"),
    businesses: db.collection("businesses"),
    phoneNumbers: db.collection("phoneNumbers"),
    rateLimits: db.collection("rateLimits"),
    business,
    whatsapp: (b: string) => settings(b).doc("whatsapp"),
    bot: (b: string) => settings(b).doc("bot"),
    orderForm: (b: string) => settings(b).doc("orderForm"),
    templates: (b: string) => business(b).collection("templates"),
    customers: (b: string) => business(b).collection("customers"),
    conversations: (b: string) => business(b).collection("conversations"),
    messages: (b: string, conversationId: string) => business(b).collection("conversations").doc(conversationId).collection("messages"),
    waMessages: (b: string) => business(b).collection("waMessages"),
    categories: (b: string) => business(b).collection("categories"),
    products: (b: string) => business(b).collection("products"),
    services: (b: string) => business(b).collection("services"),
    carts: (b: string) => business(b).collection("carts"),
    orders: (b: string) => business(b).collection("orders"),
    faqs: (b: string) => business(b).collection("faqs"),
    knowledge: (b: string) => business(b).collection("knowledge"),
    notifications: (b: string) => business(b).collection("notifications"),
    auditLogs: (b: string) => business(b).collection("auditLogs"),
  };
}

/** Database + typed collection references in one call. */
export async function store() {
  const db = await getDb();
  return { db, ...collections(db) };
}

/* ------------------------------------------------------------------ */
/* Document helpers                                                    */
/* ------------------------------------------------------------------ */

/** Firestore returns Timestamps; the app works with Dates everywhere. */
function reviveDates(value: unknown): unknown {
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    const maybe = value as { toDate?: () => Date; seconds?: number };
    if (typeof maybe.toDate === "function" && typeof maybe.seconds === "number") return maybe.toDate();
    if (Array.isArray(value)) return value.map(reviveDates);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveDates(v)]));
  }
  return value;
}

export function fromDoc<T>(snap: DocumentSnapshot | { id: string; exists: boolean; data(): unknown }): T | null {
  if (!snap.exists) return null;
  return { ...(reviveDates(snap.data()) as object), id: snap.id } as T;
}

export function fromDocs<T>(snap: QuerySnapshot | { docs: { id: string; exists: boolean; data(): unknown }[] }): T[] {
  return snap.docs.map((doc) => fromDoc<T>(doc)!).filter(Boolean);
}

/** Removes `id` (it's the document id) before writing. */
export function toDoc<T extends object>(value: T): Omit<T, "id"> {
  const { id: _id, ...rest } = value as T & { id?: unknown };
  void _id;
  return rest as Omit<T, "id">;
}

export async function getOne<T>(ref: DocumentReference): Promise<T | null> {
  return fromDoc<T>(await ref.get());
}

export function newId() {
  return crypto.randomBytes(10).toString("hex");
}

/** Firestore error codes (gRPC): 5 = NOT_FOUND, 6 = ALREADY_EXISTS. */
export function isAlreadyExists(err: unknown) {
  const code = (err as { code?: number | string })?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}
export function isNotFound(err: unknown) {
  const code = (err as { code?: number | string })?.code;
  return code === 5 || code === "not-found" || code === "NOT_FOUND";
}

export const now = () => new Date();

/** Stable document id for an arbitrary external key (e.g. a WhatsApp message id). */
export function keyId(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
}
