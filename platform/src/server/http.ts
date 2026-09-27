import "server-only";
import { z, ZodError } from "zod";
import { log } from "./logger";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const notFound = (what = "Not found") => new ApiError(404, what);
export const forbidden = (message = "You do not have permission to do that.") => new ApiError(403, message);

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, init);
}

function describeZod(err: ZodError): string {
  const first = err.issues[0];
  if (!first) return "Invalid request";
  const field = first.path.join(".");
  return field ? `${field}: ${first.message}` : first.message;
}

/** Turns thrown errors into safe JSON responses. Unexpected errors never leak details. */
export function errorResponse(err: unknown, context: Record<string, unknown> = {}) {
  if (err instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (typeof err.extra.retryAfter === "number") headers["Retry-After"] = String(err.extra.retryAfter);
    return Response.json({ error: err.message, ...err.extra }, { status: err.status, headers });
  }
  if (err instanceof ZodError) {
    return Response.json({ error: describeZod(err), issues: err.issues }, { status: 400 });
  }
  log.error("api.unhandled", { ...context, err });
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/** Wraps a route handler with uniform error handling and request logging. */
export function route<C>(name: string, fn: Handler<C>): Handler<C> {
  return async (request, context) => {
    const started = Date.now();
    try {
      const response = await fn(request, context);
      log.debug("api.request", { route: name, method: request.method, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      return errorResponse(err, { route: name, method: request.method });
    }
  };
}

export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return schema.parse(body);
}

/**
 * Partial update body: validates with `schema.partial()` but keeps only the keys
 * the client sent (Zod applies `.default()` values even to omitted partial keys).
 */
export async function readPatch<T extends z.ZodObject>(request: Request, schema: T): Promise<Partial<z.infer<T>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Request body must be an object");
  const parsed = schema.partial().parse(body) as Record<string, unknown>;
  const sent = new Set(Object.keys(body));
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.has(key))) as Partial<z.infer<T>>;
}

export function pagination(url: URL, defaults = { limit: 25, max: 100 }) {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(defaults.max, Math.max(1, Number(url.searchParams.get("limit")) || defaults.limit));
  return { page, limit, offset: (page - 1) * limit };
}

/** Collapses whitespace, strips control characters and trims. */
export const cleanText = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim())
    .pipe(z.string().max(max));
