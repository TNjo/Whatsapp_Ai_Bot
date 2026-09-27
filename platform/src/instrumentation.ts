/** Runs once per server start: apply database migrations before serving requests. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./db");
    await getDb();
  }
}
