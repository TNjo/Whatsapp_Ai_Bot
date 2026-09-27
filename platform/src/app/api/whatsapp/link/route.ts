import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { cancelLink, linkState, startLink } from "@/server/whatsapp/web";

/** Current linked-device state, including the QR code while waiting for a scan. */
export const GET = route("whatsapp.link.state", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  return json(linkState(auth.business.id));
});

/** Starts linking a WhatsApp number by QR code (unofficial WhatsApp Web connection). */
export const POST = route("whatsapp.link.start", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`wa-link:${auth.business.id}`, 20, 3600);
  return json(await startLink(auth.business.id, auth.actor));
});

/** Cancels linking before the QR code is scanned. */
export const DELETE = route("whatsapp.link.cancel", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  return json(await cancelLink(auth.business.id));
});
