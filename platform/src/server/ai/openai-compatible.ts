import "server-only";
import type { AIProviderName } from "@/db/schema";
import type { AICompletion, AIMessage, AIProvider, AIRequest } from "./types";
import { AIProviderError } from "./types";

/** OpenAI Chat Completions wire format — used by OpenAI, Groq, Gemini (OpenAI endpoint) and custom servers. */
export const OPENAI_COMPATIBLE_DEFAULTS: Record<Exclude<AIProviderName, "claude">, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  custom: { baseUrl: "", model: "" },
};

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export class OpenAICompatibleProvider implements AIProvider {
  constructor(
    readonly name: Exclude<AIProviderName, "claude">,
    readonly model: string,
    private apiKey: string,
    private baseUrl: string,
  ) {}

  private toWire(system: string, messages: AIMessage[]): WireMessage[] {
    const out: WireMessage[] = [{ role: "system", content: system }];
    for (const message of messages) {
      if (message.role === "user") out.push({ role: "user", content: message.content });
      else if (message.role === "tool") out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
      else
        out.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls?.length
            ? message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              }))
            : undefined,
        });
    }
    return out;
  }

  async complete(request: AIRequest): Promise<AICompletion> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: this.model,
          messages: this.toWire(request.system, request.messages),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: "auto",
          max_completion_tokens: request.maxTokens ?? 4000,
        }),
      });
    } catch {
      throw new AIProviderError(`Could not reach the ${this.name} API.`, undefined, true);
    }

    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      choices?: {
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (!res.ok) {
      const message = data.error?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new AIProviderError(`The ${this.name} API key was rejected.`, res.status);
      throw new AIProviderError(`${this.name} error: ${message}`, res.status, res.status === 429 || res.status >= 500);
    }

    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = { __invalid_json: call.function.arguments };
      }
      return { id: call.id, name: call.function.name, arguments: args };
    });

    return {
      text: (choice?.message?.content ?? "").trim(),
      toolCalls,
      raw: choice?.message,
      stopReason: toolCalls.length
        ? "tool_calls"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : choice?.finish_reason === "content_filter"
            ? "refusal"
            : "end",
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  }
}

/** Lists model ids — used by the "Test connection" button. */
export async function listOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new AIProviderError(res.status === 401 ? "The API key was rejected." : `HTTP ${res.status}`, res.status);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((model) => model.id.replace(/^models\//, "")).sort();
}
