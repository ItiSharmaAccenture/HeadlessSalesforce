import { describe, expect, it } from 'vitest';

import { copilotInstruction, digestUpsell, readUpsellProducts } from '@/lib/copilot';
import { toTechnician } from '@/lib/technician';

/** Shape returned by the org's upsell action through Hosted MCP (trimmed to three products). */
const response = {
  content: [
    {
      actionName: 'FSUpsellProductAction',
      isSuccess: true,
      errors: null,
      outputValues: {
        availableCategories: ['Bathroom', 'Living Room', 'Bed Room', 'Lawn'],
        matchedCategory: null,
        message: 'Found 3 recommended product(s) for all categories.',
        success: true,
        products: [
          {
            name: 'Door/Window Sensor',
            productId: null,
            suggestedCategories: ['Living Room', 'Bed Room'],
            recommendedFor: 'Living rooms and bedrooms. Recommended for entry points that need monitoring.',
            description: 'A compact sensor that detects when a door or window is opened or closed.',
          },
          {
            name: 'Google Nest Cam Outdoor (wired, 2nd gen)',
            productId: null,
            suggestedCategories: ['Lawn'],
            recommendedFor: 'A weatherproof outdoor camera with continuous power.',
            description: 'A weatherproof outdoor camera with continuous power.',
          },
          { name: 'Bare Product', productId: null, suggestedCategories: ['Lawn'] },
        ],
      },
    },
  ],
};

describe('upsell recommendations', () => {
  it('reads both new fields from the action output', () => {
    const result = readUpsellProducts(response);
    expect(result?.products).toHaveLength(3);
    expect(result?.products[0]).toEqual({
      name: 'Door/Window Sensor',
      rooms: ['Living Room', 'Bed Room'],
      recommendedFor: 'Living rooms and bedrooms. Recommended for entry points that need monitoring.',
      description: 'A compact sensor that detects when a door or window is opened or closed.',
    });
    expect(result?.availableCategories).toContain('Lawn');
  });

  it('passes recommended-for and description to the model for every product', () => {
    const digest = digestUpsell(readUpsellProducts(response)!);
    expect(digest).toContain('Recommended for: Living rooms and bedrooms.');
    expect(digest).toContain('Description: A compact sensor');
    expect(digest).toContain('Room filter: none (all rooms)');
  });

  it('flags a recommended-for that only repeats the description, and missing fields', () => {
    const digest = digestUpsell(readUpsellProducts(response)!);
    expect(digest).toContain('Salesforce repeats the description here');
    expect(digest).toMatch(/Bare Product\n\s+Rooms: Lawn\n\s+Recommended for: not provided\n\s+Description: not provided/);
  });

  it('ignores results that are not product recommendations', () => {
    expect(readUpsellProducts({ content: [{ outputValues: { appointmentsJson: '[]' } }] })).toBeNull();
    expect(readUpsellProducts({ content: [{ outputValues: { products: [{ sku: 'X' }] } }] })).toBeNull();
  });

  it('tells the model to justify each recommendation from the product data only', () => {
    const instruction = copilotInstruction(toTechnician('Sayantan Pal', 'TCH-7842'), {}, []);
    expect(instruction).toContain('Reason:');
    expect(instruction).toContain('"Recommended for" and "Description"');
    expect(instruction).toContain('Never add features, prices');
  });
});
