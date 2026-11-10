'use client';

/**
 * Exactly two KPI tiles: Jobs Today and Total Route. Both values come from
 * real sources (the Named Query and the routing provider) or say why not.
 */

import { CalendarDays, ChevronRight, Route } from 'lucide-react';

import type { DashboardResult, RouteResult } from '@/types/dashboard';
import { formatDistance, formatDuration } from './format';

interface KpiTilesProps {
  today: DashboardResult | null;
  todayLoading: boolean;
  route: RouteResult | null;
  routeLoading: boolean;
  onOpenJobs: () => void;
  onOpenRoute: () => void;
}

export default function KpiTiles({ today, todayLoading, route, routeLoading, onOpenJobs, onOpenRoute }: KpiTilesProps) {
  const jobs =
    today?.status === 'ok'
      ? { value: today.jobsToday === null ? '—' : `${today.jobsToday}${today.jobsTodayIsLowerBound ? '+' : ''}`, note: today.jobsToday === 1 ? 'appointment assigned' : 'appointments assigned' }
      : today?.status === 'unavailable'
        ? { value: '—', note: 'Unavailable' }
        : { value: null, note: 'Loading…' };

  let routeValue: string | null = null;
  let routeUnit = '';
  let routeNote = 'Calculating…';
  if (route?.status === 'ok') {
    const distance = formatDistance(route.totalDistanceMeters, route.unit);
    routeValue = distance.value;
    routeUnit = distance.unit;
    routeNote = `${formatDuration(route.totalDurationSeconds)} driving · ${route.stops.length} stops`;
  } else if (route?.status === 'unavailable') {
    routeValue = '—';
    routeNote =
      route.code === 'provider_not_configured'
        ? 'Routing not configured'
        : route.code === 'insufficient_stops'
          ? 'Needs 2+ located stops'
          : route.code === 'no_route'
            ? 'No drivable route'
            : 'Unavailable';
  } else if (!routeLoading && !todayLoading) {
    routeValue = '—';
    routeNote = 'Unavailable';
  }

  return (
    <ul className="adt-kpis" aria-label="Today at a glance">
      <li>
        <button type="button" className="adt-kpi" onClick={onOpenJobs} aria-label={`Jobs today: ${jobs.value ?? 'loading'}. Open today's jobs`}>
          <span className="adt-kpi-icon adt-kpi-icon--blue" aria-hidden="true">
            <CalendarDays size={24} />
          </span>
          <span className="adt-kpi-text">
            <span className="adt-kpi-label">Jobs Today</span>
            <span className="adt-kpi-value">{jobs.value ?? <span className="adt-kpi-shimmer" />}</span>
            <span className="adt-kpi-note">{jobs.note}</span>
          </span>
          <ChevronRight className="adt-kpi-arrow" size={22} aria-hidden="true" />
        </button>
      </li>
      <li>
        <button
          type="button"
          className="adt-kpi"
          onClick={onOpenRoute}
          aria-label={`Total route: ${routeValue ? `${routeValue} ${routeUnit}` : 'calculating'}. Open route view`}
        >
          <span className="adt-kpi-icon adt-kpi-icon--teal" aria-hidden="true">
            <Route size={24} />
          </span>
          <span className="adt-kpi-text">
            <span className="adt-kpi-label">Total Route</span>
            <span className="adt-kpi-value">
              {routeValue ?? <span className="adt-kpi-shimmer" />}
              {routeUnit ? <small> {routeUnit}</small> : null}
            </span>
            <span className="adt-kpi-note">{routeNote}</span>
          </span>
          <ChevronRight className="adt-kpi-arrow" size={22} aria-hidden="true" />
        </button>
      </li>
    </ul>
  );
}
