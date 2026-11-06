/**
 * ADT Copilot for /my-day.
 *
 * GET  — which appointment status changes the connected Salesforce tools support.
 * POST — one chat turn, streamed back as SSE (`CopilotEvent`).
 *
 * Salesforce credentials and tokens stay on the server; the browser only ever
 * sees appointment data and messages.
 */

import { config } from '@/lib/config';
import { describeFailure, getCapabilities, runCopilotTurn } from '@/lib/copilot';
import { acquire, sweep } from '@/lib/rate-limit';
import { encodeEvent } from '@/lib/stream';
import type { CopilotChatRequest, CopilotEvent } from '@/types/copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export async function GET(): Promise<Response> {
  try {
    return Response.json(await getCapabilities());
  } catch (error) {
    const failure = describeFailure(error);
    return Response.json({ error: failure.message, retryable: failure.retryable }, { status: failure.status });
  }
}

function errorStream(message: string, retryable: boolean): Response {
  return new Response(encodeEvent<CopilotEvent>({ type: 'error', message, retryable }), { headers: SSE_HEADERS });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
}

function parseBody(raw: unknown): { ok: true; body: CopilotChatRequest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The request body must be a JSON object.' };

  const { message, history } = raw as Partial<CopilotChatRequest>;
  if (typeof message !== 'string' || message.trim().length === 0) return { ok: false, reason: 'Please type a message.' };
  if (message.length > config.limits.maxMessageChars) {
    return { ok: false, reason: `Messages are limited to ${config.limits.maxMessageChars} characters.` };
  }

  const turns: NonNullable<CopilotChatRequest['history']> = [];
  if (Array.isArray(history)) {
    for (const turn of history.slice(-config.limits.maxHistoryTurns)) {
      const { role, content } = (turn ?? {}) as { role?: unknown; content?: unknown };
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) continue;
      turns.push({ role, content: content.slice(0, config.limits.maxMessageChars) });
    }
  }

  return { ok: true, body: { message: message.trim(), history: turns } };
}

export async function POST(request: Request): Promise<Response> {
  sweep();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorStream('The request body was not valid JSON.', false);
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) return errorStream(parsed.reason, false);

  const gate = acquire(clientKey(request));
  if (!gate.ok) return errorStream(gate.reason, true);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: CopilotEvent) => {
        if (!closed) controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      const onAbort = () => {
        closed = true;
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        for await (const event of runCopilotTurn(parsed.body)) {
          if (closed || request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        const failure = describeFailure(error);
        send({ type: 'error', message: failure.message, retryable: failure.retryable });
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        gate.release();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect.
          }
        }
      }
    },

    cancel() {
      gate.release();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
