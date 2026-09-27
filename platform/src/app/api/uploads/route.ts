import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit } from "@/server/audit";
import { requireApiAuth } from "@/server/auth";
import { ApiError, badRequest, json, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { localUploadPath, UPLOAD_ROOT } from "@/server/whatsapp/messaging";

const MAX_BYTES = 5 * 1024 * 1024;

/** Detects the real image type from its first bytes — the browser-supplied type is not trusted. */
function imageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/**
 * POST multipart/form-data with a "file" field (PNG, JPEG or WebP, max 5 MB).
 * Returns `{ url }` — "/api/uploads/<businessId>/<file>" — readable only by the same business.
 */
export const POST = route("uploads.create", async (request) => {
  const auth = await requireApiAuth(request);
  const businessId = auth.business.id;
  await rateLimit(`upload:${businessId}`, 60, 3600);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BYTES + 64 * 1024) throw new ApiError(413, "Images must be 5 MB or smaller.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw badRequest("Send the image as multipart/form-data in a “file” field.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose an image to upload.");
  if (file.size === 0) throw badRequest("That file is empty.");
  if (file.size > MAX_BYTES) throw new ApiError(413, "Images must be 5 MB or smaller.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = imageExtension(bytes);
  if (!ext) throw new ApiError(415, "Only PNG, JPEG or WebP images are supported.");

  const name = crypto.randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "");
  const url = `/api/uploads/${businessId}/${name}.${ext}`;
  const target = localUploadPath(url);
  if (!target) throw new ApiError(500, "Could not store the image.");

  await fs.mkdir(path.join(UPLOAD_ROOT, businessId), { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx" });
  await audit(businessId, auth.actor, "upload.created", { type: "upload", id: `${name}.${ext}` }, { bytes: bytes.length, type: ext });
  return json({ url }, { status: 201 });
});
