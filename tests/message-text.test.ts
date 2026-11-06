/**
 * How an assistant reply is split into prose and lists.
 *
 * Replies that enumerate parts or line items must show every item. The model is
 * asked to separate a lead-in from its bullets with a blank line, but it does
 * not always, and a bullet run rendered as prose shows literal "- " instead of
 * a list. These pin the tolerant behaviour.
 */

import { describe, expect, it } from 'vitest';

import { splitBlock } from '@/components/my-day/MessageText';

describe('splitBlock', () => {
  it('lifts a bullet run out of a block that starts with a lead-in', () => {
    const { lead, bullets } = splitBlock(['You need these parts today:', '- Motion sensor', '- Keypad']);

    expect(lead).toEqual(['You need these parts today:']);
    expect(bullets).toEqual(['- Motion sensor', '- Keypad']);
  });

  it('keeps a pure bullet run as a list with no lead-in', () => {
    const { lead, bullets } = splitBlock(['- Motion sensor', '- Keypad']);

    expect(lead).toEqual([]);
    expect(bullets).toHaveLength(2);
  });

  it('keeps plain prose as prose', () => {
    const { lead, bullets } = splitBlock(['You have three appointments today.']);

    expect(lead).toHaveLength(1);
    expect(bullets).toEqual([]);
  });

  it('recognises numbered items too', () => {
    expect(splitBlock(['Parts:', '1. Sensor', '2. Keypad']).bullets).toEqual(['1. Sensor', '2. Keypad']);
  });

  it('leaves bullets interleaved with prose alone, so nothing is reordered', () => {
    const lines = ['- Sensor', 'That one is on back order.', '- Keypad'];
    const { lead, bullets } = splitBlock(lines);

    expect(lead).toEqual(lines);
    expect(bullets).toEqual([]);
  });

  it('never drops a line, whatever the shape', () => {
    for (const lines of [
      ['Parts:', '- A', '- B', '- C'],
      ['- A', '- B'],
      ['Just prose.'],
      ['- A', 'prose', '- B'],
    ]) {
      const { lead, bullets } = splitBlock(lines);
      expect(lead.length + bullets.length).toBe(lines.length);
    }
  });
});
