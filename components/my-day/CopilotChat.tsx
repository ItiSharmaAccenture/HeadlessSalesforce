'use client';

/**
 * ADT Copilot: the chat window behind "Chat with ADT Copilot" on /my-day.
 *
 * Renders the launcher button in place and the panel through a portal on
 * <body>: the page root is a size container, which would otherwise become the
 * containing block for the panel's `position: fixed`.
 *
 * The conversation lives in sessionStorage, so closing the panel (or reloading
 * the tab) keeps it for the browser session. All Salesforce access goes through
 * /api/copilot; nothing here sees a credential.
 */

import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { createEventParser } from '@/lib/stream';
import {
  CONFIRM_ACTIONS,
  type Appointment,
  type AppointmentDetailResponse,
  type CopilotCapabilities,
  type CopilotErrorBody,
  type CopilotEvent,
  type StatusAction,
  type StatusUpdateResponse,
} from '@/types/copilot';
import { AppointmentCard, AppointmentDetail, type ActionState, type DetailState } from './AppointmentViews';
import { formatClock } from './format';
import { AlertIcon, ChatIcon, CloseIcon, ExpandIcon, MinimiseIcon, RetryIcon, SendIcon } from './icons';
import { MessageText } from './MessageText';
import './copilot.css';

const STORAGE_KEY = 'adt-copilot:v1';
const WEEK_PROMPT = "What's my schedule this week?";
const STARTERS = ["What's my schedule today?", WEEK_PROMPT, "What's my next appointment?", "I'm on my way"];
const MAX_HISTORY = 12;
const OFFLINE_MESSAGE = "Couldn't reach ADT Copilot. Check your connection and try again.";
const LOGO = '/assets/my-day/adt-logo.png';

type View = 'closed' | 'open' | 'minimised';
type Connection = 'connecting' | 'online' | 'offline';
type Failure = { message: string; retryable: boolean };

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /** Appointment cards under an assistant reply, in the order the reply mentions them. */
  cards?: string[];
  /** The reply looked appointments up and none matched: offer the week instead. */
  offerWeek?: boolean;
  pending?: boolean;
  progress?: string;
  error?: Failure;
  /** The user message this reply answers; "Try again" resends it. */
  retryText?: string;
  /** Local confirmation of a status change; not part of the history sent to Gemini. */
  notice?: boolean;
}

interface Conversation {
  turns: Turn[];
  /** Latest copy of every appointment seen, so all cards for one number stay in step. */
  appointments: Record<string, Appointment>;
}

class ApiFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

const noopSubscribe = () => () => {};

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function loadConversation(): Conversation {
  const empty: Conversation = { turns: [], appointments: {} };
  if (typeof window === 'undefined') return empty;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Conversation | null;
    if (!stored || !Array.isArray(stored.turns)) return empty;
    // A reply that was still streaming when the tab unloaded never finished.
    const turns = stored.turns.map((turn) =>
      turn.pending
        ? { ...turn, pending: false, progress: undefined, error: { message: 'This reply was interrupted.', retryable: Boolean(turn.retryText) } }
        : turn,
    );
    return { turns, appointments: stored.appointments ?? {} };
  } catch {
    return empty;
  }
}

function mentionedNumbers(text: string): string[] {
  return [...new Set([...text.matchAll(/\bSA-\d{1,10}\b/g)].map((match) => match[0]))];
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

async function readFailure(response: Response): Promise<ApiFailure> {
  const body = (await response.json().catch(() => null)) as CopilotErrorBody | null;
  return new ApiFailure(body?.error ?? `ADT Copilot returned an error (HTTP ${response.status}).`, body?.retryable ?? true);
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface Props {
  firstName: string;
  /** next/font variable class, so the portal gets Plus Jakarta Sans too. */
  fontClassName: string;
}

export default function CopilotChat({ firstName, fontClassName }: Props) {
  const [view, setView] = useState<View>('closed');
  const [conversation, setConversation] = useState<Conversation>(loadConversation);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [actions, setActions] = useState<StatusAction[]>([]);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');

  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const browserOnline = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  const panelId = useId();
  const titleId = useId();
  const detailTitleId = useId();
  const inputId = useId();

  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const conversationRef = useRef(conversation);
  const busyRef = useRef(false);
  const capabilitiesRequested = useRef(false);

  const status: Connection = browserOnline ? connection : 'offline';
  const detailNumber = detail?.number ?? null;

  /* ---- Effects: persistence, focus, scrolling --------------------- */

  useEffect(() => {
    conversationRef.current = conversation;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conversation));
    } catch {
      // Storage can be full or disabled; the conversation still works in memory.
    }
  }, [conversation]);

  useEffect(() => {
    if (view === 'minimised') {
      restoreRef.current?.focus();
      return;
    }
    if (view !== 'open') return;
    // One frame, so the panel is visible (no longer inert) before focusing into it.
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view]);

  useEffect(() => {
    if (detailNumber) backRef.current?.focus();
  }, [detailNumber]);

  useEffect(() => {
    const log = logRef.current;
    if (log && view === 'open' && !detailNumber) log.scrollTop = log.scrollHeight;
  }, [conversation.turns, view, detailNumber]);

  /* ---- Open / close ------------------------------------------------ */

  const loadCapabilities = useCallback(async () => {
    try {
      const response = await fetch('/api/copilot', { cache: 'no-store' });
      if (!response.ok) throw await readFailure(response);
      setActions(((await response.json()) as CopilotCapabilities).actions);
      setConnection('online');
    } catch {
      capabilitiesRequested.current = false;
      setConnection('offline');
    }
  }, []);

  const open = useCallback(() => {
    setView('open');
    if (!capabilitiesRequested.current) {
      capabilitiesRequested.current = true;
      void loadCapabilities();
    }
  }, [loadCapabilities]);

  const close = useCallback(() => {
    setView('closed');
    setActionStates((states) =>
      Object.fromEntries(Object.entries(states).filter(([, state]) => !state.confirm)),
    );
    launcherRef.current?.focus();
  }, []);

  /* ---- Chat -------------------------------------------------------- */

  const send = useCallback(async (text: string, retryTurnId?: string) => {
    const message = text.trim();
    if (!message || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const prior = conversationRef.current.turns.filter((turn) => turn.id !== retryTurnId);
    // On a retry the question is already in the transcript; it is resent as the message, not as history.
    const lastUser = retryTurnId ? prior.findLastIndex((turn) => turn.role === 'user' && turn.text === message) : -1;
    const history = (lastUser >= 0 ? prior.slice(0, lastUser) : prior)
      .filter((turn) => !turn.pending && !turn.error && !turn.notice && turn.text.trim())
      .slice(-MAX_HISTORY)
      .map((turn) => ({ role: turn.role, content: turn.text }));

    const reply: Turn = { id: uid(), role: 'assistant', text: '', at: Date.now(), pending: true, progress: 'Thinking…', retryText: message };
    setConversation((current) => ({
      ...current,
      turns: [
        ...current.turns.filter((turn) => turn.id !== retryTurnId),
        ...(retryTurnId ? [] : [{ id: uid(), role: 'user' as const, text: message, at: Date.now() }]),
        reply,
      ],
    }));

    const patch = (update: Partial<Turn>) =>
      setConversation((current) => ({
        ...current,
        turns: current.turns.map((turn) => (turn.id === reply.id ? { ...turn, ...update } : turn)),
      }));

    const outcome: { answer: string; failure: Failure | null; queried: boolean; returned: Set<string> } = {
      answer: '',
      failure: null,
      queried: false,
      returned: new Set(),
    };

    const handle = (event: CopilotEvent) => {
      switch (event.type) {
        case 'progress':
          patch({ progress: event.label });
          break;
        case 'delta':
          outcome.answer += event.text;
          patch({ text: outcome.answer });
          break;
        case 'reset':
          outcome.answer = '';
          patch({ text: '' });
          break;
        case 'appointments':
          outcome.queried = true;
          for (const appointment of event.appointments) outcome.returned.add(appointment.appointmentNumber);
          setConversation((current) => ({
            ...current,
            appointments: {
              ...current.appointments,
              ...Object.fromEntries(event.appointments.map((appointment) => [appointment.appointmentNumber, appointment])),
            },
          }));
          break;
        case 'error':
          outcome.failure = { message: event.message, retryable: event.retryable };
          break;
      }
    };

    try {
      const response = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
      });
      if (!response.ok || !response.body) throw await readFailure(response);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createEventParser<CopilotEvent>();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true })).forEach(handle);
      }
      parser.push(decoder.decode()).forEach(handle);
      parser.end().forEach(handle);
      setConnection('online');
    } catch (error) {
      outcome.failure = error instanceof ApiFailure ? error : { message: OFFLINE_MESSAGE, retryable: true };
      if (!(error instanceof ApiFailure)) setConnection('offline');
    }

    if (!outcome.failure && !outcome.answer.trim()) {
      outcome.failure = { message: 'ADT Copilot did not send an answer.', retryable: true };
    }

    if (outcome.failure) {
      patch({ pending: false, progress: undefined, error: { message: outcome.failure.message, retryable: outcome.failure.retryable }, at: Date.now() });
    } else {
      const cards = mentionedNumbers(outcome.answer).filter((number) => outcome.returned.has(number));
      patch({
        pending: false,
        progress: undefined,
        text: outcome.answer.trim(),
        cards,
        offerWeek: outcome.queried && cards.length === 0 && message !== WEEK_PROMPT,
        at: Date.now(),
      });
    }

    busyRef.current = false;
    setBusy(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) inputRef.current?.focus();
    });
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || busyRef.current) return;
    const text = draft;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = '';
    void send(text);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  /* ---- Appointment detail ----------------------------------------- */

  const loadDetail = useCallback(async (number: string) => {
    setDetail((current) => ({
      number,
      loading: true,
      data: current?.number === number ? current.data : null,
      snapshot: conversationRef.current.appointments[number] ?? null,
      error: null,
      fetchedAt: current?.number === number ? current.fetchedAt : undefined,
    }));

    try {
      const response = await fetch(`/api/copilot/appointments/${encodeURIComponent(number)}`, { cache: 'no-store' });
      if (!response.ok) throw await readFailure(response);
      const data = (await response.json()) as AppointmentDetailResponse;
      setDetail((current) =>
        current?.number === number
          ? { ...current, loading: false, data, snapshot: data.appointment, error: null, fetchedAt: Date.now() }
          : current,
      );
      setConversation((current) => ({ ...current, appointments: { ...current.appointments, [number]: data.appointment } }));
      setConnection('online');
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : { message: OFFLINE_MESSAGE, retryable: true };
      if (!(error instanceof ApiFailure)) setConnection('offline');
      setDetail((current) =>
        current?.number === number
          ? { ...current, loading: false, error: { message: failure.message, retryable: failure.retryable } }
          : current,
      );
    }
  }, []);

  const openDetail = useCallback(
    (number: string) => {
      detailOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void loadDetail(number);
    },
    [loadDetail],
  );

  const closeDetail = () => {
    const opener = detailOpenerRef.current;
    setDetail(null);
    requestAnimationFrame(() => (opener?.isConnected ? opener : inputRef.current)?.focus());
  };

  /* ---- Status changes ---------------------------------------------- */

  const runAction = useCallback(async (number: string, action: StatusAction, confirmed = false) => {
    if (CONFIRM_ACTIONS.includes(action) && !confirmed) {
      setActionStates((states) => ({ ...states, [number]: { confirm: action } }));
      return;
    }

    setActionStates((states) => ({ ...states, [number]: { busy: action } }));
    try {
      const response = await fetch(`/api/copilot/appointments/${encodeURIComponent(number)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw await readFailure(response);
      const result = (await response.json()) as StatusUpdateResponse;

      setConversation((current) => ({
        appointments: { ...current.appointments, [number]: result.appointment },
        turns: [
          ...current.turns,
          {
            id: uid(),
            role: 'assistant',
            text: result.message.includes(number) ? result.message : `${number}: ${result.message}`,
            at: Date.now(),
            notice: true,
          },
        ],
      }));
      setDetail((current) =>
        current?.number === number
          ? { ...current, data: result, snapshot: result.appointment, error: null, fetchedAt: Date.now() }
          : current,
      );
      setActionStates((states) => without(states, number));
      setConnection('online');
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : { message: OFFLINE_MESSAGE, retryable: true };
      if (!(error instanceof ApiFailure)) setConnection('offline');
      setActionStates((states) => ({
        ...states,
        [number]: { error: { message: failure.message, retryable: failure.retryable, action } },
      }));
    }
  }, []);

  const cancelConfirm = useCallback((number: string) => {
    setActionStates((states) => without(states, number));
  }, []);

  /* ---- Keyboard ---------------------------------------------------- */

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      const confirming = Object.entries(actionStates).find(([, state]) => state.confirm);
      if (confirming) cancelConfirm(confirming[0]);
      else close();
      return;
    }

    // Full-screen on mobile, so focus stays inside the sheet there.
    if (event.key === 'Tab' && window.matchMedia('(max-width: 760px)').matches && panelRef.current) {
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  /* ---- Render ------------------------------------------------------ */

  const addresses = Object.values(conversation.appointments)
    .map((appointment) => appointment.address)
    .filter((address): address is string => Boolean(address));

  const statusLabel = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Connecting…';

  const cardHandlers = { onAction: runAction, onCancelConfirm: cancelConfirm };

  const panel = (
    <div className={`copilot ${fontClassName}`}>
      <div
        ref={panelRef}
        id={panelId}
        className="cp-panel"
        data-state={view}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        inert={view !== 'open'}
        onKeyDown={onPanelKeyDown}
      >
        <header className="cp-header">
          <span className="cp-logo-tile">
            <Image className="cp-logo" src={LOGO} alt="" width={34} height={33} />
          </span>
          <div className="cp-heading">
            <h2 id={titleId} className="cp-title">
              ADT Copilot
            </h2>
            <p className={`cp-online cp-online--${status}`}>
              <span className="cp-online-dot" aria-hidden="true" />
              {statusLabel}
            </p>
          </div>
          <div className="cp-header-actions">
            <button type="button" className="cp-icon-btn" onClick={() => setView('minimised')} aria-label="Minimise ADT Copilot">
              <MinimiseIcon />
            </button>
            <button type="button" className="cp-icon-btn" onClick={close} aria-label="Close ADT Copilot">
              <CloseIcon />
            </button>
          </div>
        </header>

        {detail && (
          <AppointmentDetail
            detail={detail}
            actions={actions}
            state={actionStates[detail.number]}
            titleId={detailTitleId}
            backRef={backRef}
            onBack={closeDetail}
            onRetry={() => void loadDetail(detail.number)}
            {...cardHandlers}
          />
        )}

        <div ref={logRef} className="cp-log" role="log" aria-label="Conversation with ADT Copilot" hidden={Boolean(detail)}>
          {conversation.turns.length === 0 && (
            <div className="cp-welcome">
              <Image className="cp-welcome-logo" src={LOGO} alt="" width={56} height={55} />
              <p className="cp-welcome-title">Hi {firstName}, how can I help?</p>
              <p className="cp-welcome-text">I can check your schedule and appointments in Salesforce.</p>
              <div className="cp-chips" role="group" aria-label="Suggested questions">
                {STARTERS.map((prompt) => (
                  <button key={prompt} type="button" className="cp-chip" disabled={busy} onClick={() => void send(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {conversation.turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="cp-row cp-row--user">
                <div className="cp-stack cp-stack--user">
                  <p className="cp-bubble cp-bubble--user">{turn.text}</p>
                  <time className="cp-time" dateTime={new Date(turn.at).toISOString()}>
                    {formatClock(turn.at)}
                  </time>
                </div>
              </div>
            ) : (
              <div key={turn.id} className="cp-row">
                <Image className="cp-avatar" src={LOGO} alt="" width={30} height={29} />
                <div className="cp-stack">
                  {turn.pending && !turn.text ? (
                    <div className="cp-bubble cp-bubble--bot cp-typing" role="status">
                      <span className="cp-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="cp-progress">{turn.progress ?? 'Thinking…'}</span>
                    </div>
                  ) : turn.text ? (
                    <div className="cp-bubble cp-bubble--bot" aria-busy={turn.pending || undefined}>
                      <MessageText text={turn.text} addresses={addresses} onOpenAppointment={openDetail} />
                    </div>
                  ) : null}

                  {turn.error && (
                    <div className="cp-bubble cp-bubble--error" role="alert">
                      <AlertIcon />
                      <p>{turn.error.message}</p>
                      {turn.error.retryable && turn.retryText && (
                        <button
                          type="button"
                          className="cp-btn cp-btn--small"
                          disabled={busy}
                          onClick={() => void send(turn.retryText!, turn.id)}
                        >
                          <RetryIcon />
                          Try again
                        </button>
                      )}
                    </div>
                  )}

                  {turn.cards?.map((number) => {
                    const appointment = conversation.appointments[number];
                    return appointment ? (
                      <AppointmentCard
                        key={number}
                        appointment={appointment}
                        actions={actions}
                        state={actionStates[number]}
                        onOpen={openDetail}
                        {...cardHandlers}
                      />
                    ) : null;
                  })}

                  {turn.offerWeek && (
                    <div className="cp-chips">
                      <button type="button" className="cp-chip" disabled={busy} onClick={() => void send(WEEK_PROMPT)}>
                        {WEEK_PROMPT}
                      </button>
                    </div>
                  )}

                  {!turn.pending && (
                    <time className="cp-time" dateTime={new Date(turn.at).toISOString()}>
                      {formatClock(turn.at)}
                    </time>
                  )}
                </div>
              </div>
            ),
          )}
        </div>

        {!detail && (
          <form className="cp-composer" onSubmit={submit}>
            <label htmlFor={inputId} className="cp-sr">
              Message ADT Copilot
            </label>
            <textarea
              ref={inputRef}
              id={inputId}
              data-autofocus
              className="cp-input"
              rows={1}
              maxLength={4000}
              value={draft}
              disabled={busy}
              placeholder={busy ? 'ADT Copilot is replying…' : 'Ask about your schedule…'}
              onChange={(event) => {
                setDraft(event.target.value);
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(event.target.scrollHeight, 132)}px`;
              }}
              onKeyDown={onComposerKeyDown}
            />
            <button type="submit" className="cp-send" disabled={busy || !draft.trim()} aria-label="Send message">
              <SendIcon />
            </button>
          </form>
        )}
      </div>

      {view === 'minimised' && (
        <div className="cp-mini" role="group" aria-label="ADT Copilot, minimised">
          <button ref={restoreRef} type="button" className="cp-mini-open" onClick={open} aria-label="Restore ADT Copilot">
            <span className="cp-logo-tile cp-logo-tile--small">
              <Image className="cp-mini-logo" src={LOGO} alt="" width={26} height={25} />
            </span>
            <span className="cp-mini-title">ADT Copilot</span>
            <span className={`cp-online cp-online--${status}`}>
              <span className="cp-online-dot" aria-hidden="true" />
              {busy ? 'Replying…' : statusLabel}
            </span>
            <ExpandIcon className="cp-mini-chevron" />
          </button>
          <button type="button" className="cp-icon-btn" onClick={close} aria-label="Close ADT Copilot">
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={launcherRef}
        className="md-chat"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={view === 'open'}
        aria-controls={panelId}
        onClick={() => (view === 'open' ? close() : open())}
      >
        <ChatIcon />
        Chat with ADT Copilot
      </button>
      {isClient && createPortal(panel, document.body)}
    </>
  );
}
