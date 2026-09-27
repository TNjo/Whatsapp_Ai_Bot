import type { AIProviderName } from "@/db/schema";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolCall = { id: string; name: string; arguments: unknown };

/**
 * Provider-neutral conversation. `raw` carries the provider's own assistant
 * content (e.g. Claude thinking + tool_use blocks) so it can be replayed
 * unchanged to the same provider inside one tool loop.
 */
export type AIMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown; provider?: AIProviderName | "mock" }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type AICompletion = {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stopReason: "end" | "tool_calls" | "max_tokens" | "refusal" | "other";
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type AIRequest = {
  system: string;
  messages: AIMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
};

export interface AIProvider {
  readonly name: AIProviderName | "mock";
  readonly model: string;
  complete(request: AIRequest): Promise<AICompletion>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
  }
}

export type AIConfig = {
  provider: AIProviderName | "mock";
  model: string;
  apiKey: string;
  baseUrl: string;
};
