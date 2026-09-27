import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { AICompletion, AIMessage, AIProvider, AIRequest } from "./types";
import { AIProviderError } from "./types";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** Claude via the official Anthropic SDK (Messages API with client-side tools). */
export class ClaudeProvider implements AIProvider {
  readonly name = "claude" as const;
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string = CLAUDE_DEFAULT_MODEL,
    baseUrl?: string,
  ) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 2, timeout: 60_000 });
  }

  private toMessages(messages: AIMessage[]): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    let pendingResults: BetaToolResult[] = [];
    const flushResults = () => {
      if (pendingResults.length) {
        // All results of one assistant turn go back in a single user message.
        out.push({ role: "user", content: pendingResults });
        pendingResults = [];
      }
    };
    for (const message of messages) {
      if (message.role === "tool") {
        pendingResults.push({
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError || undefined,
        });
        continue;
      }
      flushResults();
      if (message.role === "user") {
        out.push({ role: "user", content: message.content });
      } else if (message.provider === "claude" && Array.isArray(message.raw)) {
        // Replay Claude's own content blocks (thinking, tool_use) unchanged.
        out.push({ role: "assistant", content: message.raw as Anthropic.Beta.BetaContentBlockParam[] });
      } else if (message.content) {
        out.push({ role: "assistant", content: message.content });
      }
    }
    flushResults();
    return out;
  }

  async complete(request: AIRequest): Promise<AICompletion> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: request.system,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
        })),
        messages: this.toMessages(request.messages),
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AIProviderError("The Claude API key was rejected.", 401);
      if (err instanceof Anthropic.RateLimitError) throw new AIProviderError("Claude rate limit reached.", 429, true);
      if (err instanceof Anthropic.BadRequestError) throw new AIProviderError(`Claude rejected the request: ${err.message}`, 400);
      if (err instanceof Anthropic.APIError) throw new AIProviderError(`Claude API error ${err.status ?? ""}`.trim(), err.status, true);
      if (err instanceof Anthropic.APIConnectionError) throw new AIProviderError("Could not reach the Claude API.", undefined, true);
      throw err;
    }

    if (response.stop_reason === "refusal") {
      return { text: "", toolCalls: [], raw: response.content, stopReason: "refusal" };
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const toolCalls = response.content
      .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input }));

    return {
      text,
      toolCalls,
      raw: response.content,
      stopReason:
        response.stop_reason === "tool_use"
          ? "tool_calls"
          : response.stop_reason === "max_tokens"
            ? "max_tokens"
            : response.stop_reason === "end_turn"
              ? "end"
              : "other",
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
