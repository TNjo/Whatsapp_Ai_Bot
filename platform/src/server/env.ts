import "server-only";

function read(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value.trim();
}

/** Server-side configuration. Nothing here is ever sent to the browser. */
export const env = {
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
  get appUrl() {
    return read("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get encryptionKey() {
    return read("ENCRYPTION_KEY");
  },
  meta: {
    get appId() {
      return read("META_APP_ID");
    },
    get appSecret() {
      return read("META_APP_SECRET");
    },
    get webhookVerifyToken() {
      return read("META_WEBHOOK_VERIFY_TOKEN");
    },
    get embeddedSignupConfigId() {
      return read("META_EMBEDDED_SIGNUP_CONFIG_ID");
    },
    get graphVersion() {
      return read("META_GRAPH_VERSION", "v23.0");
    },
    /** Overridable so tests can point at a local mock of the Graph API. */
    get graphBaseUrl() {
      return read("WHATSAPP_GRAPH_BASE_URL", "https://graph.facebook.com").replace(/\/$/, "");
    },
  },
  whatsapp: {
    /** Optional single-tenant defaults (spec §52). Used by the "Use server credentials" connect option. */
    get accessToken() {
      return read("WHATSAPP_ACCESS_TOKEN");
    },
    get phoneNumberId() {
      return read("WHATSAPP_PHONE_NUMBER_ID");
    },
    get businessAccountId() {
      return read("WHATSAPP_BUSINESS_ACCOUNT_ID");
    },
  },
  ai: {
    get provider() {
      return read("AI_PROVIDER");
    },
    get apiKey() {
      return read("AI_API_KEY");
    },
    get model() {
      return read("AI_MODEL");
    },
    get baseUrl() {
      return read("AI_BASE_URL");
    },
  },
};
