/** Display helpers for the dashboard. All times render in the technician's zone. */

import type { AppointmentAddress, DashboardAppointment } from '@/types/dashboard';

export function formatTime(iso: string | null, zone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(date);
}

export function formatWindow(start: string | null, end: string | null, zone: string): string {
  if (!start) return 'Time not scheduled';
  return end ? `${formatTime(start, zone)} – ${formatTime(end, zone)}` : formatTime(start, zone);
}

/** "Tuesday, November 10" for a YYYY-MM-DD local date. */
export function formatLongDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatShortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function localDateOf(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function formatAddress(address: AppointmentAddress): string | null {
  const line = [address.street, address.city, [address.state, address.postalCode].filter(Boolean).join(' ')]
    .filter((part) => part && part.trim())
    .join(', ');
  return line || null;
}

export function formatDistance(meters: number, unit: 'mi' | 'km'): { value: string; unit: string } {
  const amount = unit === 'mi' ? meters / 1609.344 : meters / 1000;
  return { value: amount >= 100 ? amount.toFixed(0) : amount.toFixed(1), unit };
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function greeting(zone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const DONE = /complet|cancel|cannot|closed/i;

export function isCanceled(appointment: DashboardAppointment): boolean {
  return Boolean(appointment.status && /cancel/i.test(appointment.status));
}

/** The earliest appointment that has not started and is still open. */
export function nextAppointmentId(appointments: DashboardAppointment[], now = Date.now()): string | null {
  const next = appointments.find(
    (appointment) =>
      appointment.scheduledStart && Date.parse(appointment.scheduledStart) > now && !(appointment.status && DONE.test(appointment.status)),
  );
  return next?.id ?? null;
}

export function statusTone(status: string | null): 'blue' | 'green' | 'amber' | 'red' | 'grey' {
  if (!status) return 'grey';
  if (/cancel|cannot/i.test(status)) return 'red';
  if (/complet/i.test(status)) return 'green';
  if (/progress|travel|way|onsite|started/i.test(status)) return 'amber';
  if (/schedul|dispatch/i.test(status)) return 'blue';
  return 'grey';
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}
