import "server-only";
import path from "node:path";
import fs from "node:fs";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

type Holder = { db: Database; ready: Promise<void>; close: () => Promise<void> };

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const globalRef = globalThis as unknown as { __wabDb?: Holder };

/**
 * PostgreSQL when DATABASE_URL is set. Without it (local development) the app
 * runs an embedded PostgreSQL (PGlite) stored in PGLITE_DIR / .data/pglite.
 */
async function open(): Promise<Holder> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE || 10) });
    const db = drizzlePg(pool, { schema });
    return { db, ready: migratePg(db, { migrationsFolder: MIGRATIONS }), close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate: migratePglite } = await import("drizzle-orm/pglite/migrator");
  const configured = process.env.PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
  // "memory://" keeps the database in RAM (tests); anything else is a directory on disk.
  const dir = configured.startsWith("memory://") ? configured : path.resolve(/*turbopackIgnore: true*/ configured);
  if (!dir.startsWith("memory://")) fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Database,
    ready: migratePglite(db, { migrationsFolder: MIGRATIONS }),
    close: () => client.close(),
  };
}

let opening: Promise<Holder> | null = null;

/** Returns the migrated database. Safe to call from any server entry point. */
export async function getDb(): Promise<Database> {
  if (globalRef.__wabDb) {
    await globalRef.__wabDb.ready;
    return globalRef.__wabDb.db;
  }
  opening ??= open().then((holder) => {
    globalRef.__wabDb = holder;
    return holder;
  });
  const holder = await opening;
  await holder.ready;
  return holder.db;
}

export async function closeDb() {
  const holder = globalRef.__wabDb;
  globalRef.__wabDb = undefined;
  opening = null;
  if (holder) await holder.close();
}

export { schema };
