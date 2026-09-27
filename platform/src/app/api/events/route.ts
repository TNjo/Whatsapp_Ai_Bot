import { getAuth } from "@/server/auth";
import { subscribe } from "@/server/events";

/** Server-Sent Events stream of the signed-in business's real-time events. */
export async function GET(request: Request) {
  const auth = await getAuth();
  if (!auth) return new Response("Unauthorized", { status: 401 });
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\n\n`);
      const unsubscribe = subscribe(auth.business.id, (event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const ping = setInterval(() => send(`: ping\n\n`), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
