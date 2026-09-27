import "server-only";
import { env } from "../env";
import { log } from "../logger";

export type GraphErrorBody = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
};

/** Known Cloud API error codes → wording a business owner can act on. */
const FRIENDLY: Record<number, string> = {
  0: "WhatsApp could not authenticate this request. Reconnect WhatsApp.",
  4: "WhatsApp API rate limit reached. Try again shortly.",
  10: "The WhatsApp connection is missing a permission. Reconnect and grant all requested permissions.",
  100: "WhatsApp rejected a parameter in the request.",
  190: "The WhatsApp access token has expired or was revoked. Reconnect WhatsApp.",
  200: "The WhatsApp connection is missing a permission. Reconnect and grant all requested permissions.",
  368: "WhatsApp temporarily blocked this number for policy reasons.",
  80007: "WhatsApp rate limit reached for this business account.",
  130429: "WhatsApp throughput limit reached. Try again shortly.",
  131000: "WhatsApp could not send the message. Try again.",
  131005: "Access denied. Check the WhatsApp permissions.",
  131008: "A required parameter is missing.",
  131009: "A parameter value is invalid.",
  131016: "WhatsApp is temporarily unavailable. Try again shortly.",
  131021: "The recipient cannot be the sender.",
  131026: "The message could not be delivered to this WhatsApp user.",
  131031: "This WhatsApp Business account is locked.",
  131042: "There is a payment problem on the WhatsApp Business account.",
  131045: "The phone number is not registered for the Cloud API.",
  131047: "More than 24 hours have passed since the customer last replied. Use an approved template.",
  131051: "This message type is not supported.",
  131052: "The media could not be downloaded.",
  131053: "The media could not be uploaded.",
  131056: "Too many messages to this customer in a short time. Try again shortly.",
  132000: "The template's variable count does not match.",
  132001: "That template does not exist or is not approved in this language.",
  132007: "The template content violates WhatsApp policy.",
  133010: "The phone number is not registered with the Cloud API.",
};

export class GraphError extends Error {
  constructor(
    public friendly: string,
    public status: number,
    public code?: number,
    public detail?: string,
  ) {
    super(friendly);
  }
  get windowClosed() {
    return this.code === 131047;
  }
  get tokenInvalid() {
    return this.code === 190 || this.status === 401;
  }
}

export function describeGraphError(error: GraphErrorBody | undefined, status: number): GraphError {
  const code = error?.code;
  const friendly = (code !== undefined && FRIENDLY[code]) || "WhatsApp returned an error. Please try again.";
  return new GraphError(friendly, status, code, error?.error_data?.details || error?.message);
}

type GraphInit = {
  method?: "GET" | "POST" | "DELETE";
  token: string;
  query?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  timeoutMs?: number;
};

/** Minimal Graph API client. Tokens travel only in the Authorization header. */
export async function graph<T>(path: string, init: GraphInit): Promise<T> {
  const url = new URL(`${env.meta.graphBaseUrl}/${env.meta.graphVersion}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
  if (init.json !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (err) {
    log.warn("whatsapp.graph.network_error", { path: url.pathname, err });
    throw new GraphError("Could not reach WhatsApp. Check the server's internet connection.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: GraphErrorBody };
  if (!res.ok || data?.error) {
    const error = describeGraphError(data?.error, res.status);
    log.warn("whatsapp.graph.error", { path: url.pathname, status: res.status, code: error.code, detail: error.detail });
    throw error;
  }
  return data;
}

/** Exchanges an Embedded Signup authorization code for a business integration token. */
export async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
  const url = new URL(`${env.meta.graphBaseUrl}/${env.meta.graphVersion}/oauth/access_token`);
  url.searchParams.set("client_id", env.meta.appId);
  url.searchParams.set("client_secret", env.meta.appSecret);
  url.searchParams.set("code", code);
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: GraphErrorBody };
  if (!res.ok || !data.access_token) {
    throw describeGraphError(data.error, res.status);
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Uses the app access token to inspect a user/business token (validity, scopes). */
export async function debugToken(token: string) {
  if (!env.meta.appId || !env.meta.appSecret) return null;
  const data = await graph<{
    data?: { is_valid?: boolean; scopes?: string[]; expires_at?: number; app_id?: string };
  }>("debug_token", {
    token: `${env.meta.appId}|${env.meta.appSecret}`,
    query: { input_token: token },
  });
  return data.data ?? null;
}
