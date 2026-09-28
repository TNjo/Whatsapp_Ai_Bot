import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * In-memory stand-in for the Firestore Admin SDK — the subset this app uses.
 * Used by tests (and FIREBASE_USE_MEMORY=true). It mirrors Firestore's rules
 * that matter for correctness: create() fails on existing docs, update() fails
 * on missing docs, transactions are atomic, and any query that Firestore would
 * reject without a composite index throws unless the index is declared in
 * firestore.indexes.json — so the shipped index file stays complete.
 */

type Data = Record<string, unknown>;
type Op = "==" | "<" | "<=" | ">" | ">=" | "in" | "array-contains";
type Filter = { field: string; op: Op; value: unknown };
type Order = { field: string; dir: "asc" | "desc" };

class FirestoreError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

const clone = <T>(value: T): T => structuredClone(value);

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    );
  }
  return value;
}

function rank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 2;
  if (value instanceof Date) return 3;
  if (typeof value === "string") return 4;
  return 5;
}

function compare(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
}

const equal = (a: unknown, b: unknown) => rank(a) === rank(b) && compare(a, b) === 0;

type IndexDef = { collectionGroup: string; fields: { fieldPath: string }[] };
let declaredIndexes: IndexDef[] | null = null;
function indexes(): IndexDef[] {
  if (declaredIndexes) return declaredIndexes;
  const file = path.join(process.cwd(), "firestore.indexes.json");
  declaredIndexes = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).indexes as IndexDef[]) : [];
  return declaredIndexes;
}

class Store {
  docs = new Map<string, Data>();
}

export class MemoryDocumentSnapshot {
  constructor(
    public ref: MemoryDocumentReference,
    private value: Data | undefined,
  ) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.value !== undefined;
  }
  data() {
    return this.value === undefined ? undefined : clone(this.value);
  }
}

export class MemoryQuerySnapshot {
  constructor(public docs: MemoryDocumentSnapshot[]) {}
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(fn: (doc: MemoryDocumentSnapshot) => void) {
    this.docs.forEach(fn);
  }
}

export class MemoryQuery {
  constructor(
    protected db: MemoryFirestore,
    public readonly path: string,
    protected filters: Filter[] = [],
    protected orders: Order[] = [],
    protected limitN: number | null = null,
    protected offsetN = 0,
    /** Collection-group query: `path` is the collection id, matched at any depth. */
    protected group = false,
  ) {}

  private copy(patch: Partial<{ filters: Filter[]; orders: Order[]; limitN: number | null; offsetN: number }>) {
    return new MemoryQuery(
      this.db,
      this.path,
      patch.filters ?? this.filters,
      patch.orders ?? this.orders,
      patch.limitN ?? this.limitN,
      patch.offsetN ?? this.offsetN,
      this.group,
    );
  }
  where(field: string, op: Op, value: unknown) {
    if (!["==", "<", "<=", ">", ">=", "in", "array-contains"].includes(op)) throw new Error(`Unsupported operator ${op}`);
    return this.copy({ filters: [...this.filters, { field, op, value }] });
  }
  orderBy(field: string, dir: "asc" | "desc" = "asc") {
    return this.copy({ orders: [...this.orders, { field, dir }] });
  }
  limit(n: number) {
    return this.copy({ limitN: n });
  }
  offset(n: number) {
    return this.copy({ offsetN: n });
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this.run(true).length }) }) };
  }
  async get() {
    return new MemoryQuerySnapshot(this.run(false));
  }

  /** Throws like Firestore does when a composite index would be required but isn't declared. */
  private checkIndex() {
    const equality = new Set(this.filters.filter((f) => f.op === "==" || f.op === "in" || f.op === "array-contains").map((f) => f.field));
    const range = new Set(this.filters.filter((f) => ["<", "<=", ">", ">="].includes(f.op)).map((f) => f.field));
    const ordered = this.orders.map((o) => o.field);
    if (range.size > 1) throw new FirestoreError(9, `Firestore doesn't allow range filters on more than one field (${[...range].join(", ")}).`);
    const needs = (equality.size > 0 && (range.size > 0 || ordered.length > 0)) || new Set([...range, ...ordered]).size > 1;
    if (!needs) return;
    const fields = new Set([...equality, ...range, ...ordered]);
    const group = this.path.split("/").at(-1)!;
    const found = indexes().some(
      (index) => index.collectionGroup === group && index.fields.length === fields.size && index.fields.every((f) => fields.has(f.fieldPath)),
    );
    if (!found) {
      throw new FirestoreError(
        9,
        `FAILED_PRECONDITION: The query requires a composite index on ${group} (${[...fields].join(", ")}). Add it to firestore.indexes.json.`,
      );
    }
  }

  run(countOnly: boolean): MemoryDocumentSnapshot[] {
    this.checkIndex();
    const prefix = `${this.path}/`;
    let rows: [string, Data][] = [];
    for (const [docPath, data] of this.db.store.docs) {
      const parts = docPath.split("/");
      const inScope = this.group ? parts.at(-2) === this.path : docPath.startsWith(prefix) && !docPath.slice(prefix.length).includes("/");
      if (inScope) rows.push([docPath, data]);
    }
    rows = rows.filter(([, data]) =>
      this.filters.every(({ field, op, value }) => {
        const v = data[field];
        switch (op) {
          case "==":
            return equal(v, value);
          case "in":
            return (value as unknown[]).some((x) => equal(v, x));
          case "array-contains":
            return Array.isArray(v) && v.some((x) => equal(x, value));
          default: {
            if (v === undefined || rank(v) !== rank(value)) return false;
            const c = compare(v, value);
            return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
          }
        }
      }),
    );
    // Firestore omits documents that lack an ordered field.
    rows = rows.filter(([, data]) => this.orders.every((o) => data[o.field] !== undefined));
    rows.sort(([pa, a], [pb, b]) => {
      for (const o of this.orders) {
        const c = compare(a[o.field], b[o.field]);
        if (c) return o.dir === "desc" ? -c : c;
      }
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    rows = rows.slice(this.offsetN, this.limitN === null ? undefined : this.offsetN + this.limitN);
    return rows.map(([docPath, data]) => new MemoryDocumentSnapshot(this.db.doc(docPath), countOnly ? {} : data));
  }
}

export class MemoryCollectionReference extends MemoryQuery {
  get id() {
    return this.path.split("/").at(-1)!;
  }
  doc(id?: string) {
    return new MemoryDocumentReference(this.db, `${this.path}/${id ?? crypto.randomBytes(10).toString("hex")}`);
  }
  async add(data: Data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

export class MemoryDocumentReference {
  constructor(
    private db: MemoryFirestore,
    public readonly path: string,
  ) {}
  get id() {
    return this.path.split("/").at(-1)!;
  }
  get parent() {
    return new MemoryCollectionReference(this.db, this.path.split("/").slice(0, -1).join("/"));
  }
  collection(name: string) {
    return new MemoryCollectionReference(this.db, `${this.path}/${name}`);
  }
  async get() {
    return this.snapshot();
  }
  snapshot() {
    return new MemoryDocumentSnapshot(this, this.db.store.docs.get(this.path));
  }
  async create(data: Data) {
    this.db.write(() => this.applyCreate(data));
  }
  async set(data: Data, options?: { merge?: boolean }) {
    this.db.write(() => this.applySet(data, options));
  }
  async update(data: Data) {
    this.db.write(() => this.applyUpdate(data));
  }
  async delete() {
    this.db.write(() => this.applyDelete());
  }
  applyCreate(data: Data) {
    if (this.db.store.docs.has(this.path)) throw new FirestoreError(6, `ALREADY_EXISTS: ${this.path}`);
    this.db.store.docs.set(this.path, clone(stripUndefined(data) as Data));
  }
  applySet(data: Data, options?: { merge?: boolean }) {
    const next = clone(stripUndefined(data) as Data);
    const current = this.db.store.docs.get(this.path);
    this.db.store.docs.set(this.path, options?.merge && current ? { ...current, ...next } : next);
  }
  applyUpdate(data: Data) {
    const current = this.db.store.docs.get(this.path);
    if (!current) throw new FirestoreError(5, `NOT_FOUND: ${this.path}`);
    for (const key of Object.keys(data)) if (key.includes(".")) throw new Error("Dotted field paths are not supported by the memory store");
    this.db.store.docs.set(this.path, { ...current, ...clone(stripUndefined(data) as Data) });
  }
  applyDelete() {
    this.db.store.docs.delete(this.path);
  }
}

type Write = () => void;

class MemoryWriteBatch {
  private writes: Write[] = [];
  constructor(private db: MemoryFirestore) {}
  create(ref: MemoryDocumentReference, data: Data) {
    this.writes.push(() => ref.applyCreate(data));
    return this;
  }
  set(ref: MemoryDocumentReference, data: Data, options?: { merge?: boolean }) {
    this.writes.push(() => ref.applySet(data, options));
    return this;
  }
  update(ref: MemoryDocumentReference, data: Data) {
    this.writes.push(() => ref.applyUpdate(data));
    return this;
  }
  delete(ref: MemoryDocumentReference) {
    this.writes.push(() => ref.applyDelete());
    return this;
  }
  async commit() {
    this.db.write(() => this.apply());
  }
  /** All-or-nothing: on any failure, the store is restored. */
  apply() {
    const backup = new Map(this.db.store.docs);
    try {
      for (const w of this.writes) w();
    } catch (err) {
      this.db.store.docs = backup;
      throw err;
    }
  }
}

class MemoryTransaction extends MemoryWriteBatch {
  private wrote = false;
  /** Firestore rule: every read in a transaction must happen before its first write. */
  private checkRead() {
    if (this.wrote) throw new FirestoreError(3, "INVALID_ARGUMENT: Firestore transactions require all reads to be executed before all writes.");
  }
  create(ref: MemoryDocumentReference, data: Data) {
    this.wrote = true;
    return super.create(ref, data);
  }
  set(ref: MemoryDocumentReference, data: Data, options?: { merge?: boolean }) {
    this.wrote = true;
    return super.set(ref, data, options);
  }
  update(ref: MemoryDocumentReference, data: Data) {
    this.wrote = true;
    return super.update(ref, data);
  }
  delete(ref: MemoryDocumentReference) {
    this.wrote = true;
    return super.delete(ref);
  }
  async get(target: MemoryDocumentReference | MemoryQuery) {
    this.checkRead();
    return target instanceof MemoryDocumentReference ? target.snapshot() : new MemoryQuerySnapshot(target.run(false));
  }
  async getAll(...refs: MemoryDocumentReference[]) {
    this.checkRead();
    return refs.map((r) => r.snapshot());
  }
}

export class MemoryFirestore {
  store = new Store();
  private queue: Promise<unknown> = Promise.resolve();

  collection(p: string) {
    return new MemoryCollectionReference(this, p);
  }
  collectionGroup(id: string) {
    return new MemoryQuery(this, id, [], [], null, 0, true);
  }
  doc(p: string) {
    return new MemoryDocumentReference(this, p);
  }
  batch() {
    return new MemoryWriteBatch(this);
  }
  async getAll(...refs: MemoryDocumentReference[]) {
    return refs.map((r) => r.snapshot());
  }
  write(fn: () => void) {
    fn();
  }
  /** Transactions run one at a time, so read-modify-write is atomic like Firestore's. */
  runTransaction<T>(fn: (tx: MemoryTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const tx = new MemoryTransaction(this);
      const result = await fn(tx);
      tx.apply();
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async terminate() {}
}
