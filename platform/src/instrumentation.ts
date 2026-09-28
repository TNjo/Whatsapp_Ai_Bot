/** Runs once per server start: connect to Firestore early so configuration problems are reported at boot. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { getDb } = await import("./db");
  try {
    await getDb();
  } catch (err) {
    console.error(`\n[firebase] ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
