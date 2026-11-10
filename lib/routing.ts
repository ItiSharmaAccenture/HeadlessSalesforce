/**
 * Driving route for the day, from a real routing provider.
 *
 * Provider (ADT_ROUTING_PROVIDER, default auto):
 *   - mapbox: Mapbox Directions + Geocoding (MAPBOX_ACCESS_TOKEN).
 *   - osrm:   OSRM driving routes (OSRM_URL, default the public demo server)
 *             and OpenStreetMap Nominatim geocoding. No key, but the public
 *             servers are for light/demo use only.
 *   - none:   no routing; the tiles say so.
 *   auto = mapbox when a token is set, otherwise osrm.
 *
 * - Stops are kept in scheduled-start order. Nothing is optimised or reordered.
 * - Coordinates come from Salesforce Latitude/Longitude. Only when those are
 *   missing is the service address geocoded through the provider. Nothing
 *   is ever invented.
 * - Distance is the provider's driving distance, never a straight-line estimate.
 * - Legs whose travel time cannot fit between two appointments, or that are
 *   implausibly long for a day route, produce warnings rather than being hidden.
 *
 * Server token: MAPBOX_ACCESS_TOKEN (falls back to NEXT_PUBLIC_MAPBOX_TOKEN).
 */

import 'server-only';

import { log } from './logger';
import type { DashboardAppointment, RouteResult, RouteStop } from '@/types/dashboard';

const MAX_WAYPOINTS = 25; // Mapbox Directions limit for the driving profile; also used for OSRM.
const LONG_LEG_METERS = 250_000;
const TIMEOUT_MS = 12_000;

export function routingToken(): string | null {
  return process.env.MAPBOX_ACCESS_TOKEN?.trim() || process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() || null;
}

export type Provider = 'mapbox' | 'osrm';

export function routingProvider(): Provider | null {
  const configured = process.env.ADT_ROUTING_PROVIDER?.trim().toLowerCase();
  if (configured === 'none') return null;
  if (configured === 'osrm') return 'osrm';
  if (configured === 'mapbox') return routingToken() ? 'mapbox' : null;
  return routingToken() ? 'mapbox' : 'osrm';
}

function osrmBase(): string {
  return (process.env.OSRM_URL?.trim() || 'https://router.project-osrm.org').replace(/\/+$/, '');
}

/** Identifies this app to OpenStreetMap services, as their usage policy requires. */
const OSM_USER_AGENT = 'ADT-MyDay-POC/0.1 (field technician route demo)';

export function distanceUnit(): 'mi' | 'km' {
  return process.env.ADT_DISTANCE_UNIT === 'km' ? 'km' : 'mi';
}

const CANCELLED = /cancel/i;

export function formatAddress(appointment: DashboardAppointment): string | null {
  const { street, city, state, postalCode, country } = appointment.address;
  const parts = [street, city, [state, postalCode].filter(Boolean).join(' '), country].filter((part) => part && part.trim());
  // A city alone is too vague to geocode a doorstep from.
  return street && parts.length >= 2 ? parts.join(', ') : null;
}

const geocodeCache = new Map<string, { at: number; value: [number, number] | null }>();
const GEOCODE_TTL_MS = 60 * 60 * 1000;

let lastNominatimCall = 0;

/** Nominatim allows at most one request per second. */
async function geocodeNominatim(address: string): Promise<[number, number] | null> {
  const wait = lastNominatimCall + 1100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimCall = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', address);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'User-Agent': OSM_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Geocoding failed (HTTP ${response.status})`);
  const body = (await response.json()) as Array<{ lat?: string; lon?: string }>;
  const lat = Number(body[0]?.lat);
  const lon = Number(body[0]?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && body[0]?.lat ? [lon, lat] : null;
}

async function geocode(address: string, provider: Provider, token: string | null): Promise<[number, number] | null> {
  const hit = geocodeCache.get(address);
  if (hit && Date.now() - hit.at < GEOCODE_TTL_MS) return hit.value;
  if (provider === 'osrm' || !token) {
    const value = await geocodeNominatim(address);
    geocodeCache.set(address, { at: Date.now(), value });
    return value;
  }

  const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
  url.searchParams.set('q', address);
  url.searchParams.set('limit', '1');
  url.searchParams.set('types', 'address');
  url.searchParams.set('access_token', token);

  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Geocoding failed (HTTP ${response.status})`);
  const body = (await response.json()) as { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: { match_code?: { confidence?: string } } }> };
  const feature = body.features?.[0];
  const confidence = feature?.properties?.match_code?.confidence;
  // A low-confidence match would put a pin somewhere the customer is not.
  const value = feature?.geometry?.coordinates && confidence !== 'low' ? feature.geometry.coordinates : null;
  geocodeCache.set(address, { at: Date.now(), value });
  return value;
}

function label(appointment: DashboardAppointment): string {
  return formatAddress(appointment) ?? ([appointment.address.city, appointment.address.state].filter(Boolean).join(', ') || 'Address unavailable');
}

export async function buildRoute(appointments: DashboardAppointment[]): Promise<RouteResult> {
  const unit = distanceUnit();
  const token = routingToken();
  const provider = routingProvider();
  const skipped: Array<{ appointmentId: string; appointmentNumber: string | null; reason: string }> = [];
  const warnings: string[] = [];

  const ordered = appointments
    .filter((appointment) => {
      if (appointment.status && CANCELLED.test(appointment.status)) {
        skipped.push({ appointmentId: appointment.id, appointmentNumber: appointment.appointmentNumber, reason: 'Canceled' });
        return false;
      }
      if (!appointment.scheduledStart) {
        skipped.push({ appointmentId: appointment.id, appointmentNumber: appointment.appointmentNumber, reason: 'No scheduled time' });
        return false;
      }
      return true;
    })
    .sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''));

  const stops: RouteStop[] = [];
  for (const appointment of ordered) {
    let coords: [number, number] | null = null;
    let source: RouteStop['coordinateSource'] = 'salesforce';
    if (appointment.latitude !== null && appointment.longitude !== null) {
      coords = [appointment.longitude, appointment.latitude];
    } else if (provider) {
      const address = formatAddress(appointment);
      if (address) {
        try {
          coords = await geocode(address, provider, token);
          source = 'geocoded';
        } catch (error) {
          log.warn('routing', 'Geocoding failed', { message: (error as Error).message });
        }
      }
    }
    if (!coords) {
      skipped.push({
        appointmentId: appointment.id,
        appointmentNumber: appointment.appointmentNumber,
        reason: formatAddress(appointment) ? 'Address could not be located' : 'No coordinates or complete address',
      });
      continue;
    }
    stops.push({
      appointmentId: appointment.id,
      appointmentNumber: appointment.appointmentNumber,
      order: stops.length + 1,
      label: label(appointment),
      scheduledStart: appointment.scheduledStart,
      scheduledEnd: appointment.scheduledEnd,
      longitude: coords[0],
      latitude: coords[1],
      coordinateSource: source,
    });
  }

  if (!provider) {
    return {
      status: 'unavailable',
      code: 'provider_not_configured',
      message: 'No routing provider is configured, so driving distance cannot be calculated.',
      adminHint: 'Unset ADT_ROUTING_PROVIDER (uses OSRM), or set MAPBOX_ACCESS_TOKEN for Mapbox Directions.',
      unit,
      stops,
      skipped,
      warnings,
    };
  }

  if (stops.length < 2) {
    return {
      status: 'unavailable',
      code: 'insufficient_stops',
      message: stops.length === 0 ? 'No appointments with a usable location in this period.' : 'Only one stop has a usable location, so there is no route to drive.',
      unit,
      stops,
      skipped,
      warnings,
    };
  }

  let routed = stops;
  if (stops.length > MAX_WAYPOINTS) {
    routed = stops.slice(0, MAX_WAYPOINTS);
    warnings.push(`Only the first ${MAX_WAYPOINTS} stops are routed (provider limit).`);
  }

  const coordinates = routed.map((stop) => `${stop.longitude.toFixed(6)},${stop.latitude.toFixed(6)}`).join(';');
  const url =
    provider === 'mapbox'
      ? new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`)
      : new URL(`${osrmBase()}/route/v1/driving/${coordinates}`);
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'simplified'); // plenty for display; 'full' can be tens of thousands of points
  if (provider === 'mapbox' && token) url.searchParams.set('access_token', token);

  let body: { code?: string; message?: string; routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Array<[number, number]> }; legs: Array<{ distance: number; duration: number }> }> };
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: provider === 'osrm' ? { 'User-Agent': OSM_USER_AGENT } : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await response.json();
    if (!response.ok && body.code !== 'NoRoute') throw new Error(body.message ?? `HTTP ${response.status}`);
  } catch (error) {
    log.warn('routing', 'Directions request failed', { message: (error as Error).message });
    return { status: 'unavailable', code: 'routing_error', message: 'The routing provider could not be reached.', unit, stops, skipped, warnings };
  }

  const route = body.routes?.[0];
  if (body.code !== 'Ok' || !route) {
    return {
      status: 'unavailable',
      code: 'no_route',
      message: 'No drivable route connects these stops (they may be on different landmasses or an address may be wrong).',
      unit,
      stops,
      skipped,
      warnings,
    };
  }

  const legs = route.legs.map((leg, index) => ({
    fromAppointmentId: routed[index].appointmentId,
    toAppointmentId: routed[index + 1].appointmentId,
    distanceMeters: leg.distance,
    durationSeconds: leg.duration,
  }));

  legs.forEach((leg, index) => {
    const from = routed[index];
    const to = routed[index + 1];
    const name = `${from.appointmentNumber ?? `Stop ${from.order}`} → ${to.appointmentNumber ?? `Stop ${to.order}`}`;
    if (leg.distanceMeters > LONG_LEG_METERS) {
      warnings.push(`${name} is a very long drive for a single day route; check the appointment addresses.`);
    }
    const freeFrom = Date.parse(from.scheduledEnd ?? from.scheduledStart ?? '');
    const nextStart = Date.parse(to.scheduledStart ?? '');
    if (Number.isFinite(freeFrom) && Number.isFinite(nextStart) && nextStart - freeFrom < leg.durationSeconds * 1000) {
      warnings.push(`${name}: the drive takes longer than the time between the two appointments.`);
    }
  });

  if (stops.some((stop) => stop.coordinateSource === 'geocoded')) {
    warnings.push('Some stops were placed by geocoding the service address because Salesforce has no coordinates for them.');
  }

  const destination = routed[routed.length - 1];
  const waypoints = routed.slice(0, -1).map((stop) => `${stop.latitude},${stop.longitude}`).join('|');
  const directionsUrl =
    `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${destination.latitude},${destination.longitude}` +
    (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '');

  return {
    status: 'ok',
    provider,
    unit,
    stops,
    legs,
    totalDistanceMeters: route.distance,
    totalDurationSeconds: route.duration,
    geometry: route.geometry.coordinates,
    skipped,
    warnings,
    directionsUrl,
  };
}
