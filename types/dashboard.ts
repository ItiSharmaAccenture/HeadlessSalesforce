/**
 * Shared types for the My Day dashboard and its API routes.
 *
 * The dashboard is fed by direct Salesforce REST calls (the
 * ADTTechnicianAppointments Named Query and bounded SOQL), never by Gemini or
 * MCP. Imported from both server and client code, so nothing here may touch
 * secrets or server-only modules.
 */

export type DashboardView = 'today' | 'week' | 'date';

/** Why a piece of data could not be shown. Rendered to the technician as-is. */
export interface Unavailable {
  status: 'unavailable';
  /** Machine-readable cause, for the UI to choose an icon or hint. */
  code:
    | 'not_mapped'
    | 'missing_api_scope'
    | 'not_authorized'
    | 'named_query_unavailable'
    | 'salesforce_error'
    | 'provider_not_configured'
    | 'insufficient_stops'
    | 'no_route'
    | 'routing_error'
    | 'not_found'
    | 'forbidden';
  message: string;
  /** What an administrator would need to do, when that is known. */
  adminHint?: string;
}

export interface AppointmentAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface DashboardAppointment {
  id: string;
  appointmentNumber: string | null;
  subject: string | null;
  status: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  /** Null when the customer lookup ran and found none; see `customerLookup`. */
  customerName: string | null;
  address: AppointmentAddress;
  latitude: number | null;
  longitude: number | null;
}

export interface DashboardResponse {
  status: 'ok';
  technician: { serviceResourceId: string; name: string | null };
  view: DashboardView;
  /** Local calendar date the range starts on, YYYY-MM-DD. */
  date: string;
  /** Exclusive local end date, YYYY-MM-DD. */
  endDate: string;
  timezone: string;
  /** Where the timezone came from. */
  timezoneSource: 'salesforce_user' | 'server_default';
  rangeUtc: { start: string; end: string };
  /** Distinct appointments in range (deduplicated by ServiceAppointmentId). */
  appointmentCount: number;
  /**
   * True when the Named Query hit its LIMIT 100 and the separate COUNT query
   * could not confirm the total; the count is then a lower bound.
   */
  countIsLowerBound: boolean;
  /** Total from the COUNT() query when the Named Query was truncated. */
  verifiedTotal: number | null;
  /** Count of today's appointments, whatever the selected view. */
  jobsToday: number | null;
  jobsTodayIsLowerBound: boolean;
  appointments: DashboardAppointment[];
  customerLookup: 'ok' | 'unavailable';
  source: 'named_query' | 'rest_query';
  fetchedAt: string;
}

export type DashboardResult = DashboardResponse | Unavailable;

export interface TechnicianProfile {
  status: 'ok';
  serviceResourceId: string;
  name: string | null;
  isActive: boolean | null;
  resourceType: string | null;
  timezone: string | null;
  territories: string[] | null;
  skills: Array<{ name: string; level: number | null }> | null;
  /** Salesforce has no standard duty-status field; null means not available. */
  dutyStatus: string | null;
  /** Inventory Location linked to the resource (van stock), if any. */
  locationId: string | null;
}

export type TechnicianProfileResult = TechnicianProfile | Unavailable;

export interface RouteStop {
  appointmentId: string;
  appointmentNumber: string | null;
  order: number;
  label: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  latitude: number;
  longitude: number;
  coordinateSource: 'salesforce' | 'geocoded';
}

export interface RouteLeg {
  fromAppointmentId: string;
  toAppointmentId: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface RouteResponse {
  status: 'ok';
  provider: 'mapbox';
  unit: 'mi' | 'km';
  stops: RouteStop[];
  legs: RouteLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  /** GeoJSON LineString coordinates [lng, lat]. */
  geometry: Array<[number, number]>;
  /** Appointments that could not be placed on the route. */
  skipped: Array<{ appointmentId: string; appointmentNumber: string | null; reason: string }>;
  warnings: string[];
  directionsUrl: string | null;
}

/** Route endpoint: either a route or an explanation, plus whatever stops could be placed. */
export type RouteResult =
  | RouteResponse
  | (Unavailable & { unit: 'mi' | 'km'; stops: RouteStop[]; skipped: RouteResponse['skipped']; warnings: string[] });

export interface SectionOk<T> {
  status: 'ok';
  data: T;
}
export type Section<T> = SectionOk<T> | Unavailable;

export interface AppointmentWorkspace {
  status: 'ok';
  appointment: DashboardAppointment & {
    description: string | null;
    arrivalWindowStart: string | null;
    arrivalWindowEnd: string | null;
    workType: string | null;
  };
  customer: Section<{ accountName: string | null; accountPhone: string | null; contactName: string | null; contactPhone: string | null }>;
  workOrder: Section<{ id: string; number: string | null; subject: string | null; status: string | null; priority: string | null; description: string | null } | null>;
  lineItems: Section<Array<{ lineItemNumber: string | null; productName: string | null; quantity: number | null; status: string | null }>>;
  parts: Section<Array<{ productId: string | null; productName: string | null; quantityRequired: number | null; unit: string | null }>>;
  inventory: Section<Array<{ productId: string | null; productName: string | null; required: number | null; onHand: number; missing: number }>>;
}

export type AppointmentWorkspaceResult = AppointmentWorkspace | Unavailable;
