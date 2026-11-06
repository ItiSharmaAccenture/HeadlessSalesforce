import { describe, expect, it } from 'vitest';

import {
  CopilotError,
  detectScheduleIntent,
  detectStatusIntent,
  digestSchedule,
  normaliseAppointmentNumber,
  readSchedule,
} from '@/lib/copilot';
import { toTechnician } from '@/lib/technician';

const technician = toTechnician('Sayantan Pal', 'TCH-7842');

/**
 * The shape Hosted MCP returns for an invocable Apex action (structuredContent).
 * `actionName` is carried for realism only; nothing reads it.
 */
function actionPayload(outputValues: Record<string, unknown>, isSuccess = true) {
  return { content: [{ actionName: 'FSTechAppointmentAction', errors: null, isSuccess, outputValues }] };
}

const appointments = [
  {
    appointmentNumber: 'SA-0164',
    appointmentId: '08pg7000001YFqTAAW',
    status: 'Scheduled',
    schedStartTime: '2026-11-05T08:30:00.000Z',
    schedEndTime: '2026-11-05T09:30:00.000Z',
    accountName: 'Biospan, LLC.',
    address: '2040 Juniper Way, Cedar Park, Texas 78613, United States',
  },
  {
    appointmentNumber: 'SA-0170',
    status: 'Scheduled',
    schedStartTime: '2026-11-09T17:00:00.000Z',
    schedEndTime: '2026-11-09T18:00:00.000Z',
  },
];

describe('detectScheduleIntent', () => {
  it('recognises the starter questions and close variants', () => {
    expect(detectScheduleIntent("What's my schedule today?")).toBe('today');
    expect(detectScheduleIntent('What’s my schedule this week?')).toBe('week');
    expect(detectScheduleIntent("What's my next appointment?")).toBe('next');
    expect(detectScheduleIntent('show me my appointments tomorrow')).toBe('tomorrow');
    expect(detectScheduleIntent('when is my next job')).toBe('next');
  });

  it('leaves anything more specific to the model', () => {
    expect(detectScheduleIntent("What's my schedule this week for Biospan?")).toBeNull();
    expect(detectScheduleIntent('What parts do I need today?')).toBeNull();
    expect(detectScheduleIntent('hello')).toBeNull();
  });
});

describe('detectStatusIntent', () => {
  it('recognises reported statuses', () => {
    expect(detectStatusIntent("I'm on my way")).toBe('on_my_way');
    expect(detectStatusIntent('heading over to SA-0163 now')).toBe('on_my_way');
    expect(detectStatusIntent('starting the job')).toBe('start');
  });

  it('ignores questions about statuses', () => {
    expect(detectStatusIntent('When does my next job start?')).toBeNull();
    expect(detectStatusIntent('Should I tell them I am on my way?')).toBeNull();
  });
});

describe('normaliseAppointmentNumber', () => {
  it('accepts the spellings technicians type', () => {
    expect(normaliseAppointmentNumber('SA-0164')).toBe('SA-0164');
    expect(normaliseAppointmentNumber('sa - 0164')).toBe('SA-0164');
    expect(normaliseAppointmentNumber('SA0164')).toBe('SA-0164');
  });

  it('rejects anything else', () => {
    expect(normaliseAppointmentNumber('0164')).toBeNull();
    expect(normaliseAppointmentNumber('SA-01; DROP')).toBeNull();
  });
});

describe('readSchedule', () => {
  it('parses appointmentsJson from the invocable action result', () => {
    const schedule = readSchedule(
      actionPayload({
        appointmentsJson: JSON.stringify(appointments),
        technicianName: 'Sayantan Pal',
        timeZone: 'America/Los_Angeles',
        currentDateTime: 'Fri, Nov 6, 2026 12:08 AM',
        success: true,
      }),
      technician,
    );

    expect(schedule?.appointments.map((appointment) => appointment.appointmentNumber)).toEqual(['SA-0164', 'SA-0170']);
    expect(schedule?.appointments[0].address).toBe(appointments[0].address);
    expect(schedule?.meta).toEqual({
      technicianName: 'Sayantan Pal',
      timeZone: 'America/Los_Angeles',
      currentDateTime: 'Fri, Nov 6, 2026 12:08 AM',
    });
  });

  it('returns an empty list when Salesforce found nothing', () => {
    expect(readSchedule(actionPayload({ appointmentsJson: '[]', success: true }), technician)?.appointments).toEqual([]);
  });

  it('raises the action message when Salesforce reports a failure', () => {
    expect(() => readSchedule(actionPayload({ success: false, message: 'No technician named X.' }), technician)).toThrow(CopilotError);
    expect(() => readSchedule(actionPayload({ success: false, message: 'No technician named X.' }), technician)).toThrow(
      'No technician named X.',
    );
  });

  it('returns null for payloads that are not action results', () => {
    expect(readSchedule({ records: [] }, technician)).toBeNull();
  });
});

describe('digestSchedule', () => {
  it("works out local dates and timing in the technician's zone", () => {
    const schedule = readSchedule(
      actionPayload({ appointmentsJson: JSON.stringify(appointments), timeZone: 'America/Los_Angeles', success: true }),
      technician,
    )!;
    // 08:08 UTC on Nov 6 is still 00:08 on Friday Nov 6 in Los Angeles.
    const digest = JSON.parse(digestSchedule(schedule, new Date('2026-11-06T08:08:00Z')));

    expect(digest.today).toBe('2026-11-06');
    expect(digest.thisWeek).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(digest.appointments[0]).toMatchObject({ appointmentNumber: 'SA-0164', localDate: '2026-11-05', timing: 'past' });
    expect(digest.appointments[1]).toMatchObject({ appointmentNumber: 'SA-0170', localDate: '2026-11-09', timing: 'upcoming' });
  });
});
