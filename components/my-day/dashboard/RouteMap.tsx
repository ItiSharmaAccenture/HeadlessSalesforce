'use client';

/**
 * Interactive map of the period's stops (MapLibre GL JS).
 *
 * Markers are numbered in scheduled order and come only from real coordinates:
 * Salesforce Latitude/Longitude, or a server-side geocode of the service
 * address. Selecting a marker selects the appointment everywhere (timeline,
 * drawer, Copilot) and vice versa.
 *
 * Base map: Mapbox raster tiles when NEXT_PUBLIC_MAPBOX_TOKEN is set,
 * otherwise OpenStreetMap tiles (no key; light use only, attribution shown).
 */

import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, Marker, Popup, StyleSpecification } from 'maplibre-gl';

import type { DashboardAppointment, RouteResult, RouteStop } from '@/types/dashboard';
import { formatAddress, formatWindow } from './format';

interface RouteMapProps {
  token: string | null;
  route: RouteResult | null;
  routeLoading: boolean;
  appointments: DashboardAppointment[];
  timezone: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenJob: (id: string) => void;
  /** Taller map with more padding, for the expanded route view. */
  large?: boolean;
}

function baseStyle(token: string | null): StyleSpecification {
  const source = token
    ? {
        tiles: [`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(token)}`],
        attribution: '© Mapbox © OpenStreetMap contributors',
      }
    : {
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '© OpenStreetMap contributors',
      };
  return {
    version: 8,
    sources: { base: { type: 'raster', tileSize: 256, maxzoom: 19, ...source } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

function directionsUrl(stop: RouteStop): string {
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${stop.latitude},${stop.longitude}`;
}

export default function RouteMap({ token, route, routeLoading, appointments, timezone, selectedId, onSelect, onOpenJob, large }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, { marker: Marker; element: HTMLElement }>>(new Map());
  const popupRef = useRef<Popup | null>(null);
  const handlers = useRef({ onSelect, onOpenJob });
  const [loaded, setLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    handlers.current = { onSelect, onOpenJob };
  }, [onSelect, onOpenJob]);

  const stops = useMemo(() => route?.stops ?? [], [route]);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;
    const markers = markersRef.current;
    void import('maplibre-gl')
      .then((ml) => {
        if (cancelled || !containerRef.current) return;
        // Served from public/ (see scripts/copy-maplibre-worker.mjs); the bundler cannot resolve it.
        ml.setWorkerUrl('/vendor/maplibre/maplibre-gl-worker.mjs');
        map = new ml.Map({
          container: containerRef.current,
          style: baseStyle(token),
          center: [-98.5, 39.8],
          zoom: 3,
          cooperativeGestures: !large,
        });
        map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (!cancelled) setLoaded(true);
        });
        map.on('error', (event) => {
          const message = (event?.error as Error | undefined)?.message ?? '';
          if (/401|403/i.test(message)) setMapError('The map provider rejected the request.');
        });
        mapRef.current = map;
      })
      .catch(() => setMapError('The map library could not be loaded.'));
    return () => {
      cancelled = true;
      markers.forEach(({ marker }) => marker.remove());
      markers.clear();
      popupRef.current?.remove();
      map?.remove();
      mapRef.current = null;
      setLoaded(false);
    };
  }, [token, large]);

  // Markers and route line.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    let cancelled = false;

    void import('maplibre-gl').then((mapboxgl) => {
      if (cancelled) return;
      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();

      for (const stop of stops) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'adt-marker';
        element.textContent = String(stop.order);
        element.setAttribute('aria-label', `Stop ${stop.order}: ${stop.appointmentNumber ?? 'appointment'}`);
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          handlers.current.onSelect(stop.appointmentId);
        });
        const marker = new mapboxgl.Marker({ element }).setLngLat([stop.longitude, stop.latitude]).addTo(map);
        markersRef.current.set(stop.appointmentId, { marker, element });
      }

      const data: Parameters<GeoJSONSource['setData']>[0] = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route?.status === 'ok' ? route.geometry : [] },
      };
      const source = map.getSource('adt-route') as GeoJSONSource | undefined;
      if (source) source.setData(data);
      else {
        map.addSource('adt-route', { type: 'geojson', data });
        map.addLayer({
          id: 'adt-route-line',
          type: 'line',
          source: 'adt-route',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#0b5cd5', 'line-width': 5, 'line-opacity': 0.85 },
        });
      }

      if (stops.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        stops.forEach((stop) => bounds.extend([stop.longitude, stop.latitude]));
        map.fitBounds(bounds, { padding: large ? 80 : 48, maxZoom: 13, duration: 0 });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loaded, stops, route, large]);

  // Selection → highlight marker and show its popup.
  useEffect(() => {
    const map = mapRef.current;
    markersRef.current.forEach(({ element }, id) => element.classList.toggle('adt-marker--selected', id === selectedId));
    popupRef.current?.remove();
    if (!map || !loaded || !selectedId) return;
    const stop = stops.find((candidate) => candidate.appointmentId === selectedId);
    const appointment = appointments.find((candidate) => candidate.id === selectedId);
    if (!stop) return;

    let cancelled = false;
    void import('maplibre-gl').then((mapboxgl) => {
      if (cancelled) return;
      const content = document.createElement('div');
      content.className = 'adt-popup';
      const add = (tag: string, className: string, text: string) => {
        const el = document.createElement(tag);
        el.className = className;
        el.textContent = text;
        content.appendChild(el);
        return el;
      };
      add('p', 'adt-popup-num', `${stop.order}. ${stop.appointmentNumber ?? 'Appointment'}`);
      add('p', 'adt-popup-customer', appointment?.customerName ?? 'Customer unavailable');
      add('p', 'adt-popup-line', formatWindow(stop.scheduledStart, stop.scheduledEnd, timezone));
      if (appointment?.subject) add('p', 'adt-popup-line', appointment.subject);
      add('p', 'adt-popup-line adt-popup-muted', (appointment && formatAddress(appointment.address)) ?? stop.label);
      const actions = document.createElement('div');
      actions.className = 'adt-popup-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'adt-btn adt-btn--primary adt-btn--sm';
      open.textContent = 'Open job';
      open.addEventListener('click', () => handlers.current.onOpenJob(stop.appointmentId));
      const directions = document.createElement('a');
      directions.className = 'adt-btn adt-btn--ghost adt-btn--sm';
      directions.href = directionsUrl(stop);
      directions.target = '_blank';
      directions.rel = 'noopener noreferrer';
      directions.textContent = 'Get directions';
      actions.append(open, directions);
      content.appendChild(actions);

      popupRef.current = new mapboxgl.Popup({ offset: 22, closeButton: true, maxWidth: '280px' })
        .setLngLat([stop.longitude, stop.latitude])
        .setDOMContent(content)
        .addTo(map);
      map.easeTo({ center: [stop.longitude, stop.latitude], duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 500 });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, loaded, stops, appointments, timezone]);


  return (
    <div className={`adt-map${large ? ' adt-map--large' : ''}`}>
      <div ref={containerRef} className="adt-map-canvas" aria-label="Map of today's appointment stops" role="region" />
      {!loaded && !mapError ? <div className="adt-map-overlay">Loading map…</div> : null}
      {mapError ? <div className="adt-map-overlay adt-map-overlay--error">{mapError}</div> : null}
      {loaded && !routeLoading && stops.length === 0 ? (
        <div className="adt-map-overlay adt-map-overlay--soft">No appointment locations to plot.</div>
      ) : null}
    </div>
  );
}
