import { z } from "zod";
import { assertSameOrigin, createSession } from "@/server/auth";
import { registerBusiness } from "@/server/business";
import { cleanText, json, readJson, route } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";

const Body = z.object({
  businessName: cleanText(80).pipe(z.string().min(2, "Business name is too short")),
  name: cleanText(80).pipe(z.string().min(2, "Your name is too short")),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

export const POST = route("auth.register", async (request) => {
  assertSameOrigin(request);
  await rateLimit(`register:${clientIp(request)}`, 5, 3600);
  const body = await readJson(request, Body);
  const { user, business } = await registerBusiness(body);
  await createSession(user.id, business.id);
  return json({ ok: true }, { status: 201 });
});
