/**
 * Works out what the connected Salesforce tools can do, from their published
 * schemas rather than their names.
 *
 * The Copilot needs to know three things: which tool lists a technician's
 * appointments, which one sets an appointment's status, and which one closes an
 * appointment outright. Matching those by Apex class name tied the app to one
 * org; a renamed class silently removed the feature. Instead each capability is
 * recognised by a signature in the tool's own input schema, so a new org, a new
 * class name or an extra MCP server needs no code change.
 *
 * `COPILOT_TOOL_SCHEDULE` / `_STATUS` / `_CLOSE` override the inference by name
 * substring, for an org whose schemas do not publish enough to infer from.
 *
 * Known limitation: a tool that takes *both* a technician and an appointment
 * identifier is not treated as the schedule lookup, because it is asking for one
 * appointment rather than listing a technician's own.
 */

import { config } from './config';
import type { ApprovedTool, JsonSchema } from './tool-allowlist';
import type { StatusAction } from '@/types/copilot';

/* ------------------------------------------------------------------ */
/* Schema reading                                                      */
/* ------------------------------------------------------------------ */

/** Apex actions take `{ inputs: [item] }`; anything else takes the item directly. */
export function itemSchema(tool: ApprovedTool): { wrapper: string | null; schema: JsonSchema } {
  const inputs = tool.inputSchema.properties?.inputs;
  if (inputs?.type === 'array' && inputs.items && typeof inputs.items === 'object') {
    return { wrapper: 'inputs', schema: inputs.items };
  }
  return { wrapper: null, schema: tool.inputSchema };
}

const STATUS_KEY = /status|state|stage/i;
const TECHNICIAN_KEY = /technician|owner|resource|assignee|user/i;
const APPOINTMENT_NUMBER_KEY = /(appointment|^sa).*(number|num|name)$|^appointment$/i;
const APPOINTMENT_ID_KEY = /(appointment|record|^sa).*id$|^id$/i;

function propertyNames(tool: ApprovedTool): string[] {
  return Object.keys(itemSchema(tool).schema.properties ?? {});
}

function hasKey(tool: ApprovedTool, pattern: RegExp): boolean {
  return propertyNames(tool).some((key) => pattern.test(key));
}

function takesAppointment(tool: ApprovedTool): boolean {
  return propertyNames(tool).some((key) => APPOINTMENT_NUMBER_KEY.test(key) || APPOINTMENT_ID_KEY.test(key));
}

/**
 * The status picklist a tool publishes, if any.
 *
 * An `enum` on a status-like property is the strongest available signal that a
 * tool sets status: it names the exact literals Salesforce will accept.
 */
export function statusEnum(tool: ApprovedTool): string[] | null {
  for (const [key, property] of Object.entries(itemSchema(tool).schema.properties ?? {})) {
    if (!STATUS_KEY.test(key) || !Array.isArray(property.enum)) continue;
    const values = property.enum.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (values.length > 0) return values;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                   */
/* ------------------------------------------------------------------ */

/**
 * How each action is spelled in a Salesforce status picklist. `match` finds the
 * org's own wording in a published enum; `fallback` is sent when a tool takes a
 * status but publishes no enum to choose from.
 */
const STATUS_VOCABULARY: Record<StatusAction, { match: RegExp; fallback: string }> = {
  on_my_way: { match: /on\s*my\s*way|en\s*route|travel|dispatched/i, fallback: 'On My Way' },
  start: { match: /in\s*progress|started|on\s*site|arrived/i, fallback: 'In Progress' },
  complete: { match: /^complete(d)?\b/i, fallback: 'Completed' },
  cannot_complete: { match: /cannot|unable|incomplete/i, fallback: 'Cannot Complete' },
  cancel: { match: /^cancel(l?ed)?\b/i, fallback: 'Canceled' },
};

const ALL_ACTIONS = Object.keys(STATUS_VOCABULARY) as StatusAction[];

/** Maps a published picklist onto the actions the widget offers. */
function mapStatusValues(values: string[] | null): Partial<Record<StatusAction, string>> {
  const mapped: Partial<Record<StatusAction, string>> = {};

  for (const action of ALL_ACTIONS) {
    if (!values) {
      // No enum published: the tool takes a free-text status, so send our own.
      mapped[action] = STATUS_VOCABULARY[action].fallback;
      continue;
    }
    const match = values.find((value) => STATUS_VOCABULARY[action].match.test(value));
    if (match) mapped[action] = match;
  }

  return mapped;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export interface ToolCapabilities {
  /** Lists the technician's appointments. */
  schedule?: ApprovedTool;
  /** Sets an appointment's status, with the literal to send for each action. */
  status?: { tool: ApprovedTool; values: Partial<Record<StatusAction, string>> };
  /** Completes an appointment without taking a status value. */
  close?: ApprovedTool;
}

function override(tools: ApprovedTool[], configured: string | undefined): ApprovedTool | undefined {
  if (!configured) return undefined;
  const needle = configured.toLowerCase();
  return tools.find((tool) => tool.name.toLowerCase().includes(needle));
}

/** Prefers a tool whose name or description is about appointments. */
function preferAppointmentWording(candidates: ApprovedTool[]): ApprovedTool | undefined {
  const wording = /appointment|schedule|visit|job|dispatch/i;
  return candidates.find((tool) => wording.test(tool.name) || wording.test(tool.description)) ?? candidates[0];
}

export function resolveCapabilities(tools: ApprovedTool[]): ToolCapabilities {
  const overrides = config.copilotTools;

  // A status setter publishes a status-like property. An enum on it is the
  // strong signal; a mutating tool with a status property is the weak one.
  const statusTool =
    override(tools, overrides.status) ??
    tools.find((tool) => statusEnum(tool) !== null) ??
    tools.find((tool) => tool.mutating === true && hasKey(tool, STATUS_KEY));

  // A close action acts on one appointment and takes no status at all.
  const closeTool =
    override(tools, overrides.close) ??
    tools.find(
      (tool) => tool !== statusTool && tool.mutating === true && takesAppointment(tool) && !hasKey(tool, STATUS_KEY),
    );

  // The schedule lookup is per technician: it takes who, not which appointment.
  const scheduleTool =
    override(tools, overrides.schedule) ??
    preferAppointmentWording(
      tools.filter(
        (tool) =>
          tool !== statusTool && tool !== closeTool && hasKey(tool, TECHNICIAN_KEY) && !takesAppointment(tool) && !hasKey(tool, STATUS_KEY),
      ),
    );

  return {
    ...(scheduleTool ? { schedule: scheduleTool } : {}),
    ...(statusTool ? { status: { tool: statusTool, values: mapStatusValues(statusEnum(statusTool)) } } : {}),
    ...(closeTool ? { close: closeTool } : {}),
  };
}

/**
 * Whether a tool must be kept away from Gemini.
 *
 * Status changes run deterministically from the card buttons, so the model
 * never gets the tools that perform them and cannot skip a confirmation.
 *
 * Deliberately *not* based on the discovered `mutating` flag: Salesforce
 * publishes `readOnlyHint: false` on every invocable Apex action, read-only ones
 * included, and the fallback name heuristic matches "apex" in every tool name.
 * Either would withhold the whole toolset and leave the Copilot unable to answer
 * anything. What is withheld is what resolved as a status capability, plus
 * anything the server explicitly flags as destructive.
 */
export function withheldFromModel(tool: ApprovedTool, capabilities: ToolCapabilities): boolean {
  if (tool.name === capabilities.status?.tool.name) return true;
  if (tool.name === capabilities.close?.name) return true;
  return tool.annotations?.destructiveHint === true;
}

/** Which status actions the resolved tools can actually perform. */
export function availableActions(capabilities: ToolCapabilities): StatusAction[] {
  return ALL_ACTIONS.filter(
    (action) => capabilities.status?.values[action] !== undefined || (action === 'complete' && capabilities.close),
  );
}

/** The status literal to send for an action, or null when it cannot be expressed. */
export function statusValueFor(action: StatusAction, capabilities: ToolCapabilities): string | null {
  return capabilities.status?.values[action] ?? null;
}

/** The fallback literal a close action implies. */
export function completedValue(): string {
  return STATUS_VOCABULARY.complete.fallback;
}
