import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { requireApiAuth } from "@/server/auth";
import { forbidden, notFound, route } from "@/server/http";
import { localUploadPath } from "@/server/whatsapp/messaging";

const CONTENT_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Serves an uploaded file to signed-in members of the business that owns it. */
export const GET = route("uploads.get", async (request, ctx: RouteContext<"/api/uploads/[businessId]/[file]">) => {
  const auth = await requireApiAuth(request);
  const { businessId, file } = await ctx.params;
  if (businessId !== auth.business.id) throw forbidden();

  const filePath = localUploadPath(`/api/uploads/${businessId}/${file}`);
  if (!filePath) throw notFound("File not found");
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw notFound("File not found");

  const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPE[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
