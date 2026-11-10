'use client';

/**
 * ADT My Day — route & map-centric technician workspace.
 *
 * Two independent data paths, with separate loading and error states:
 *   - Dashboard: /api/dashboard*, direct Salesforce REST (Named Query). No AI.
 *   - Copilot:   /api/copilot, Gemini + Salesforce MCP, unchanged.
 *
 * Selection is shared: picking an appointment in the timeline, the Jobs drawer
 * or on the map highlights it everywhere and becomes the Copilot's context.
 */

import Image from 'next/image';
import { Bot, List, Map as MapIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import CopilotChat from '@/components/my-day/CopilotChat';
import type { DashboardResult, DashboardView, RouteResult, TechnicianProfileResult } from '@/types/dashboard';
import type { Technician } from '@/types/technician';
import { formatLongDate, greeting } from './format';
import Header, { type Connection } from './Header';
import JobsDrawer from './JobsDrawer';
import JobWorkspace from './JobWorkspace';
import KpiTiles from './KpiTiles';
import RouteMap from './RouteMap';
import RouteView from './RouteView';
import Sidebar, { type NavTarget } from './Sidebar';
import Timeline from './Timeline';

const COPILOT_STARTERS = [
  "What's my next appointment?",
  'Summarize this customer',
  'Check required parts',
  'Find missing inventory',
  'Recommend upsell products',
  'Prepare job closure',
];

const REVALIDATE_MS = 5 * 60_000;
const COLLAPSE_KEY = 'adt-myday:sidebar-collapsed';

type Loadable<T> = { data: T | null; loading: boolean; error: string | null };
const idle = <T,>(): Loadable<T> => ({ data: null, loading: true, error: null });

class SignedOut extends Error {}

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error('Could not reach the server. Check your connection.');
  }
  if (response.status === 401) throw new SignedOut();
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok && !(body && typeof body === 'object' && 'status' in body)) {
    throw new Error(body?.error ?? `Request failed (HTTP ${response.status}).`);
  }
  return body as T;
}

/**
 * Every route response, including "not linked"/error states from the shared
 * authorization step, is given the arrays the UI reads, so a missing field can
 * never crash the page.
 */
function normaliseRoute(route: RouteResult): RouteResult {
  return {
    ...route,
    unit: route.unit ?? 'mi',
    stops: Array.isArray(route.stops) ? route.stops : [],
    skipped: Array.isArray(route.skipped) ? route.skipped : [],
    warnings: Array.isArray(route.warnings) ? route.warnings : [],
  } as RouteResult;
}

function viewQuery(view: DashboardView, date: string | null): string {
  return view === 'date' && date ? `view=date&date=${date}` : `view=${view}`;
}

interface MyDayAppProps {
  technician: Technician;
  mapToken: string | null;
  fontClassName: string;
}

export default function MyDayApp({ technician, mapToken, fontClassName }: MyDayAppProps) {
  const router = useRouter();

  const [view, setView] = useState<DashboardView>('today');
  const [date, setDate] = useState<string | null>(null);
  const [today, setToday] = useState<Loadable<DashboardResult>>(idle);
  const [todayRoute, setTodayRoute] = useState<Loadable<RouteResult>>(idle);
  const [period, setPeriod] = useState<Loadable<DashboardResult>>(idle);
  const [periodRoute, setPeriodRoute] = useState<Loadable<RouteResult>>(idle);
  const [profile, setProfile] = useState<TechnicianProfileResult | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotPrompt, setCopilotPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [mobilePane, setMobilePane] = useState<'list' | 'map'>('list');
  const [nav, setNav] = useState<NavTarget>('my-day');

  const handleError = useCallback(
    (error: unknown): string => {
      if (error instanceof SignedOut) {
        router.refresh();
        return 'You are signed out.';
      }
      return (error as Error).message;
    },
    [router],
  );

  /* ---- Loading ------------------------------------------------------ */

  const load = useCallback(
    async <T,>(url: string, set: (value: Loadable<T> | ((prev: Loadable<T>) => Loadable<T>)) => void) => {
      set((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const raw = await getJson<T>(url);
        const data = (url.startsWith('/api/dashboard/route') && raw && typeof raw === 'object' ? normaliseRoute(raw as RouteResult) : raw) as T;
        set({ data, loading: false, error: null });
        return data;
      } catch (error) {
        set((prev) => ({ ...prev, loading: false, error: handleError(error) }));
        return null;
      }
    },
    [handleError],
  );

  const loadToday = useCallback(
    async (refresh = false) => {
      const suffix = refresh ? '&refresh=1' : '';
      // Appointments first; the route reuses the server's cached page and never blocks the timeline.
      await load<DashboardResult>(`/api/dashboard?view=today${suffix}`, setToday);
      void load<RouteResult>('/api/dashboard/route?view=today', setTodayRoute);
    },
    [load],
  );

  useEffect(() => {
    void loadToday();
    void getJson<TechnicianProfileResult>('/api/dashboard/technician')
      .then(setProfile)
      .catch((error) => setProfile({ status: 'unavailable', code: 'salesforce_error', message: handleError(error) }));
  }, [loadToday, handleError]);

  useEffect(() => {
    if (view === 'today') return;
    const query = viewQuery(view, date);
    void load<DashboardResult>(`/api/dashboard?${query}`, setPeriod).then(() =>
      load<RouteResult>(`/api/dashboard/route?${query}`, setPeriodRoute),
    );
  }, [view, date, load]);

  // Background revalidation while the tab is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadToday();
    }, REVALIDATE_MS);
    return () => clearInterval(timer);
  }, [loadToday]);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // Storage disabled.
    }
  }, []);

  const toggleCollapsed = () =>
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1');
      } catch {
        // Not remembered; harmless.
      }
      return !value;
    });

  const refresh = () => {
    if (view === 'today') void loadToday(true);
    else {
      const query = viewQuery(view, date);
      void load<DashboardResult>(`/api/dashboard?${query}&refresh=1`, setPeriod).then(() =>
        load<RouteResult>(`/api/dashboard/route?${query}`, setPeriodRoute),
      );
    }
  };

  /* ---- Derived ------------------------------------------------------ */

  const shown = view === 'today' ? today : period;
  const shownRoute = view === 'today' ? todayRoute : periodRoute;
  const todayOk = today.data?.status === 'ok' ? today.data : null;
  const shownOk = shown.data?.status === 'ok' ? shown.data : null;
  const timezone = todayOk?.timezone ?? shownOk?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const allAppointments = useMemo(() => {
    const byId = new Map<string, NonNullable<typeof todayOk>['appointments'][number]>();
    for (const source of [todayOk, shownOk]) source?.appointments.forEach((appointment) => byId.set(appointment.id, appointment));
    return [...byId.values()];
  }, [todayOk, shownOk]);

  const selected = allAppointments.find((appointment) => appointment.id === selectedId) ?? null;
  const copilotContext = selected
    ? { id: selected.id, label: [selected.appointmentNumber, selected.subject].filter(Boolean).join(' · ') || 'Selected appointment' }
    : null;

  const connection: Connection = useMemo(() => {
    if (today.loading && !today.data) return { state: 'checking', detail: 'Loading your appointments from Salesforce…' };
    if (today.error) return { state: 'error', detail: today.error };
    if (today.data?.status === 'ok') return { state: 'connected', detail: `Appointments loaded via ${today.data.source === 'named_query' ? 'Named Query API' : today.data.source === 'owner_query' ? 'REST Query API (by owner)' : 'REST Query API'}.` };
    if (today.data?.status === 'unavailable') {
      const setup = ['missing_api_scope', 'not_mapped', 'named_query_unavailable', 'not_authorized'].includes(today.data.code);
      return { state: setup ? 'setup' : 'error', detail: today.data.message };
    }
    return { state: 'checking', detail: '' };
  }, [today]);

  /* ---- Actions ------------------------------------------------------ */

  const select = useCallback((id: string) => {
    setSelectedId(id);
    // Bring the timeline card into view without stealing focus.
    requestAnimationFrame(() =>
      document.querySelector(`.adt-timeline [data-appointment-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }, []);

  const openJob = useCallback((id: string) => {
    setSelectedId(id);
    setWorkspaceId(id);
  }, []);

  const askCopilot = useCallback((prompt: string) => {
    setCopilotOpen(true);
    setCopilotPrompt({ text: prompt, nonce: Date.now() });
  }, []);

  const navigate = (target: NavTarget) => {
    setNav(target);
    if (target === 'schedule') {
      setView('week');
      document.getElementById('adt-tl-title')?.scrollIntoView({ behavior: 'smooth' });
    } else if (target === 'jobs') setJobsOpen(true);
    else if (target === 'copilot') {
      setCopilotOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.adt-copilot .cp-input')?.focus());
    } else {
      setView('today');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const firstName = (profile?.status === 'ok' ? (profile.userName ?? profile.name ?? technician.fullName) : technician.fullName).split(/\s+/)[0];
  const localToday = todayOk?.date ?? null;

  return (
    <div className={`adt-app ${fontClassName}${collapsed ? ' is-collapsed' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
        active={nav}
        onNavigate={navigate}
      />

      <div className="adt-main">
        <Header technician={technician} connection={connection} profile={profile} onOpenMobileNav={() => setMobileNav(true)} />

        <main className="adt-content">
          <section className="adt-banner" aria-labelledby="adt-greeting">
            <div className="adt-banner-text">
              <h2 id="adt-greeting">
                {greeting(timezone)}, {firstName}
              </h2>
              <p>
                {localToday ? formatLongDate(localToday) : new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone }).format(new Date())}
                {todayOk?.timezoneSource === 'server_default' ? <span className="adt-tz-note"> · {timezone} (default time zone)</span> : null}
              </p>
            </div>
            <Image className="adt-banner-img" src="/assets/my-day/hero-house.webp" alt="" width={982} height={243} preload />
          </section>

          <KpiTiles
            today={today.data}
            todayLoading={today.loading}
            route={todayRoute.data}
            routeLoading={todayRoute.loading}
            onOpenJobs={() => setJobsOpen(true)}
            onOpenRoute={() => setRouteOpen(true)}
          />
          {today.error ? <p className="adt-inline-warn" role="alert">{today.error}</p> : null}

          <div className="adt-pane-toggle" role="group" aria-label="Show list or map">
            <button type="button" aria-pressed={mobilePane === 'list'} onClick={() => setMobilePane('list')}>
              <List size={16} aria-hidden="true" /> List
            </button>
            <button type="button" aria-pressed={mobilePane === 'map'} onClick={() => setMobilePane('map')}>
              <MapIcon size={16} aria-hidden="true" /> Map
            </button>
          </div>

          <div className={`adt-split adt-split--${mobilePane}`}>
            <Timeline
              data={shown.data}
              loading={shown.loading}
              error={shown.error}
              view={view}
              date={date}
              onViewChange={(next, nextDate) => {
                setView(next);
                setDate(nextDate ?? null);
              }}
              onRefresh={refresh}
              selectedId={selectedId}
              onSelect={select}
              onOpenJob={openJob}
            />
            <section className="adt-card adt-mapcard" aria-label="Route map">
              <RouteMap
                token={mapToken}
                route={shownRoute.data}
                routeLoading={shownRoute.loading}
                appointments={shownOk?.appointments ?? []}
                timezone={timezone}
                selectedId={selectedId}
                onSelect={select}
                onOpenJob={openJob}
              />
              {shownRoute.data && shownRoute.data.warnings.length > 0 ? (
                <p className="adt-map-warn">{shownRoute.data.warnings[0]}{shownRoute.data.warnings.length > 1 ? ` (+${shownRoute.data.warnings.length - 1} more in route view)` : ''}</p>
              ) : null}
            </section>
          </div>
        </main>
      </div>

      <aside className={`adt-copilot${copilotOpen ? ' is-open' : ''}`} aria-label="ADT Technician Copilot">
        <CopilotChat
          firstName={firstName}
          fontClassName={fontClassName}
          docked
          open={copilotOpen}
          onOpenChange={setCopilotOpen}
          context={copilotContext}
          onClearContext={() => setSelectedId(null)}
          prompt={copilotPrompt}
          starters={COPILOT_STARTERS}
        />
      </aside>
      <button type="button" className="adt-fab" onClick={() => setCopilotOpen(true)} aria-label="Open ADT Copilot">
        <Bot size={24} aria-hidden="true" />
      </button>

      <JobsDrawer
        open={jobsOpen}
        onClose={() => setJobsOpen(false)}
        data={today.data}
        loading={today.loading}
        selectedId={selectedId}
        onSelect={select}
        onOpenJob={(id) => {
          setJobsOpen(false);
          openJob(id);
        }}
        onViewFullSchedule={() => {
          setJobsOpen(false);
          navigate('schedule');
        }}
      />
      <RouteView
        open={routeOpen}
        onClose={() => setRouteOpen(false)}
        route={todayRoute.data}
        loading={todayRoute.loading}
        appointments={todayOk?.appointments ?? []}
        timezone={timezone}
        mapToken={mapToken}
        selectedId={selectedId}
        onSelect={select}
        onOpenJob={(id) => {
          setRouteOpen(false);
          openJob(id);
        }}
      />
      <JobWorkspace appointmentId={workspaceId} timezone={timezone} onClose={() => setWorkspaceId(null)}
        onAskCopilot={(text) => {
          setWorkspaceId(null);
          askCopilot(text);
        }}
      />
    </div>
  );
}
