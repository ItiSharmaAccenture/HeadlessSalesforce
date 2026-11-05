import { describe, expect, it } from 'vitest';

import { createEventParser, encodeEvent } from '@/lib/stream';
import type { ServerEvent } from '@/types/chat';

const sample: ServerEvent = {
  type: 'tool_started',
  key: 's1',
  tool: 'soqlQuery',
  message: 'Calling Salesforce MCP...',
};

describe('encodeEvent', () => {
  it('writes one SSE data frame terminated by a blank line', () => {
    expect(encodeEvent(sample)).toBe(`data: ${JSON.stringify(sample)}\n\n`);
  });

  it('keeps a multi-line answer on a single data line, so framing stays intact', () => {
    const encoded = encodeEvent({ type: 'answer_delta', text: 'line one\nline two' });

    expect(encoded.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
    expect(encoded.endsWith('\n\n')).toBe(true);
  });
});

describe('createEventParser', () => {
  it('parses several events from one chunk', () => {
    const parser = createEventParser();
    const events = parser.push(
      encodeEvent({ type: 'answer_delta', text: 'a' }) + encodeEvent({ type: 'completed', message: 'done' }),
    );

    expect(events.map((event) => event.type)).toEqual(['answer_delta', 'completed']);
  });

  it('buffers an event split across chunk boundaries', () => {
    const parser = createEventParser();
    const frame = encodeEvent(sample);

    expect(parser.push(frame.slice(0, 12))).toEqual([]);
    expect(parser.push(frame.slice(12, 30))).toEqual([]);
    expect(parser.push(frame.slice(30))).toEqual([sample]);
  });

  it('reassembles a frame delivered one character at a time', () => {
    const parser = createEventParser();
    const frame = encodeEvent(sample);

    const collected = [...frame].flatMap((char) => parser.push(char));
    expect(collected).toEqual([sample]);
  });

  it('accepts CRLF framing from an intermediary proxy', () => {
    const parser = createEventParser();
    expect(parser.push(`data: ${JSON.stringify(sample)}\r\n\r\n`)).toEqual([sample]);
  });

  it('concatenates multiple data lines within one frame, per the SSE spec', () => {
    const parser = createEventParser();
    const payload = JSON.stringify({ type: 'answer_delta', text: 'hello' });
    // Split between JSON tokens: the spec joins data lines with a newline, which
    // is insignificant whitespace there but would corrupt a split string literal.
    const split = payload.indexOf(',') + 1;
    const events = parser.push(`data: ${payload.slice(0, split)}\ndata: ${payload.slice(split)}\n\n`);

    expect(events).toEqual([{ type: 'answer_delta', text: 'hello' }]);
  });

  it('skips a malformed frame without tearing down the stream', () => {
    const parser = createEventParser();
    const events = parser.push(`data: {not json\n\n${encodeEvent(sample)}`);

    expect(events).toEqual([sample]);
  });

  it('ignores comment and retry lines', () => {
    const parser = createEventParser();
    expect(parser.push(': keep-alive\n\nretry: 1000\n\n')).toEqual([]);
  });

  it('flushes a trailing event that arrived without its blank line', () => {
    const parser = createEventParser();

    expect(parser.push(`data: ${JSON.stringify(sample)}`)).toEqual([]);
    expect(parser.end()).toEqual([sample]);
  });

  it('returns nothing from end() when the buffer is already clean', () => {
    const parser = createEventParser();
    parser.push(encodeEvent(sample));
    expect(parser.end()).toEqual([]);
  });

  it('round-trips every event type in the contract', () => {
    const events: ServerEvent[] = [
      { type: 'status', stage: 'request_received', key: 's1', message: 'Understanding...', status: 'running' },
      { type: 'tool_selected', key: 's2', tool: 'soqlQuery', message: 'Selected tool: soqlQuery' },
      { type: 'tool_started', key: 's2', tool: 'soqlQuery', message: 'Calling...' },
      {
        type: 'tool_completed',
        key: 's2',
        tool: 'soqlQuery',
        durationMs: 420,
        success: true,
        recordCount: 5,
        message: 'MCP response received (5 records)',
      },
      { type: 'tool_failed', key: 's3', tool: 'find', durationMs: 11, success: false, message: 'rejected' },
      { type: 'answer_delta', text: '| a | b |\n| --- | --- |' },
      { type: 'answer_reset' },
      { type: 'completed', message: 'Response ready' },
      { type: 'error', message: 'boom' },
    ];

    const parser = createEventParser();
    const decoded = events.flatMap((event) => parser.push(encodeEvent(event)));

    expect(decoded).toEqual(events);
  });
});
