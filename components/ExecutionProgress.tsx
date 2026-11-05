'use client';

import { useState } from 'react';
import { Check, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';

import type { ExecutionStage } from '@/types/chat';

interface ExecutionProgressProps {
  stages: ExecutionStage[];
  /** Expanded by default while the turn is still running. */
  live: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * The Execution Details panel.
 *
 * Shows only stages the backend actually reported, with real measured
 * durations. Tool arguments and raw Salesforce payloads are deliberately absent:
 * the panel reports what ran, not what came back.
 */
export default function ExecutionProgress({ stages, live }: ExecutionProgressProps) {
  const [open, setOpen] = useState(live);

  if (stages.length === 0) return null;

  const running = stages.find((stage) => stage.status === 'running');
  const failures = stages.filter((stage) => stage.status === 'failed');

  const summary = running
    ? running.label
    : failures.length > 0
      ? `${failures.length} step${failures.length === 1 ? '' : 's'} failed`
      : `${stages.length} steps`;

  const totalMs = stages.reduce((total, stage) => total + (stage.durationMs ?? 0), 0);

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span className="shrink-0">Execution Details</span>

        <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
          <span aria-hidden>·</span>
          {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-brand-500" aria-hidden />}
          {failures.length > 0 && !running && (
            <TriangleAlert className="h-3 w-3 shrink-0 text-amber-500" aria-hidden />
          )}
          <span className="truncate font-normal">{summary}</span>
        </span>

        {!running && totalMs > 0 && (
          <span className="ml-auto shrink-0 font-normal text-slate-400">{formatDuration(totalMs)}</span>
        )}
      </button>

      {open && (
        <ol className="space-y-1 border-t border-slate-200 px-3 py-2.5">
          {stages.map((stage) => (
            <li key={stage.key} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
                {stage.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />}
                {stage.status === 'done' && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                {stage.status === 'failed' && <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={
                    stage.status === 'running'
                      ? 'font-medium text-brand-700'
                      : stage.status === 'failed'
                        ? 'text-amber-700'
                        : 'text-slate-600'
                  }
                >
                  {stage.label}
                </span>

                {stage.tool && (
                  <code className="ml-1.5 rounded bg-white px-1 py-0.5 font-mono text-[0.6875rem] text-slate-500 ring-1 ring-slate-200 ring-inset">
                    {stage.tool}
                  </code>
                )}

                {stage.recordCount !== undefined && (
                  <span className="ml-1.5 text-slate-400">
                    {stage.recordCount} record{stage.recordCount === 1 ? '' : 's'}
                  </span>
                )}

                {stage.error && <span className="mt-0.5 block text-amber-700">{stage.error}</span>}
              </span>

              {stage.durationMs !== undefined && stage.durationMs > 0 && (
                <span className="shrink-0 font-mono text-[0.6875rem] text-slate-400">
                  {formatDuration(stage.durationMs)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
