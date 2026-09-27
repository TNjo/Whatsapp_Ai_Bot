import "server-only";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const SECRET_KEYS = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|pin|cookie|signature)/i;
const TOKEN_PATTERNS = [
  /EAA[A-Za-z0-9]{20,}/g, // Meta access tokens
  /\b(sk|gsk|sk-ant|AIza)[-_A-Za-z0-9]{16,}/g, // common AI provider keys
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

function scrubString(value: string): string {
  let out = value;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

/** Never let secrets reach the logs, even nested or embedded in strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Fields = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, event: string, fields: Fields = {}) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.LOG_LEVEL === "silent") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Structured logs. Event names are dotted, e.g. "webhook.received",
 * "whatsapp.send.failed", "ai.request", "order.created".
 */
export const log = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
