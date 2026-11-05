import { describe, expect, it } from 'vitest';

import { countRecords, parseToolResult } from '@/lib/salesforce-mcp';

/** Shape of a successful MCP tool result carrying JSON inside a text block. */
function textResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

describe('parseToolResult', () => {
  it('parses JSON returned inside a text block', () => {
    const parsed = parseToolResult(
      textResult({ totalSize: 2, records: [{ Name: 'Acme' }, { Name: 'Globex' }] }),
    );

    expect(parsed.isError).toBe(false);
    expect(parsed.recordCount).toBe(2);
    expect(parsed.text).toContain('Acme');
  });

  it('prefers structuredContent over the text block', () => {
    const parsed = parseToolResult({
      content: [{ type: 'text', text: '{"records":[{"Name":"FromText"}]}' }],
      structuredContent: { records: [{ Name: 'FromStructured' }] },
    });

    expect(parsed.text).toContain('FromStructured');
    expect(parsed.text).not.toContain('FromText');
  });

  it('keeps plain prose when the text block is not JSON', () => {
    const parsed = parseToolResult({ content: [{ type: 'text', text: 'No records matched the query.' }] });

    expect(parsed.text).toBe('No records matched the query.');
    expect(parsed.recordCount).toBeUndefined();
  });

  it('joins multiple text blocks', () => {
    const parsed = parseToolResult({
      content: [
        { type: 'text', text: 'first part' },
        { type: 'text', text: 'second part' },
      ],
    });

    expect(parsed.text).toContain('first part');
    expect(parsed.text).toContain('second part');
  });

  it('ignores content blocks that are not text', () => {
    const parsed = parseToolResult({
      content: [
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'kept' },
      ],
    });

    expect(parsed.text).toBe('kept');
  });

  it('flags an error result', () => {
    const parsed = parseToolResult({ content: [{ type: 'text', text: 'INVALID_FIELD' }], isError: true });

    expect(parsed.isError).toBe(true);
    expect(parsed.text).toContain('INVALID_FIELD');
  });

  it('reports a readable message for an error result with no detail', () => {
    const parsed = parseToolResult({ content: [], isError: true });

    expect(parsed.isError).toBe(true);
    expect(parsed.text).toMatch(/error with no detail/i);
  });

  it('reports empty content rather than returning a blank string', () => {
    expect(parseToolResult({ content: [] }).text).toMatch(/No content returned/i);
  });

  it('survives a result that is null or malformed', () => {
    expect(parseToolResult(null).text).toMatch(/No content returned/i);
    expect(parseToolResult(undefined).isError).toBe(false);
  });

  it('truncates an oversized payload and says so', () => {
    const records = Array.from({ length: 4000 }, (_, index) => ({ Name: `Account ${index}`, Industry: 'Technology' }));
    const parsed = parseToolResult(textResult({ records }));

    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toMatch(/truncated/);
    // The cap exists to bound tokens sent to Gemini, so it must actually bind.
    expect(parsed.text.length).toBeLessThan(JSON.stringify({ records }).length);
  });

  it('does not flag a small payload as truncated', () => {
    expect(parseToolResult(textResult({ records: [{ Name: 'Acme' }] })).truncated).toBe(false);
  });
});

describe('countRecords', () => {
  it('counts a bare array', () => {
    expect(countRecords([1, 2, 3])).toBe(3);
  });

  it('counts a SOQL-style records array', () => {
    expect(countRecords({ totalSize: 7, records: [{}, {}] })).toBe(2);
  });

  it('counts a SOSL-style searchRecords array', () => {
    expect(countRecords({ searchRecords: [{}, {}, {}] })).toBe(3);
  });

  it('counts recently viewed records', () => {
    expect(countRecords({ recentItems: [{}] })).toBe(1);
  });

  it('finds an array nested one level down', () => {
    expect(countRecords({ result: { records: [{}, {}] } })).toBe(2);
  });

  it('falls back to totalSize only when there is no array to measure', () => {
    expect(countRecords({ totalSize: 42 })).toBe(42);
  });

  it('reports zero for an empty result set rather than nothing', () => {
    expect(countRecords({ totalSize: 0, records: [] })).toBe(0);
  });

  it('returns undefined when no count can be established', () => {
    expect(countRecords({ Name: 'Acme', Industry: 'Technology' })).toBeUndefined();
    expect(countRecords('some text')).toBeUndefined();
    expect(countRecords(null)).toBeUndefined();
  });
});
