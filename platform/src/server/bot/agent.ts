import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { createProvider } from "../ai/service";
import type { AIMessage } from "../ai/types";
import { AIProviderError } from "../ai/types";
import { getOpenCart, viewCart } from "../commerce/cart";
import { log } from "../logger";
import type { OutboundMessage } from "../whatsapp/messaging";
import { buildSystemPrompt } from "./prompt";
import { executeTool, toolDefinitions, type ToolRuntime } from "./tools";

const HISTORY_LIMIT = 24;
const MAX_STEPS = 8;

export type AgentResult =
  | { ok: true; replies: OutboundMessage[]; toolsUsed: string[] }
  | { ok: false; error: string; toolsUsed: string[] };

/** Rebuilds recent conversation turns from stored messages (the database is the memory). */
async function history(rt: ToolRuntime): Promise<AIMessage[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, rt.conversation.id), eq(messages.businessId, rt.businessId)))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);
  const out: AIMessage[] = [];
  for (const row of rows.reverse()) {
    if (row.direction === "inbound") {
      let text = row.content;
      if (row.type === "interactive" || row.type === "button") text = `[Tapped: ${row.content}]`;
      else if (row.type === "location" && row.payload.location)
        text = `[Shared location: ${[row.payload.location.name, row.payload.location.address].filter(Boolean).join(", ") || `${row.payload.location.latitude},${row.payload.location.longitude}`}]`;
      else if (row.type !== "text") text = `[Customer sent ${row.type === "image" ? "an image" : `a ${row.type}`}]${row.content ? ` ${row.content}` : ""}`;
      out.push({ role: "user", content: text || "[empty message]" });
    } else if (row.status !== "failed") {
      const prefix = row.sender === "agent" ? "(A team member wrote:) " : "";
      out.push({ role: "assistant", content: `${prefix}${row.content}` });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/**
 * Provider-neutral tool loop. The model can only act through validated tools;
 * tools that produce a customer-facing message end the turn deterministically.
 */
export async function runAgent(rt: ToolRuntime): Promise<AgentResult> {
  const toolsUsed: string[] = [];
  if (!rt.bot.aiConfig) return { ok: false, error: "No AI API key is configured.", toolsUsed };
  let provider;
  try {
    provider = createProvider(rt.bot.aiConfig);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "AI is not configured.", toolsUsed };
  }

  const cart = await getOpenCart(rt.businessId, rt.conversation.id);
  const system = buildSystemPrompt(rt, cart ? await viewCart(rt.businessId, cart) : null);
  const conversation = await history(rt);
  const tools = toolDefinitions(rt);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const started = Date.now();
    let completion;
    try {
      log.info("ai.request", { businessId: rt.businessId, conversationId: rt.conversation.id, provider: provider.name, model: provider.model, step });
      completion = await provider.complete({ system, messages: conversation, tools, maxTokens: 16000 });
      log.info("ai.response", {
        businessId: rt.businessId,
        conversationId: rt.conversation.id,
        step,
        ms: Date.now() - started,
        stop: completion.stopReason,
        tools: completion.toolCalls.map((c) => c.name),
        usage: completion.usage,
      });
    } catch (err) {
      const message = err instanceof AIProviderError ? err.message : "The AI request failed.";
      log.error("ai.failed", { businessId: rt.businessId, conversationId: rt.conversation.id, err });
      return { ok: false, error: message, toolsUsed };
    }

    if (completion.stopReason === "refusal") return { ok: false, error: "The AI declined to answer.", toolsUsed };

    if (!completion.toolCalls.length) {
      const text = completion.text.trim();
      if (!text) return { ok: false, error: "The AI returned an empty reply.", toolsUsed };
      return { ok: true, replies: [{ kind: "text", text }], toolsUsed };
    }

    conversation.push({
      role: "assistant",
      content: completion.text,
      toolCalls: completion.toolCalls,
      raw: completion.raw,
      provider: provider.name,
    });

    const terminal: OutboundMessage[] = [];
    for (const call of completion.toolCalls) {
      toolsUsed.push(call.name);
      const outcome = await executeTool(rt, call.name, call.arguments);
      conversation.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(outcome.data),
        isError: outcome.isError,
      });
      if (outcome.terminal) terminal.push(...outcome.terminal);
    }
    if (terminal.length) return { ok: true, replies: terminal, toolsUsed };
  }
  return { ok: false, error: "The AI did not finish within the step limit.", toolsUsed };
}
