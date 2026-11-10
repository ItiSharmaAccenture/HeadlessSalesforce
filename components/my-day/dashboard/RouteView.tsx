'use client';

import { ExternalLink, Route, TriangleAlert } from 'lucide-react';

import type { DashboardAppointment, RouteResult } from '@/types/dashboard';
import Drawer from './Drawer';
import { formatDistance, formatDuration, formatWindow } from './format';
import { Skeleton, UnavailableNotice } from './Notice';
import RouteMap from './RouteMap';

interface RouteViewProps {
  open: boolean;
  onClose: () => void;
  route: RouteResult | null;
  loading: boolean;
  appointments: DashboardAppointment[];
  timezone: string;
  mapToken: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenJob: (id: string) => void;
}

export default function RouteView({ open, onClose, route, loading, appointments, timezone, mapToken, selectedId, onSelect, onOpenJob }: RouteViewProps) {
  const ok = route?.status === 'ok' ? route : null;
  const total = ok ? formatDistance(ok.totalDistanceMeters, ok.unit) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="xl"
      icon={<Route size={22} />}
      title="Today's Route"
      subtitle={ok && total ? `${total.value} ${total.unit} · ${formatDuration(ok.totalDurationSeconds)} driving · stops in scheduled order` : 'Stops in scheduled order'}
      footer={
        ok?.directionsUrl ? (
          <a className="adt-btn adt-btn--primary" href={ok.directionsUrl} target="_blank" rel="noopener noreferrer">
            Open directions <ExternalLink size={15} aria-hidden="true" />
          </a>
        ) : undefined
      }
    >
      <div className="adt-routeview">
        <RouteMap
          token={mapToken}
          route={route}
          routeLoading={loading}
          appointments={appointments}
          timezone={timezone}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenJob={onOpenJob}
          large
        />
        <div className="adt-routeview-side">
          {loading && !route ? <Skeleton lines={5} /> : null}
          {route?.status === 'unavailable' ? <UnavailableNotice state={route} /> : null}
          {route && route.warnings.length > 0 ? (
            <ul className="adt-warnings">
              {route.warnings.map((warning) => (
                <li key={warning}>
                  <TriangleAlert size={15} aria-hidden="true" /> {warning}
                </li>
              ))}
            </ul>
          ) : null}
          {route && route.stops.length > 0 ? (
            <ol className="adt-stops">
              {route.stops.map((stop, index) => {
                const leg = ok?.legs[index - 1];
                const legDistance = leg && ok ? formatDistance(leg.distanceMeters, ok.unit) : null;
                const appointment = appointments.find((candidate) => candidate.id === stop.appointmentId);
                return (
                  <li key={stop.appointmentId}>
                    {legDistance && leg ? (
                      <p className="adt-leg">
                        {legDistance.value} {legDistance.unit} · {formatDuration(leg.durationSeconds)}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className={`adt-stop${stop.appointmentId === selectedId ? ' is-selected' : ''}`}
                      aria-pressed={stop.appointmentId === selectedId}
                      onClick={() => onSelect(stop.appointmentId)}
                    >
                      <span className="adt-stop-num">{stop.order}</span>
                      <span className="adt-stop-text">
                        <strong>
                          {stop.appointmentNumber ?? 'Appointment'} · {formatWindow(stop.scheduledStart, stop.scheduledEnd, timezone)}
                        </strong>
                        <span>{appointment?.customerName ?? 'Customer unavailable'}</span>
                        <span className="adt-muted">{stop.label}</span>
                        {stop.coordinateSource === 'geocoded' ? <span className="adt-muted adt-tiny">Located by address</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {route && route.skipped.length > 0 ? (
            <div className="adt-skipped">
              <h3>Not on the route</h3>
              <ul>
                {route.skipped.map((item) => (
                  <li key={item.appointmentId}>
                    {item.appointmentNumber ?? 'Appointment'} — {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
