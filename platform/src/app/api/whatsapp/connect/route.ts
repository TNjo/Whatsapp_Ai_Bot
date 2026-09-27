import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { json, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { connectManually, connectWithEmbeddedSignup } from "@/server/whatsapp/connection";

const id = z.string().trim().regex(/^\d{5,25}$/, "IDs are numeric — copy them from Meta");

const Body = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("embedded"), code: z.string().min(10).max(2000), phoneNumberId: id, wabaId: id, pin: z.string().regex(/^\d{6}$/).optional() }),
  z.object({ mode: z.literal("manual"), accessToken: z.string().trim().min(20).max(1000), phoneNumberId: id, wabaId: id }),
  z.object({ mode: z.literal("server") }),
]);

/** Connects the business's WhatsApp number (Embedded Signup, manual System User token, or server credentials). */
export const POST = route("whatsapp.connect", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`wa-connect:${auth.business.id}`, 20, 3600);
  const body = await readJson(request, Body);
  const businessId = auth.business.id;
  const view =
    body.mode === "embedded"
      ? await connectWithEmbeddedSignup(businessId, body, auth.actor)
      : body.mode === "manual"
        ? await connectManually(businessId, body, auth.actor)
        : await connectManually(businessId, { useServerCredentials: true }, auth.actor);
  return json(view);
});
