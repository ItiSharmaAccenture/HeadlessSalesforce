'use client';

/**
 * Appointment workspace: Overview, Parts, Inventory, Upsell, Completion.
 *
 * Overview, Parts and Inventory are read directly from Salesforce REST
 * (GET /api/appointments/[id], which first checks the job is assigned to
 * you). Upsell and Completion run through ADT Copilot, which uses the existing
 * MCP tools; any status change still needs the technician's confirmation on
 * the Copilot card. No product image is shown unless it is a real match, and
 * none are bundled yet, so products are listed by name.
 */

import { Boxes, Briefcase, ClipboardCheck, ExternalLink, Package, Sparkles, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AppointmentWorkspaceResult, Section } from '@/types/dashboard';
import Drawer from './Drawer';
import { formatAddress, formatLongDate, formatWindow, localDateOf } from './format';
import { Skeleton, UnavailableNotice } from './Notice';
import { StatusChip } from './Timeline';

type Tab = 'overview' | 'parts' | 'inventory' | 'upsell' | 'completion';

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Briefcase size={16} /> },
  { id: 'parts', label: 'Parts', icon: <Package size={16} /> },
  { id: 'inventory', label: 'Inventory', icon: <Boxes size={16} /> },
  { id: 'upsell', label: 'Upsell', icon: <Tag size={16} /> },
  { id: 'completion', label: 'Completion', icon: <ClipboardCheck size={16} /> },
];

interface JobWorkspaceProps {
  appointmentId: string | null;
  timezone: string;
  onClose: () => void;
  onAskCopilot: (prompt: string) => void;
}

function SectionBody<T>({ section, empty, children }: { section: Section<T>; empty?: string; children: (data: T) => React.ReactNode }) {
  if (section.status === 'unavailable') return <UnavailableNotice state={section} />;
  const data = section.data;
  if (empty && (data === null || (Array.isArray(data) && data.length === 0))) return <p className="adt-muted">{empty}</p>;
  return <>{children(data)}</>;
}

export default function JobWorkspace({ appointmentId, timezone, onClose, onAskCopilot }: JobWorkspaceProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [state, setState] = useState<{ id: string; data: AppointmentWorkspaceResult | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!appointmentId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per appointment before fetching
    setState({ id: appointmentId, data: null, error: null });
    setTab('overview');
    fetch(`/api/appointments/${encodeURIComponent(appointmentId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as AppointmentWorkspaceResult | { error?: string } | null;
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
  const appointment = ok?.appointment;
  const address = appointment ? formatAddress(appointment.address) : null;

  return (
    <Drawer
      open={Boolean(appointmentId)}
      onClose={onClose}
      size="lg"
      icon={<Briefcase size={22} />}
      title={appointment ? `${appointment.appointmentNumber ?? 'Appointment'} · ${appointment.subject ?? 'No subject'}` : 'Job workspace'}
      subtitle={
        appointment?.scheduledStart
          ? `${formatLongDate(localDateOf(appointment.scheduledStart, timezone))} · ${formatWindow(appointment.scheduledStart, appointment.scheduledEnd, timezone)}`
          : undefined
      }
    >
      <div className="adt-tabs" role="tablist" aria-label="Job sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`adt-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`adt-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              const index = TABS.findIndex((candidate) => candidate.id === tab);
              const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
              setTab(next.id);
              document.getElementById(`adt-tab-${next.id}`)?.focus();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="adt-tabpanel" role="tabpanel" id={`adt-panel-${tab}`} aria-labelledby={`adt-tab-${tab}`}>
        {state?.error ? <UnavailableNotice state={{ status: 'unavailable', code: 'salesforce_error', message: state.error }} /> : null}
        {!state?.error && !data ? <Skeleton lines={6} /> : null}
        {data?.status === 'unavailable' ? <UnavailableNotice state={data} /> : null}

        {ok && appointment && tab === 'overview' ? (
          <div className="adt-ws-grid">
            <div className="adt-ws-block">
              <h3>Appointment</h3>
              <dl className="adt-dl">
                <dt>Status</dt>
                <dd>
                  <StatusChip status={appointment.status} />
                </dd>
                <dt>Work type</dt>
                <dd>{appointment.workType ?? '—'}</dd>
                <dt>Arrival window</dt>
                <dd>{appointment.arrivalWindowStart ? formatWindow(appointment.arrivalWindowStart, appointment.arrivalWindowEnd, timezone) : '—'}</dd>
                <dt>Address</dt>
                <dd>
                  {address ?? 'Address unavailable'}
                  {address ? (
                    <a
                      className="adt-link"
                      href={`https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(address)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Directions <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  ) : null}
                </dd>
              </dl>
              {appointment.description ? <p className="adt-ws-desc">{appointment.description}</p> : null}
            </div>
            <div className="adt-ws-block">
              <h3>Customer</h3>
              <SectionBody section={ok.customer}>
                {(customer) => (
                  <dl className="adt-dl">
                    <dt>Account</dt>
                    <dd>{customer.accountName ?? '—'}</dd>
                    <dt>Account phone</dt>
                    <dd>{customer.accountPhone ? <a href={`tel:${customer.accountPhone}`}>{customer.accountPhone}</a> : '—'}</dd>
                    <dt>Contact</dt>
                    <dd>{customer.contactName ?? '—'}</dd>
                    <dt>Contact phone</dt>
                    <dd>{customer.contactPhone ? <a href={`tel:${customer.contactPhone}`}>{customer.contactPhone}</a> : '—'}</dd>
                  </dl>
                )}
              </SectionBody>
            </div>
            <div className="adt-ws-block adt-ws-block--wide">
              <h3>Work order</h3>
              <SectionBody section={ok.workOrder} empty="This appointment is not linked to a work order.">
                {(workOrder) =>
                  workOrder ? (
                    <dl className="adt-dl">
                      <dt>Number</dt>
                      <dd>{workOrder.number ?? '—'}</dd>
                      <dt>Subject</dt>
                      <dd>{workOrder.subject ?? '—'}</dd>
                      <dt>Status</dt>
                      <dd>{workOrder.status ?? '—'}</dd>
                      <dt>Priority</dt>
                      <dd>{workOrder.priority ?? '—'}</dd>
                    </dl>
                  ) : null
                }
              </SectionBody>
            </div>
          </div>
        ) : null}

        {ok && tab === 'parts' ? (
          <div className="adt-ws-stack">
            <div className="adt-ws-block">
              <h3>Required parts</h3>
              <SectionBody section={ok.parts} empty="No required parts are recorded on the work order.">
                {(parts) => (
                  <table className="adt-table">
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col">Qty required</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parts.map((part, index) => (
                        <tr key={`${part.productId}-${index}`}>
                          <td>{part.productName ?? 'Unnamed product'}</td>
                          <td>
                            {part.quantityRequired ?? '—'} {part.unit ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionBody>
            </div>
            <div className="adt-ws-block">
              <h3>Work order line items</h3>
              <SectionBody section={ok.lineItems} empty="No line items on the work order.">
                {(items) => (
                  <table className="adt-table">
                    <thead>
                      <tr>
                        <th scope="col">Line</th>
                        <th scope="col">Product</th>
                        <th scope="col">Qty</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => (
                        <tr key={`${item.lineItemNumber}-${index}`}>
                          <td>{item.lineItemNumber ?? '—'}</td>
                          <td>{item.productName ?? '—'}</td>
                          <td>{item.quantity ?? '—'}</td>
                          <td>{item.status ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionBody>
            </div>
            <button type="button" className="adt-btn adt-btn--ghost" onClick={() => onAskCopilot('Check required parts')}>
              <Sparkles size={15} aria-hidden="true" /> Ask Copilot about parts
            </button>
          </div>
        ) : null}

        {ok && tab === 'inventory' ? (
          <div className="adt-ws-stack">
            <div className="adt-ws-block">
              <h3>Van stock vs. required</h3>
              <SectionBody section={ok.inventory} empty="No required parts to check.">
                {(rows) => (
                  <table className="adt-table">
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col">Required</th>
                        <th scope="col">On hand</th>
                        <th scope="col">Missing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={`${row.productId}-${index}`} className={row.missing > 0 ? 'is-missing' : undefined}>
                          <td>{row.productName ?? '—'}</td>
                          <td>{row.required ?? '—'}</td>
                          <td>{row.onHand}</td>
                          <td>{row.missing > 0 ? <strong>{row.missing}</strong> : '0'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionBody>
            </div>
            <button type="button" className="adt-btn adt-btn--ghost" onClick={() => onAskCopilot('Find missing inventory')}>
              <Sparkles size={15} aria-hidden="true" /> Ask Copilot who has missing parts
            </button>
          </div>
        ) : null}

        {ok && tab === 'upsell' ? (
          <div className="adt-ws-block">
            <h3>Upsell recommendations</h3>
            <p className="adt-muted">
              Recommendations come from Salesforce through ADT Copilot (the Suggested Category on products). Quote changes are only made after the customer
              confirms and you approve them.
            </p>
            <button type="button" className="adt-btn adt-btn--primary" onClick={() => onAskCopilot('Recommend upsell products')}>
              <Sparkles size={15} aria-hidden="true" /> Recommend upsell products
            </button>
          </div>
        ) : null}

        {ok && tab === 'completion' ? (
          <div className="adt-ws-block">
            <h3>Guided closure</h3>
            <p className="adt-muted">
              Copilot drafts a job summary from Salesforce data. Closing the appointment always needs your explicit confirmation on the Copilot appointment card.
            </p>
            <button type="button" className="adt-btn adt-btn--primary" onClick={() => onAskCopilot('Prepare job closure')}>
              <ClipboardCheck size={15} aria-hidden="true" /> Prepare job closure
            </button>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
