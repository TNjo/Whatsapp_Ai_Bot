import { z } from "zod";
import { audit } from "@/server/audit";
import { assertSameOrigin, createSession } from "@/server/auth";
import { authenticate } from "@/server/business";
import { json, readJson, route } from "@/server/http";
import { clientIp, rateLimit } from "@/server/rate-limit";

const Body = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().max(200),
});

export const POST = route("auth.login", async (request) => {
  assertSameOrigin(request);
  const ip = clientIp(request);
  const body = await readJson(request, Body);
  await rateLimit(`login:${ip}`, 20, 900);
  await rateLimit(`login:${body.email}`, 10, 900);
  const { user, businessId } = await authenticate(body.email, body.password);
  await createSession(user.id, businessId);
  await audit(businessId, { userId: user.id, name: user.name, ip }, "auth.login", { type: "user", id: user.id });
  return json({ ok: true });
});
