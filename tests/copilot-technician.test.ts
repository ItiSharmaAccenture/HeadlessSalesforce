/**
 * Per-technician isolation, with Salesforce mocked.
 *
 * The Copilot proves an appointment belongs to the caller by finding it in the
 * set the schedule action returned for them. That set is remembered across
 * requests so an appointment stays reachable after it leaves the Scheduled
 * list — which means the memory has to be keyed per technician, or one
 * technician could open another's job.
 *
 * Also checks that the technician reaching Salesforce is the signed-in one, and
 * that the argument is built from the tool's published schema rather than a
 * hardcoded parameter name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toTechnician } from '@/lib/technician';

const listTools = vi.fn();
const callTool = vi.fn();
const closeSession = vi.fn();
const openMcpSession = vi.fn();

vi.mock('@/lib/salesforce-mcp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salesforce-mcp')>('@/lib/salesforce-mcp');
  return { ...actual, openMcpSession };
});

const { getAppointmentDetail, CopilotError } = await import('@/lib/copilot');

/** The schedule action, published the way Hosted MCP publishes Apex actions. */
const scheduleTool = {
  name: 'FSTechAppointmentActionapex_FSTechAppointmentAction',
  description: 'Returns the scheduled appointments for a technician.',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      inputs: {
        type: 'array',
        items: { type: 'object', properties: { technicianName: { type: 'string' } }, required: ['technicianName'] },
      },
    },
  },
};

function appointmentsFor(technicianName: string, numbers: string[]) {
  return {
    data: {
      content: [
        {
          isSuccess: true,
          errors: null,
          outputValues: {
            success: true,
            technicianName,
            timeZone: 'America/Chicago',
            appointmentsJson: JSON.stringify(
              numbers.map((appointmentNumber) => ({ appointmentNumber, status: 'Scheduled' })),
            ),
          },
        },
      ],
    },
    text: '',
    isError: false,
    truncated: false,
  };
}

const ada = toTechnician('Ada Lovelace', 'TCH-0001');
const grace = toTechnician('Grace Hopper', 'TCH-0002');

/** Each technician sees only their own appointment. */
function routeByTechnician() {
  callTool.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const inputs = args.inputs as { technicianName?: string }[];
    const who = inputs?.[0]?.technicianName;
    if (who === ada.fullName) return appointmentsFor(ada.fullName, ['SA-0164']);
    if (who === grace.fullName) return appointmentsFor(grace.fullName, ['SA-0900']);
    return appointmentsFor(String(who), []);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listTools.mockResolvedValue({
    approved: [scheduleTool],
    rejected: [],
    discoveredCount: 1,
    servers: [{ id: 'TechnicianAppointments', connected: true, toolCount: 1 }],
  });
  openMcpSession.mockResolvedValue({ listTools, callTool, close: closeSession });
  closeSession.mockResolvedValue(undefined);
  routeByTechnician();
});

describe('the technician sent to Salesforce', () => {
  it('is the signed-in one, placed under the key the schema publishes', async () => {
    await getAppointmentDetail(ada, 'SA-0164');

    expect(callTool).toHaveBeenCalledWith(scheduleTool.name, { inputs: [{ technicianName: 'Ada Lovelace' }] });
  });

  it('changes with the signed-in technician', async () => {
    await getAppointmentDetail(grace, 'SA-0900');

    expect(callTool).toHaveBeenCalledWith(scheduleTool.name, { inputs: [{ technicianName: 'Grace Hopper' }] });
  });
});

describe('per-technician isolation', () => {
  it('lets a technician open their own appointment', async () => {
    const detail = await getAppointmentDetail(ada, 'SA-0164');

    expect(detail.appointment.appointmentNumber).toBe('SA-0164');
    expect(detail.live).toBe(true);
  });

  it("refuses another technician's appointment, even once it has been seen", async () => {
    // Ada's request puts SA-0164 into the remembered set.
    await getAppointmentDetail(ada, 'SA-0164');

    await expect(getAppointmentDetail(grace, 'SA-0164')).rejects.toThrow(CopilotError);
    await expect(getAppointmentDetail(grace, 'SA-0164')).rejects.toThrow(/not one of Grace Hopper's/);
  });

  it('still remembers an appointment that has dropped out of the Scheduled list', async () => {
    await getAppointmentDetail(ada, 'SA-0164');

    // Salesforce no longer lists it: the card falls back to the last copy.
    callTool.mockResolvedValue(appointmentsFor(ada.fullName, []));
    const detail = await getAppointmentDetail(ada, 'SA-0164');

    expect(detail.appointment.appointmentNumber).toBe('SA-0164');
    expect(detail.live).toBe(false);
    expect(detail.note).toMatch(/no longer lists SA-0164/);
  });

  it('does not leak a remembered appointment to a namesake with a different id', async () => {
    await getAppointmentDetail(ada, 'SA-0164');

    const impostor = toTechnician('Ada Lovelace', 'TCH-9999');
    callTool.mockResolvedValue(appointmentsFor('Ada Lovelace', []));

    await expect(getAppointmentDetail(impostor, 'SA-0164')).rejects.toThrow(CopilotError);
  });
});

describe('when no tool can list appointments', () => {
  it('fails honestly rather than inventing a schedule', async () => {
    listTools.mockResolvedValue({ approved: [], rejected: [], discoveredCount: 0, servers: [] });

    await expect(getAppointmentDetail(ada, 'SA-0164')).rejects.toThrow(/appointment lookup is not available/i);
    expect(callTool).not.toHaveBeenCalled();
  });
});
