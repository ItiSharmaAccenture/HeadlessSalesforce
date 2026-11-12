'use client';

/**
 * Account summary drawer, opened from an appointment card.
 *
 * Two tabs over `/api/appointments/[id]/account`: the property details held on
 * Property_Detail__c, and the account's contacts.
 *
 * Everything shown comes from Salesforce. Rows and tiles whose field came back
 * empty are left out entirely rather than rendered as a dash, so the panel
 * never implies the org holds something it does not — the same reason there is
 * no access-notes or emergency-contact row: no such field exists.
 */

import { Building2, Home, Mail, MapPin, Phone, ShieldCheck, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import type { AccountProperty, AccountSummaryResult } from '@/types/dashboard';
import Drawer from './Drawer';
import { formatAddress } from './format';
import { Skeleton, UnavailableNotice } from './Notice';

const TABS = [
  { id: 'summary', label: 'Account summary', icon: <Home size={15} aria-hidden="true" /> },
  { id: 'contacts', label: 'Contacts and access', icon: <Users size={15} aria-hidden="true" /> },
] as const;

type Tab = (typeof TABS)[number]['id'];

interface AccountPanelProps {
  /** The appointment whose account to show; null closes the drawer. */
  appointmentId: string | null;
  onClose: () => void;
}

/** One stat tile. Rendered only when the field had a value. */
function Tile({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="adt-acct-tile">
      <span className="adt-acct-tile-head">
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

/** Tiles for the fields this property actually has. */
function propertyTiles(property: AccountProperty): ReactNode[] {
  const tiles: ReactNode[] = [];

  if (property.sizeSqFt !== null) {
    tiles.push(<Tile key="size" icon={<Home size={14} aria-hidden="true" />} label="Size" value={`${property.sizeSqFt.toLocaleString()} sq ft`} />);
  }
  if (property.bedrooms !== null || property.bathrooms !== null) {
    tiles.push(
      <Tile
        key="beds"
        icon={<Building2 size={14} aria-hidden="true" />}
        label={property.bedrooms !== null && property.bathrooms !== null ? 'Beds / baths' : property.bedrooms !== null ? 'Bedrooms' : 'Bathrooms'}
        value={[property.bedrooms, property.bathrooms].filter((count) => count !== null).join(' / ')}
      />,
    );
  }
  if (property.yearBuilt !== null) {
    tiles.push(<Tile key="year" icon={<Building2 size={14} aria-hidden="true" />} label="Year built" value={String(property.yearBuilt)} />);
  }
  if (property.propertyType) {
    tiles.push(<Tile key="type" icon={<Home size={14} aria-hidden="true" />} label="Type" value={property.propertyType} />);
  }
  if (property.securitySystemBase) {
    tiles.push(<Tile key="base" icon={<ShieldCheck size={14} aria-hidden="true" />} label="Base" value={property.securitySystemBase} />);
  }
  if (property.monitoringStatus) {
    tiles.push(<Tile key="monitoring" icon={<ShieldCheck size={14} aria-hidden="true" />} label="Monitoring" value={property.monitoringStatus} />);
  }

  return tiles;
}

export default function AccountPanel({ appointmentId, onClose }: AccountPanelProps) {
  const [tab, setTab] = useState<Tab>('summary');
  const [state, setState] = useState<{ id: string; data: AccountSummaryResult | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!appointmentId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per appointment before fetching
    setState({ id: appointmentId, data: null, error: null });
    setTab('summary');
    fetch(`/api/appointments/${encodeURIComponent(appointmentId)}/account`, { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as AccountSummaryResult | { error?: string } | null;
        if (cancelled) return;
        if (body && 'status' in body) setState({ id: appointmentId, data: body, error: null });
        else setState({ id: appointmentId, data: null, error: (body as { error?: string } | null)?.error ?? `Request failed (HTTP ${response.status}).` });
      })
      .catch(() => !cancelled && setState({ id: appointmentId, data: null, error: 'Could not reach the server.' }));
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  const data = state?.id === appointmentId ? state.data : null;
  const ok = data?.status === 'ok' ? data : null;
  const address = ok ? formatAddress(ok.address) : null;

  return (
    <Drawer
      open={Boolean(appointmentId)}
      onClose={onClose}
      size="lg"
      icon={<Building2 size={22} />}
      title={ok?.accountName ?? 'Account summary'}
      subtitle={address ?? undefined}
    >
      <div className="adt-tabs" role="tablist" aria-label="Account sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`adt-acct-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`adt-acct-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const index = TABS.findIndex((candidate) => candidate.id === tab);
              const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
              setTab(next.id);
              document.getElementById(`adt-acct-tab-${next.id}`)?.focus();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="adt-tabpanel" role="tabpanel" id={`adt-acct-panel-${tab}`} aria-labelledby={`adt-acct-tab-${tab}`}>
        {state?.error ? <UnavailableNotice state={{ status: 'unavailable', code: 'salesforce_error', message: state.error }} /> : null}
        {!state?.error && !data ? <Skeleton lines={5} /> : null}
        {data?.status === 'unavailable' ? <UnavailableNotice state={data} /> : null}

        {ok && tab === 'summary' ? (
          ok.properties.status === 'unavailable' ? (
            <UnavailableNotice state={ok.properties} />
          ) : ok.properties.data.length === 0 ? (
            <p className="adt-muted">No property details are recorded for this account in Salesforce.</p>
          ) : (
            ok.properties.data.map((property) => {
              const tiles = propertyTiles(property);
              return (
                <section key={property.id} className="adt-acct-prop">
                  {ok.properties.status === 'ok' && ok.properties.data.length > 1 && property.name ? <h3>{property.name}</h3> : null}
                  {tiles.length > 0 ? (
                    <div className="adt-acct-tiles">{tiles}</div>
                  ) : (
                    <p className="adt-muted">This property record has no details filled in.</p>
                  )}
                </section>
              );
            })
          )
        ) : null}

        {ok && tab === 'contacts' ? (
          ok.contacts.status === 'unavailable' ? (
            <UnavailableNotice state={ok.contacts} />
          ) : ok.contacts.data.length === 0 ? (
            <p className="adt-muted">No contacts are recorded for this account in Salesforce.</p>
          ) : (
            <>
              {ok.contacts.data.map((contact) => (
                <section key={contact.id} className="adt-acct-contact">
                  <dl className="adt-dl">
                    {contact.name ? (
                      <>
                        <dt>{contact.primary ? 'Primary' : 'Contact'}</dt>
                        <dd>
                          {contact.name}
                          {contact.title ? <span className="adt-acct-title"> · {contact.title}</span> : null}
                        </dd>
                      </>
                    ) : null}
                    {contact.phone ? (
                      <>
                        <dt>Phone</dt>
                        <dd>
                          <a href={`tel:${contact.phone}`}>{contact.phone}</a>
                        </dd>
                      </>
                    ) : null}
                    {contact.mobilePhone ? (
                      <>
                        <dt>Mobile</dt>
                        <dd>
                          <a href={`tel:${contact.mobilePhone}`}>{contact.mobilePhone}</a>
                        </dd>
                      </>
                    ) : null}
                    {contact.email ? (
                      <>
                        <dt>Email</dt>
                        <dd>
                          <a href={`mailto:${contact.email}`}>{contact.email}</a>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </section>
              ))}
              {address ? (
                <dl className="adt-dl">
                  <dt>Address</dt>
                  <dd>{address}</dd>
                </dl>
              ) : null}
            </>
          )
        ) : null}
      </div>

      {ok && tab === 'contacts' && ok.contacts.status === 'ok' ? (
        <div className="adt-acct-actions">
          {ok.contacts.data.find((contact) => contact.phone ?? contact.mobilePhone) ? (
            <a
              className="adt-btn adt-btn--ghost"
              href={`tel:${ok.contacts.data.find((contact) => contact.phone ?? contact.mobilePhone)?.phone ?? ok.contacts.data.find((contact) => contact.mobilePhone)?.mobilePhone}`}
            >
              <Phone size={16} aria-hidden="true" /> Call customer
            </a>
          ) : null}
          {address ? (
            <a className="adt-btn adt-btn--ghost" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`} target="_blank" rel="noreferrer">
              <MapPin size={16} aria-hidden="true" /> Directions
            </a>
          ) : null}
          {ok.contacts.data.some((contact) => contact.email) ? (
            <a className="adt-btn adt-btn--ghost" href={`mailto:${ok.contacts.data.find((contact) => contact.email)?.email}`}>
              <Mail size={16} aria-hidden="true" /> Email
            </a>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
