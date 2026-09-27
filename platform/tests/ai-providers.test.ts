import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeProvider } from "@/server/ai/claude";
import { OpenAICompatibleProvider } from "@/server/ai/openai-compatible";
import type { AIMessage, ToolDefinition } from "@/server/ai/types";

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
let server: http.Server;
let baseUrl = "";
const seen: Seen[] = [];
const replies: unknown[] = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(replies.shift()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const tools: ToolDefinition[] = [
  { name: "searchProducts", description: "Search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

describe("Claude adapter", () => {
  it("sends tools, replays tool_use blocks and groups tool results", async () => {
    const provider = new ClaudeProvider("sk-ant-test", "claude-opus-5", baseUrl);
    replies.push({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "searchProducts", input: { query: "black shirt" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const first = await provider.complete({ system: "sys", messages: [{ role: "user", content: "black shirts?" }], tools });
    expect(first.stopReason).toBe("tool_calls");
    expect(first.toolCalls).toEqual([{ id: "toolu_1", name: "searchProducts", arguments: { query: "black shirt" } }]);

    const request = seen.at(-1)!;
    expect(request.path).toContain("/v1/messages");
    expect(request.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(request.body).toMatchObject({ model: "claude-opus-5", system: "sys", fallbacks: "default" });
    expect(request.body).not.toHaveProperty("temperature");
    expect((request.body.tools as { name: string; input_schema: unknown }[])[0]).toMatchObject({ name: "searchProducts", input_schema: tools[0].parameters });

    replies.push({
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "We have the Classic Black T-Shirt." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 8 },
    });
    const history: AIMessage[] = [
      { role: "user", content: "black shirts?" },
      { role: "assistant", content: "", toolCalls: first.toolCalls, raw: first.raw, provider: "claude" },
      { role: "tool", toolCallId: "toolu_1", name: "searchProducts", content: '{"products":[]}' },
    ];
    const second = await provider.complete({ system: "sys", messages: history, tools });
    expect(second).toMatchObject({ text: "We have the Classic Black T-Shirt.", stopReason: "end" });
    const sent = seen.at(-1)!.body.messages as { role: string; content: unknown }[];
    expect(sent[1]).toEqual({ role: "assistant", content: first.raw }); // thinking + tool_use replayed unchanged
    expect(sent[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"products":[]}' }] });
  });
});

describe("OpenAI-compatible adapter", () => {
  it("speaks the chat.completions tool-calling format", async () => {
    const provider = new OpenAICompatibleProvider("groq", "openai/gpt-oss-120b", "gsk_test", baseUrl);
    replies.push({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "searchProducts", arguments: '{"query":"hoodie"}' } }] },
        },
      ],
    });
    const result = await provider.complete({
      system: "sys",
      messages: [
        { role: "user", content: "hoodies?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "searchProducts", arguments: { query: "x" } }] },
        { role: "tool", toolCallId: "c0", name: "searchProducts", content: "{}" },
      ],
      tools,
    });
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "searchProducts", arguments: { query: "hoodie" } }]);
    const request = seen.at(-1)!;
    expect(request.path).toBe("/chat/completions");
    expect(request.headers.authorization).toBe("Bearer gsk_test");
    const body = request.body as { messages: Record<string, unknown>[]; tools: unknown[] };
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "c0", type: "function", function: { name: "searchProducts", arguments: '{"query":"x"}' } }] });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c0", content: "{}" });
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "searchProducts" } });
  });
});
