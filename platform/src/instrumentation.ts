/** Runs once per server start: apply database migrations, then reconnect linked WhatsApp devices. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("./db");
  await getDb();
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.WHATSAPP_WEB_DISABLED === "true") return;
  const { resumeLinkedDevices } = await import("./server/whatsapp/web");
  // Don't hold up startup while headless Chrome boots.
  resumeLinkedDevices().catch((err) => console.error("Could not resume linked WhatsApp devices", err));
}
