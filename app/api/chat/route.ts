/**
 * POST /api/chat
 *
 * Streams the assistant turn back as SSE over the POST response. Every event
 * reflects work the backend genuinely performed.
 */

import { runAssistant, GeminiConfigError } from '@/lib/gemini';
import { log } from '@/lib/logger';
import { acquire, sweep } from '@/lib/rate-limit';
import { SalesforceAuthError } from '@/lib/salesforce-auth';
import { McpError } from '@/lib/salesforce-mcp';
import { config } from '@/lib/config';
import { encodeEvent } from '@/lib/stream';
import type { ChatRequestBody, ServerEvent } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Tells any intermediary proxy not to buffer the stream.
  'X-Accel-Buffering': 'no',
} as const;

/** A failure before the stream opens is still delivered as SSE, so one client path handles both. */
function errorStream(message: string, status = 200): Response {
  const body = encodeEvent({ type: 'error', message });
  return new Response(body, { status, headers: SSE_HEADERS });
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
}

function parseBody(raw: unknown): { ok: true; body: ChatRequestBody } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The request body must be a JSON object.' };

  const { message, history } = raw as Partial<ChatRequestBody>;

  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, reason: 'Please enter a question.' };
  }
  if (message.length > config.limits.maxMessageChars) {
    return { ok: false, reason: `Messages are limited to ${config.limits.maxMessageChars} characters.` };
  }

  const turns: ChatRequestBody['history'] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return { ok: false, reason: 'Conversation history must be an array.' };

    for (const turn of history.slice(-config.limits.maxHistoryTurns)) {
      if (!turn || typeof turn !== 'object') continue;
      const { role, content } = turn as { role?: unknown; content?: unknown };
      if (role !== 'user' && role !== 'assistant') continue;
      if (typeof content !== 'string' || content.trim().length === 0) continue;
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
    return errorStream('The request body was not valid JSON.');
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) return errorStream(parsed.reason);

  const gate = acquire(clientKey(request));
  if (!gate.ok) return errorStream(gate.reason);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ServerEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(encodeEvent(event)));
      };

      // The browser navigating away should stop the backend work too.
      const onAbort = () => {
        closed = true;
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        for await (const event of runAssistant(parsed.body)) {
          if (closed || request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        send({ type: 'error', message: toUserMessage(error) });
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        gate.release();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // The stream can already be closed if the client disconnected.
          }
        }
      }
    },

    cancel() {
      gate.release();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/** Maps internal failures to something a sales rep can act on. */
function toUserMessage(error: unknown): string {
  if (error instanceof SalesforceAuthError) {
    log.error('chat', 'Salesforce auth failure', { code: error.code });
    switch (error.code) {
      case 'not_configured':
        return 'Salesforce is not configured yet. Add the External Client App credentials to .env.local.';
      case 'not_authorized':
        return 'Salesforce authorization has not been completed, or it has expired. An administrator needs to re-run the one-time setup authorization.';
      default:
        return error.message;
    }
  }

  if (error instanceof McpError || error instanceof GeminiConfigError) {
    log.error('chat', 'Assistant turn failed', { message: error.message });
    return error.message;
  }

  log.error('chat', 'Unexpected failure', { message: error instanceof Error ? error.message : String(error) });
  return 'Something went wrong while answering. Please try again.';
}
