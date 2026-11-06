/**
 * Capability resolution from published schemas.
 *
 * These replace what used to be three hardcoded Apex class names. What matters
 * is that the right tool is picked out of a realistic discovery set with no
 * name matching, that the status buttons offered follow the org's own picklist,
 * and that an org missing a capability degrades instead of guessing.
 */

import { describe, expect, it } from 'vitest';

import {
  availableActions,
  completedValue,
  itemSchema,
  resolveCapabilities,
  statusEnum,
  statusValueFor,
  withheldFromModel,
} from '@/lib/copilot-capabilities';
import type { ApprovedTool } from '@/lib/tool-allowlist';

/** An Apex action as Hosted MCP publishes it: `{ inputs: [item] }`. */
function apexTool(
  name: string,
  properties: Record<string, unknown>,
  options: { mutating?: boolean; description?: string; required?: string[] } = {},
): ApprovedTool {
  return {
    name,
    description: options.description ?? `The ${name} action.`,
    mutating: options.mutating ?? false,
    inputSchema: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          items: { type: 'object', properties: properties as never, required: options.required },
        },
      },
    },
  };
}

const scheduleTool = apexTool(
  'FSTechAppointmentActionapex_FSTechAppointmentAction',
  { technicianName: { type: 'string' } },
  { description: 'Returns the scheduled appointments for a technician.', required: ['technicianName'] },
);

const statusTool = apexTool(
  'FSTechUpdateAppointmentStatusActionapex_FSTechUpdateAppointmentStatusAction',
  {
    appointmentNumber: { type: 'string' },
    status: { type: 'string', enum: ['On My Way', 'In Progress', 'Completed', 'Cannot Complete'] },
  },
  { mutating: true },
);

const closeTool = apexTool(
  'FSAppointmentCloseActionapex_FSAppointmentCloseAction',
  { appointmentNumber: { type: 'string' } },
  { mutating: true },
);

const unrelatedTool = apexTool(
  'FSUpsellProductActionapex_FSUpsellProductAction',
  { appointmentNumber: { type: 'string' } },
  { description: 'Suggests products to offer at an appointment.' },
);

/* ------------------------------------------------------------------ */

describe('schema reading', () => {
  it('sees through the Apex inputs wrapper', () => {
    const { wrapper, schema } = itemSchema(scheduleTool);

    expect(wrapper).toBe('inputs');
    expect(Object.keys(schema.properties ?? {})).toEqual(['technicianName']);
  });

  it('treats a flat schema as the item itself', () => {
    const flat: ApprovedTool = {
      name: 'plain',
      description: '',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    };

    expect(itemSchema(flat).wrapper).toBeNull();
  });

  it('reads the picklist off a status-like property', () => {
    expect(statusEnum(statusTool)).toEqual(['On My Way', 'In Progress', 'Completed', 'Cannot Complete']);
    expect(statusEnum(scheduleTool)).toBeNull();
  });

  it('ignores an empty enum rather than reporting an empty picklist', () => {
    const empty = apexTool('x', { status: { type: 'string', enum: [] } }, { mutating: true });
    expect(statusEnum(empty)).toBeNull();
  });
});

describe('resolveCapabilities', () => {
  const tools = [unrelatedTool, statusTool, scheduleTool, closeTool];

  it('picks each capability out of a realistic discovery set, by schema alone', () => {
    const capabilities = resolveCapabilities(tools);

    expect(capabilities.schedule?.name).toBe(scheduleTool.name);
    expect(capabilities.status?.tool.name).toBe(statusTool.name);
    expect(capabilities.close?.name).toBe(closeTool.name);
  });

  it('does not mistake an appointment-scoped tool for the schedule lookup', () => {
    // FSUpsellProductAction takes an appointment, so it asks about one job
    // rather than listing a technician's own.
    const capabilities = resolveCapabilities([unrelatedTool, scheduleTool]);
    expect(capabilities.schedule?.name).toBe(scheduleTool.name);
  });

  it('finds the schedule tool when its name says nothing about appointments', () => {
    const renamed = apexTool('AcmeWorkListapex_AcmeWorkList', { resourceName: { type: 'string' } });
    expect(resolveCapabilities([renamed]).schedule?.name).toBe(renamed.name);
  });

  it('reports no capability when nothing matches', () => {
    const capabilities = resolveCapabilities([unrelatedTool]);

    expect(capabilities.schedule).toBeUndefined();
    expect(capabilities.status).toBeUndefined();
    expect(capabilities.close).toBeUndefined();
    expect(availableActions(capabilities)).toEqual([]);
  });

  it('does not treat the status tool as the close tool as well', () => {
    const capabilities = resolveCapabilities([statusTool]);
    expect(capabilities.close).toBeUndefined();
  });
});

describe('availableActions', () => {
  it("offers only the actions the org's picklist can express", () => {
    const capabilities = resolveCapabilities([statusTool]);

    // The fixture's enum has no "Canceled" value.
    expect(availableActions(capabilities)).toEqual(['on_my_way', 'start', 'complete', 'cannot_complete']);
    expect(statusValueFor('on_my_way', capabilities)).toBe('On My Way');
    expect(statusValueFor('cancel', capabilities)).toBeNull();
  });

  it('matches the org wording rather than assuming ours', () => {
    const british = apexTool(
      'statusy',
      { appointmentNumber: { type: 'string' }, status: { type: 'string', enum: ['Dispatched', 'Arrived', 'Cancelled'] } },
      { mutating: true },
    );
    const capabilities = resolveCapabilities([british]);

    expect(statusValueFor('on_my_way', capabilities)).toBe('Dispatched');
    expect(statusValueFor('start', capabilities)).toBe('Arrived');
    expect(statusValueFor('cancel', capabilities)).toBe('Cancelled');
    expect(statusValueFor('complete', capabilities)).toBeNull();
  });

  it('falls back to its own vocabulary when a status takes free text', () => {
    const freeText = apexTool(
      'freetext',
      { appointmentNumber: { type: 'string' }, status: { type: 'string' } },
      { mutating: true },
    );
    const capabilities = resolveCapabilities([freeText]);

    expect(capabilities.status?.tool.name).toBe('freetext');
    expect(statusValueFor('complete', capabilities)).toBe(completedValue());
  });

  it('offers completion alone when only a close action exists', () => {
    const capabilities = resolveCapabilities([scheduleTool, closeTool]);

    expect(capabilities.status).toBeUndefined();
    expect(availableActions(capabilities)).toEqual(['complete']);
  });
});

describe('withheldFromModel', () => {
  const tools = [unrelatedTool, statusTool, scheduleTool, closeTool];
  const capabilities = resolveCapabilities(tools);

  it('withholds the status and close actions, so the model cannot skip a confirmation', () => {
    expect(withheldFromModel(statusTool, capabilities)).toBe(true);
    expect(withheldFromModel(closeTool, capabilities)).toBe(true);
  });

  it('still offers the read tools', () => {
    expect(withheldFromModel(scheduleTool, capabilities)).toBe(false);
    expect(withheldFromModel(unrelatedTool, capabilities)).toBe(false);
  });

  it('does not withhold everything just because the server marks reads as not read-only', () => {
    // Salesforce publishes readOnlyHint:false on every invocable Apex action,
    // read-only ones included, which is why this cannot key off `mutating`.
    const salesforceish = [scheduleTool, closeTool].map((tool) => ({
      ...tool,
      mutating: true,
      annotations: { readOnlyHint: false, destructiveHint: false },
    }));
    const resolved = resolveCapabilities(salesforceish);
    const offered = salesforceish.filter((tool) => !withheldFromModel(tool, resolved));

    expect(offered.map((tool) => tool.name)).toEqual([scheduleTool.name]);
  });

  it('withholds a tool the server explicitly calls destructive', () => {
    const destructive = { ...unrelatedTool, annotations: { destructiveHint: true } };
    expect(withheldFromModel(destructive, capabilities)).toBe(true);
  });
});
