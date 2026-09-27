import "server-only";
import type { AIProviderName } from "@/db/schema";
import { decryptSecret } from "../crypto";
import { env } from "../env";
import { ClaudeProvider, CLAUDE_DEFAULT_MODEL } from "./claude";
import { OPENAI_COMPATIBLE_DEFAULTS, OpenAICompatibleProvider } from "./openai-compatible";
import type { AICompletion, AIConfig, AIProvider, AIRequest } from "./types";
import { AIProviderError } from "./types";

export const AI_PROVIDERS: { value: AIProviderName; label: string; defaultModel: string }[] = [
  { value: "claude", label: "Claude (Anthropic)", defaultModel: CLAUDE_DEFAULT_MODEL },
  { value: "openai", label: "OpenAI", defaultModel: OPENAI_COMPATIBLE_DEFAULTS.openai.model },
  { value: "gemini", label: "Google Gemini", defaultModel: OPENAI_COMPATIBLE_DEFAULTS.gemini.model },
  { value: "groq", label: "Groq", defaultModel: OPENAI_COMPATIBLE_DEFAULTS.groq.model },
  { value: "custom", label: "Other OpenAI-compatible API", defaultModel: "" },
];

const PROVIDER_NAMES = new Set<string>(["claude", "openai", "gemini", "groq", "custom", "mock"]);

function inferProvider(apiKey: string): AIProviderName {
  if (apiKey.startsWith("sk-ant-")) return "claude";
  if (apiKey.startsWith("gsk_")) return "groq";
  if (apiKey.startsWith("AIza")) return "gemini";
  return "openai";
}

export type BotAISettings = {
  aiProvider: AIProviderName | null;
  aiModel: string;
  aiBaseUrl: string;
  aiApiKeyEnc: string | null;
};

/** Business settings win; server environment variables are the fallback. */
export function resolveAIConfig(settings: BotAISettings | null): AIConfig | null {
  const businessKey = decryptSecret(settings?.aiApiKeyEnc);
  const apiKey = businessKey || env.ai.apiKey;
  const envProvider = PROVIDER_NAMES.has(env.ai.provider) ? (env.ai.provider as AIConfig["provider"]) : null;
  if (envProvider === "mock" && !businessKey) return { provider: "mock", model: "mock", apiKey: "", baseUrl: "" };
  if (!apiKey) return null;

  const provider: AIConfig["provider"] = settings?.aiProvider ?? envProvider ?? inferProvider(apiKey);
  const defaults = provider === "claude" || provider === "mock" ? null : OPENAI_COMPATIBLE_DEFAULTS[provider];
  const model =
    settings?.aiModel ||
    (businessKey ? "" : env.ai.model) ||
    (provider === "claude" ? CLAUDE_DEFAULT_MODEL : (defaults?.model ?? ""));
  const baseUrl = settings?.aiBaseUrl || (businessKey ? "" : env.ai.baseUrl) || defaults?.baseUrl || "";
  return { provider, model, apiKey, baseUrl };
}

type MockHandler = (request: AIRequest) => AICompletion | Promise<AICompletion>;
const mockRef = globalThis as unknown as { __wabMockAI?: MockHandler };

/** Test hook: scripted AI responses when AI_PROVIDER=mock. */
export function setMockAIHandler(handler: MockHandler | undefined) {
  mockRef.__wabMockAI = handler;
}

export function createProvider(config: AIConfig): AIProvider {
  if (config.provider === "mock") {
    return {
      name: "mock",
      model: "mock",
      async complete(request) {
        if (!mockRef.__wabMockAI) throw new AIProviderError("No mock AI handler installed");
        return mockRef.__wabMockAI(request);
      },
    };
  }
  if (config.provider === "claude") return new ClaudeProvider(config.apiKey, config.model, config.baseUrl);
  if (!config.baseUrl) throw new AIProviderError("Set an API URL for this AI provider.");
  if (!config.model) throw new AIProviderError("Choose a model for this AI provider.");
  return new OpenAICompatibleProvider(config.provider, config.model, config.apiKey, config.baseUrl);
}
