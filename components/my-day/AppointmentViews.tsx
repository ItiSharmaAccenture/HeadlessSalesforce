import { useEffect, useRef, type Ref } from 'react';

import {
  CONFIRM_ACTIONS,
  STATUS_ACTION_LABELS,
  type Appointment,
  type AppointmentDetailResponse,
  type StatusAction,
} from '@/types/copilot';
import { directionsUrl, formatClock, formatFieldValue, mapsSearchUrl, statusTone } from './format';
import {
  AlertIcon,
  BackIcon,
  ClockIcon,
  CustomerIcon,
  DetailsIcon,
  DirectionsIcon,
  ExternalIcon,
  PinIcon,
  RetryIcon,
  StatusIcon,
} from './icons';

export interface ActionState {
  busy?: StatusAction;
  confirm?: StatusAction;
  error?: { message: string; retryable: boolean; action: StatusAction };
}

export interface DetailState {
  number: string;
  loading: boolean;
  data: AppointmentDetailResponse | null;
  /** Last copy the chat already holds, shown while the live read runs. */
  snapshot: Appointment | null;
  error: { message: string; retryable: boolean } | null;
  fetchedAt?: number;
}

interface ActionHandlers {
  onAction: (number: string, action: StatusAction, confirmed?: boolean) => void;
  onCancelConfirm: (number: string) => void;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

export function StatusPill({ status }: { status?: string }) {
  if (!status) return null;
  return <span className={`cp-pill cp-pill--${statusTone(status)}`}>{status}</span>;
}

/** The next step a card offers, given the status and what the org supports. */
function primaryAction(status: string | undefined, actions: StatusAction[]): StatusAction | null {
  const tone = statusTone(status);
  if (tone === 'done' || tone === 'stopped' || tone === 'progress') return null;
  if (tone === 'travel') return actions.includes('start') ? 'start' : null;
  if (actions.includes('on_my_way')) return 'on_my_way';
  return actions.includes('start') ? 'start' : null;
}

function confirmQuestion(number: string, action: StatusAction): string {
  switch (action) {
    case 'complete':
      return `Mark ${number} as completed?`;
    case 'cannot_complete':
      return `Mark ${number} as Cannot Complete?`;
    case 'cancel':
      return `Cancel ${number}?`;
    default:
      return `${STATUS_ACTION_LABELS[action]} for ${number}?`;
  }
}

function ConfirmBox({ number, action, onAction, onCancelConfirm }: { number: string; action: StatusAction } & ActionHandlers) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <div className="cp-confirm" role="group" aria-label={`Confirm: ${confirmQuestion(number, action)}`}>
      <p className="cp-confirm-text">
        {confirmQuestion(number, action)} <span>This updates Salesforce.</span>
      </p>
      <div className="cp-confirm-actions">
        <button type="button" className="cp-btn" onClick={() => onCancelConfirm(number)}>
          Not now
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={`cp-btn ${action === 'complete' ? 'cp-btn--primary' : 'cp-btn--danger'}`}
          onClick={() => onAction(number, action, true)}
        >
          Yes, {STATUS_ACTION_LABELS[action].toLowerCase()}
        </button>
      </div>
    </div>
  );
}

function ActionFeedback({ number, state, ...handlers }: { number: string; state?: ActionState } & ActionHandlers) {
  if (!state) return null;

  if (state.confirm) return <ConfirmBox number={number} action={state.confirm} {...handlers} />;

  if (state.busy) {
    return (
      <p className="cp-appt-note" role="status">
        <span className="cp-spinner" aria-hidden="true" /> Updating {number} in Salesforce…
      </p>
    );
  }

  if (state.error) {
    const { message, retryable, action } = state.error;
    return (
      <div className="cp-inline-error" role="alert">
        <AlertIcon />
        <p>{message}</p>
        {retryable && (
          <button type="button" className="cp-btn cp-btn--small" onClick={() => handlers.onAction(number, action, true)}>
            <RetryIcon />
            Try again
          </button>
        )}
      </div>
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

interface CardProps extends ActionHandlers {
  appointment: Appointment;
  actions: StatusAction[];
  state?: ActionState;
  onOpen: (number: string) => void;
}

export function AppointmentCard({ appointment, actions, state, onOpen, ...handlers }: CardProps) {
  const number = appointment.appointmentNumber;
  const primary = primaryAction(appointment.status, actions);
  const when = [appointment.appointmentDate, appointment.scheduledWindow].filter(Boolean).join(' · ');

  return (
    <article className="cp-appt" aria-label={`Appointment ${number}`}>
      <div className="cp-appt-top">
        <button type="button" className="cp-appt-num" onClick={() => onOpen(number)} aria-label={`${number}, open appointment details`}>
          {number}
        </button>
        <StatusPill status={appointment.status} />
      </div>
      {appointment.subject && <p className="cp-appt-subject">{appointment.subject}</p>}

      <ul className="cp-appt-facts">
        {when && (
          <li>
            <ClockIcon />
            <span>
              <span className="cp-sr">Time: </span>
              {when}
            </span>
          </li>
        )}
        {appointment.accountName && (
          <li>
            <CustomerIcon />
            <span>
              <span className="cp-sr">Customer: </span>
              {appointment.accountName}
            </span>
          </li>
        )}
        {appointment.address && (
          <li>
            <PinIcon />
            <a className="cp-link" href={mapsSearchUrl(appointment.address)} target="_blank" rel="noopener noreferrer">
              <span className="cp-sr">Address: </span>
              {appointment.address}
              <span className="cp-sr"> (opens Google Maps in a new tab)</span>
            </a>
          </li>
        )}
      </ul>

      <div className="cp-appt-actions">
        <button type="button" className="cp-btn" onClick={() => onOpen(number)}>
          <DetailsIcon />
          View details
          <span className="cp-sr"> for {number}</span>
        </button>
        {primary && (
          <button
            type="button"
            className="cp-btn cp-btn--primary"
            disabled={Boolean(state?.busy)}
            onClick={() => handlers.onAction(number, primary)}
          >
            <StatusIcon />
            {STATUS_ACTION_LABELS[primary]}
            <span className="cp-sr"> for {number}</span>
          </button>
        )}
        {appointment.address && (
          <a className="cp-btn" href={directionsUrl(appointment.address)} target="_blank" rel="noopener noreferrer">
            <DirectionsIcon />
            Directions
            <span className="cp-sr"> to {number} (opens Google Maps in a new tab)</span>
          </a>
        )}
      </div>

      <ActionFeedback number={number} state={state} {...handlers} />
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Detail view                                                         */
/* ------------------------------------------------------------------ */

const FIELD_ORDER = [
  'appointmentNumber',
  'status',
  'subject',
  'accountName',
  'address',
  'appointmentDate',
  'scheduledWindow',
  'arrivalWindow',
  'schedStartTime',
  'schedEndTime',
  'arrivalWindowStartTime',
  'arrivalWindowEndTime',
  'actualStart',
  'actualEnd',
  'actualStartTime',
  'actualEndTime',
  'description',
  'parentRecordName',
  'ownerName',
  'appointmentId',
];

const FIELD_LABELS: Record<string, string> = {
  appointmentNumber: 'Appointment',
  status: 'Status',
  subject: 'Subject',
  accountName: 'Customer',
  address: 'Address',
  appointmentDate: 'Date',
  scheduledWindow: 'Scheduled window',
  arrivalWindow: 'Arrival window',
  schedStartTime: 'Scheduled start',
  schedEndTime: 'Scheduled end',
  arrivalWindowStartTime: 'Arrival window start',
  arrivalWindowEndTime: 'Arrival window end',
  actualStart: 'Actual start',
  actualEnd: 'Actual end',
  actualStartTime: 'Actual start time',
  actualEndTime: 'Actual end time',
  description: 'Description',
  parentRecordName: 'Work order',
  ownerName: 'Technician',
  appointmentId: 'Record ID',
};

function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());
}

function orderedFields(appointment: Appointment): [string, string][] {
  const entries = Object.entries(appointment).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const rank = (key: string) => {
    const index = FIELD_ORDER.indexOf(key);
    return index === -1 ? FIELD_ORDER.length : index;
  };
  return entries.sort(([a], [b]) => rank(a) - rank(b));
}

interface DetailProps extends ActionHandlers {
  detail: DetailState;
  actions: StatusAction[];
  state?: ActionState;
  titleId: string;
  backRef: Ref<HTMLButtonElement>;
  onBack: () => void;
  onRetry: () => void;
}

export function AppointmentDetail({ detail, actions, state, titleId, backRef, onBack, onRetry, ...handlers }: DetailProps) {
  const appointment = detail.data?.appointment ?? detail.snapshot;
  const timeZone = detail.data?.meta.timeZone;
  const tone = statusTone(appointment?.status);
  const statusActions = actions.filter((action) => {
    if (tone === 'done' || tone === 'stopped') return false;
    if (action === 'on_my_way') return tone === 'scheduled' || tone === 'neutral';
    if (action === 'start') return tone !== 'progress';
    return true;
  });

  let source: string | null = null;
  if (detail.loading) source = 'Loading live details from Salesforce…';
  else if (detail.data?.live && detail.fetchedAt) source = `Live from Salesforce · ${formatClock(detail.fetchedAt)}`;
  else if (detail.data?.note) source = detail.data.note;

  return (
    <section className="cp-detail" aria-labelledby={titleId}>
      <div className="cp-detail-bar">
        <button ref={backRef} type="button" className="cp-icon-btn cp-icon-btn--ink" onClick={onBack} aria-label="Back to chat">
          <BackIcon />
        </button>
        <h3 id={titleId} className="cp-detail-title">
          {detail.number}
        </h3>
        <StatusPill status={appointment?.status} />
      </div>

      <div className="cp-detail-body">
        {source && (
          <p className={`cp-source${detail.data && !detail.data.live ? ' cp-source--stale' : ''}`} role="status">
            {detail.loading && <span className="cp-spinner" aria-hidden="true" />}
            {source}
          </p>
        )}

        {detail.error && (
          <div className="cp-inline-error" role="alert">
            <AlertIcon />
            <p>{detail.error.message}</p>
            {detail.error.retryable && (
              <button type="button" className="cp-btn cp-btn--small" onClick={onRetry}>
                <RetryIcon />
                Try again
              </button>
            )}
          </div>
        )}

        {appointment && (
          <>
            {appointment.subject && <p className="cp-detail-subject">{appointment.subject}</p>}

            <div className="cp-appt-actions">
              {appointment.address && (
                <a className="cp-btn" href={directionsUrl(appointment.address)} target="_blank" rel="noopener noreferrer">
                  <DirectionsIcon />
                  Directions
                  <span className="cp-sr"> (opens Google Maps in a new tab)</span>
                </a>
              )}
              {detail.data?.salesforceUrl && (
                <a className="cp-btn" href={detail.data.salesforceUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalIcon />
                  Open in Salesforce
                  <span className="cp-sr"> (opens in a new tab)</span>
                </a>
              )}
              {statusActions.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`cp-btn ${CONFIRM_ACTIONS.includes(action) && action !== 'complete' ? 'cp-btn--danger-outline' : 'cp-btn--primary'}`}
                  disabled={Boolean(state?.busy) || detail.loading}
                  onClick={() => handlers.onAction(detail.number, action)}
                >
                  <StatusIcon />
                  {STATUS_ACTION_LABELS[action]}
                </button>
              ))}
            </div>

            <ActionFeedback number={detail.number} state={state} {...handlers} />

            <dl className="cp-fields">
              {orderedFields(appointment).map(([key, value]) => (
                <div key={key} className="cp-field">
                  <dt>{labelFor(key)}</dt>
                  <dd>
                    {key === 'address' ? (
                      <a className="cp-link" href={mapsSearchUrl(value)} target="_blank" rel="noopener noreferrer">
                        {value}
                        <span className="cp-sr"> (opens Google Maps in a new tab)</span>
                      </a>
                    ) : key === 'status' ? (
                      <StatusPill status={value} />
                    ) : (
                      formatFieldValue(value, timeZone)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  );
}
