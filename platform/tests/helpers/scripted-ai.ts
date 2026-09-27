import type { AICompletion, AIRequest } from "@/server/ai/types";

/**
 * A deterministic stand-in for the LLM. It chooses tools the way a model would
 * for the acceptance scenario, so tests exercise the real tool layer, order
 * state machine and messaging without calling a paid API.
 */
let seq = 0;
const call = (name: string, args: unknown): AICompletion => ({
  text: "",
  toolCalls: [{ id: `call_${++seq}`, name, arguments: args }],
  raw: null,
  stopReason: "tool_calls",
});
const say = (text: string): AICompletion => ({ text, toolCalls: [], raw: null, stopReason: "end" });

type Product = { productId: string; name: string; price: string; available: boolean };

export function scriptedAI(request: AIRequest): AICompletion {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  const lastUser = ([...messages].reverse().find((m) => m.role === "user")?.content ?? "").toLowerCase();

  if (last.role === "tool") {
    const data = JSON.parse(last.content);
    if (last.isError) return say(`Sorry — ${data.error ?? "something went wrong"}.`);
    switch (last.name) {
      case "searchProducts": {
        const products = (data.products as Product[]).filter((p) => p.available);
        if (/\bwant\b/.test(lastUser) && products[0]) {
          const quantity = Number(lastUser.match(/\b(\d+)\b/)?.[1] ?? 1);
          const size = lastUser.match(/\b(small|medium|large|xl|s|m|l)\b(?!\w)/)?.[1];
          return call("createDraftOrder", { items: [{ productId: products[0].productId, quantity, options: size ? { Size: size } : {} }] });
        }
        if (!products.length) return say("Sorry, we don't have that right now.");
        return say(`Yes! We have these available:\n${products.map((p, i) => `${i + 1}. ${p.name} — ${p.price}`).join("\n")}\n\nWould you like to order one?`);
      }
      case "createDraftOrder":
      case "updateDraftOrder": {
        const draft = data.draftOrder;
        if (draft.readyForReview) return call("presentOrderReview", {});
        const missing = draft.missingRequiredFields.map((f: { label: string }) => f.label);
        return say(`Great! I've added that. Please share your ${missing.join(", ")}.`);
      }
      case "getCustomerOrders": {
        const order = data.orders[0];
        if (!order) return say("I couldn't find any orders for you.");
        return say(`Your latest order is:\n\n#${order.orderNumber}\n\nStatus:\n${order.status}${order.tracking ? `\n\nTracking:\n${order.tracking}` : ""}`);
      }
      default:
        return say("Done.");
    }
  }

  if (/where is my order/.test(lastUser)) return call("getCustomerOrders", {});
  if (/speak to|manager|human/.test(lastUser)) return call("requestHumanSupport", { reason: "Customer asked to talk to a person" });
  if (/cash on delivery/.test(lastUser)) return call("updateDraftOrder", { fields: { payment_method: "cash on delivery" } });
  if (/^confirm/.test(lastUser)) return call("createOrder", {});
  if (/colombo/.test(lastUser)) {
    const [name, address, city] = lastUser.split(",").map((part) => part.trim());
    return call("updateDraftOrder", { fields: { name: titleCase(name), address: titleCase(address), city: titleCase(city) } });
  }
  if (/do you have|\bwant\b|looking for/.test(lastUser)) return call("searchProducts", { query: lastUser });
  return say("How can I help you today?");
}

function titleCase(value = "") {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
