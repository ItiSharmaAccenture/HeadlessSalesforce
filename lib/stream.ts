/**
 * SSE framing shared by the backend writer and the browser reader.
 *
 * This module is imported from both server and client code, so it must stay
 * free of server-only imports and Node built-ins.
 */

import type { ServerEvent } from '@/types/chat';

/** Serialises one application event as a single SSE `data:` frame. */
export function encodeEvent<T = ServerEvent>(event: T): string {
  // JSON.stringify never emits a raw newline, so one data line per event is safe.
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Incremental SSE parser.
 *
 * Network chunks split anywhere, including mid-event and mid-UTF-8-sequence, so
 * the caller feeds raw text in and gets back only the events that are complete.
 */
export function createEventParser<T = ServerEvent>() {
  let buffer = '';

  return {
    /** Feed a decoded chunk; returns every event that completed with it. */
    push(chunk: string): T[] {
      buffer += chunk;
      const events: T[] = [];

      // Events are separated by a blank line. Tolerate CRLF from proxies.
      let separator = findSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);

        const parsed = parseFrame<T>(frame);
        if (parsed) events.push(parsed);

        separator = findSeparator(buffer);
      }

      return events;
    },

    /** Flush a trailing event that arrived without its final blank line. */
    end(): T[] {
      const remainder = buffer.trim();
      buffer = '';
      if (!remainder) return [];
      const parsed = parseFrame<T>(remainder);
      return parsed ? [parsed] : [];
    },
  };
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame<T>(frame: string): T | null {
  // Concatenate every `data:` line of the frame, per the SSE specification.
  const payload = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');

  if (!payload) return null;

  try {
    return JSON.parse(payload) as T;
  } catch {
    // A malformed frame should not tear down an otherwise healthy stream.
    return null;
  }
}
