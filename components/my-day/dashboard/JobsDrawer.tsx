'use client';

import { CalendarDays, ChevronRight, Clock, MapPin } from 'lucide-react';

import type { DashboardResult } from '@/types/dashboard';
import Drawer from './Drawer';
import { formatAddress, formatLongDate, formatWindow } from './format';
import { Skeleton, UnavailableNotice } from './Notice';
import { StatusChip } from './Timeline';

interface JobsDrawerProps {
  open: boolean;
  onClose: () => void;
  data: DashboardResult | null;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenJob: (id: string) => void;
  onViewFullSchedule: () => void;
}

export default function JobsDrawer({ open, onClose, data, loading, selectedId, onSelect, onOpenJob, onViewFullSchedule }: JobsDrawerProps) {
  const ok = data?.status === 'ok' ? data : null;
  const selected = ok?.appointments.find((appointment) => appointment.id === selectedId) ?? null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      icon={<CalendarDays size={22} />}
      title="Jobs Today"
      subtitle={ok ? `${formatLongDate(ok.date)} · ${ok.jobsToday ?? ok.appointmentCount}${ok.jobsTodayIsLowerBound ? '+' : ''} assigned` : undefined}
      footer={
        <button type="button" className="adt-btn adt-btn--ghost" onClick={onViewFullSchedule}>
          View full schedule <ChevronRight size={16} aria-hidden="true" />
        </button>
      }
    >
      {loading && !data ? <Skeleton lines={6} /> : null}
      {data?.status === 'unavailable' ? <UnavailableNotice state={data} /> : null}
      {ok && ok.appointments.length === 0 ? <p className="adt-empty">No appointments are assigned to you today.</p> : null}
      {ok && ok.appointments.length > 0 ? (
        <ul className="adt-joblist">
          {ok.appointments.map((appointment) => {
            const isSelected = appointment.id === selectedId;
            return (
              <li key={appointment.id}>
                <button type="button" className={`adt-job${isSelected ? ' is-selected' : ''}`} aria-pressed={isSelected} onClick={() => onSelect(appointment.id)}>
                  <span className="adt-job-top">
                    <strong>{appointment.appointmentNumber ?? 'No number'}</strong>
                    <StatusChip status={appointment.status} />
                  </span>
                  <span className="adt-job-customer">{appointment.customerName ?? 'Customer unavailable'}</span>
                  <span className="adt-job-subject">{appointment.subject ?? 'No subject'}</span>
                  <span className="adt-tl-meta">
                    <Clock size={14} aria-hidden="true" /> {formatWindow(appointment.scheduledStart, appointment.scheduledEnd, ok.timezone)}
                  </span>
                  <span className="adt-tl-meta">
                    <MapPin size={14} aria-hidden="true" /> {formatAddress(appointment.address) ?? 'Address unavailable'}
                  </span>
                </button>
                {isSelected && selected ? (
                  <div className="adt-job-summary">
                    <p>
                      Selected on the map and shared with ADT Copilot as context.
                    </p>
                    <button type="button" className="adt-btn adt-btn--primary adt-btn--sm" onClick={() => onOpenJob(appointment.id)}>
                      Open job <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Drawer>
  );
}
