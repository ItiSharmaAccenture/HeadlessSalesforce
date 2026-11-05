'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Trash2 } from 'lucide-react';

import ChatInputBox from './ChatInput';
import ChatMessageView from './ChatMessage';
import ConnectionStatus from './ConnectionStatus';
import SuggestedQuestions from './SuggestedQuestions';
import { createEventParser } from '@/lib/stream';
import type { ChatMessage, ExecutionStage, ServerEvent, StageId } from '@/types/chat';

const MAX_MESSAGE_CHARS = 4000;

/** Stage rows the backend labels itself; the client only measures elapsed time. */
const TOOL_STAGE: StageId = 'mcp_execution';

interface InterfaceProps {
  appName: string;
}

export default function ChatInterface({ appName }: InterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Wall-clock start per stage row, so completed rows can show a real duration. */
  const stageStartsRef = useRef<Map<string, number>>(new Map());

  /* ---- Auto-scroll ---------------------------------------------- */

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Don't yank the view back down if the user has scrolled up to read.
    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceFromBottom < 160) scrollToBottom('smooth');
  }, [messages, scrollToBottom]);

  /* ---- Stage bookkeeping ---------------------------------------- */

  const updateAssistant = useCallback((id: string, update: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => (message.id === id ? update(message) : message)));
  }, []);

  const upsertStage = useCallback(
    (message: ChatMessage, stage: Omit<ExecutionStage, 'durationMs'> & { durationMs?: number }): ChatMessage => {
      const stages = message.stages ? [...message.stages] : [];
      const index = stages.findIndex((entry) => entry.key === stage.key);

      // Measure how long a row stayed in the running state.
      let durationMs = stage.durationMs;
      if (stage.status === 'running') {
        stageStartsRef.current.set(stage.key, Date.now());
      } else if (durationMs === undefined) {
        const startedAt = stageStartsRef.current.get(stage.key);
        if (startedAt !== undefined) durationMs = Date.now() - startedAt;
      }

      const next: ExecutionStage = {
        ...(index >= 0 ? stages[index] : {}),
        ...stage,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };

      if (index >= 0) stages[index] = next;
      else stages.push(next);

      return { ...message, stages };
    },
    [],
  );

  /* ---- Event handling -------------------------------------------- */

  const applyEvent = useCallback(
    (assistantId: string, event: ServerEvent) => {
      switch (event.type) {
        case 'status':
          updateAssistant(assistantId, (message) =>
            upsertStage(message, {
              key: event.key,
              id: event.stage,
              label: event.message,
              status: event.status,
              ...(event.status === 'failed' ? { error: undefined } : {}),
            }),
          );
          break;

        case 'tool_selected':
          updateAssistant(assistantId, (message) =>
            upsertStage(message, {
              key: `${event.key}:sel`,
              id: 'tool_selection',
              label: event.message,
              status: 'done',
              tool: event.tool,
            }),
          );
          break;

        case 'tool_started':
          updateAssistant(assistantId, (message) =>
            upsertStage(message, {
              key: `${event.key}:run`,
              id: TOOL_STAGE,
              label: event.message,
              status: 'running',
              tool: event.tool,
            }),
          );
          break;

        case 'tool_completed':
          updateAssistant(assistantId, (message) =>
            upsertStage(message, {
              key: `${event.key}:run`,
              id: 'mcp_response',
              label: event.message,
              status: 'done',
              tool: event.tool,
              durationMs: event.durationMs,
              ...(event.recordCount !== undefined ? { recordCount: event.recordCount } : {}),
            }),
          );
          break;

        case 'tool_failed':
          updateAssistant(assistantId, (message) =>
            upsertStage(message, {
              key: `${event.key}:run`,
              id: TOOL_STAGE,
              label: `Salesforce MCP call failed`,
              status: 'failed',
              tool: event.tool,
              durationMs: event.durationMs,
              error: event.message,
            }),
          );
          break;

        case 'answer_delta':
          updateAssistant(assistantId, (message) => ({ ...message, content: message.content + event.text }));
          break;

        case 'answer_reset':
          // Gemini's preamble turned out to precede a tool call, not an answer.
          updateAssistant(assistantId, (message) => ({ ...message, content: '' }));
          break;

        case 'completed':
          updateAssistant(assistantId, (message) => ({ ...message, pending: false }));
          break;

        case 'error':
          updateAssistant(assistantId, (message) => ({ ...message, pending: false, error: event.message }));
          break;
      }
    },
    [updateAssistant, upsertStage],
  );

  /* ---- Sending ---------------------------------------------------- */

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;

      const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: question };
      const assistantId = `a-${Date.now()}`;
      const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', pending: true, stages: [] };

      // Prior turns only — the question just asked is sent separately.
      const history = messages
        .filter((message) => !message.pending && !message.error && message.content)
        .map((message) => ({ role: message.role, content: message.content }));

      setMessages((current) => [...current, userMessage, assistantMessage]);
      setDraft('');
      setBusy(true);
      stageStartsRef.current.clear();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: question, history }),
          signal: controller.signal,
        });

        if (!response.body) throw new Error('The server returned an empty response.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createEventParser();

        // Read the SSE stream directly: EventSource cannot issue a POST.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          // `stream: true` keeps multi-byte characters intact across chunks.
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            applyEvent(assistantId, event);
          }
        }

        for (const event of parser.end()) applyEvent(assistantId, event);

        // A stream that ends without `completed` or `error` was cut short.
        updateAssistant(assistantId, (message) =>
          message.pending
            ? {
                ...message,
                pending: false,
                error: message.error ?? 'The response ended unexpectedly. Please try again.',
                stages: message.stages?.map((stage) =>
                  stage.status === 'running' ? { ...stage, status: 'failed' as const } : stage,
                ),
              }
            : message,
        );
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';

        updateAssistant(assistantId, (message) => ({
          ...message,
          pending: false,
          error: aborted ? undefined : 'Could not reach the assistant. Check that the server is running.',
          content: aborted && !message.content ? '_Stopped._' : message.content,
          stages: message.stages?.map((stage) =>
            stage.status === 'running' ? { ...stage, status: 'failed' as const } : stage,
          ),
        }));
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [applyEvent, busy, messages, updateAssistant],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    stageStartsRef.current.clear();
    setMessages([]);
    setDraft('');
  }, []);

  /* ---- Render ------------------------------------------------------ */

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white shadow-sm"
            aria-hidden
          >
            <Cloud className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-900">{appName}</h1>
            <p className="truncate text-xs text-slate-500">Powered by Gemini + Salesforce MCP</p>
          </div>

          <ConnectionStatus />

          <button
            type="button"
            onClick={clear}
            disabled={messages.length === 0}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </header>

      <div ref={scrollerRef} className="scroll-subtle min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-6 py-10">
            <div className="px-4 text-center">
              <h2 className="text-lg font-semibold text-slate-800">Ask about your Salesforce pipeline</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                Answers come from live CRM records via Salesforce Hosted MCP, using one dedicated Salesforce user
                whose permissions decide what is reachable.
              </p>
            </div>

            <SuggestedQuestions onSelect={(question) => void send(question)} disabled={busy} />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
            {messages.map((message) => (
              <ChatMessageView key={message.id} message={message} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white/90 pt-3 backdrop-blur">
        <ChatInputBox
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send(draft)}
          onStop={stop}
          busy={busy}
          maxLength={MAX_MESSAGE_CHARS}
        />
      </div>
    </div>
  );
}
