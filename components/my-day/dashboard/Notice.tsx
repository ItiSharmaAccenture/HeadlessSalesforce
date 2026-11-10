'use client';

import { Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Unavailable } from '@/types/dashboard';

/** Honest "this cannot be shown" state, with the admin fix when known. */
export function UnavailableNotice({ state, compact, action }: { state: Unavailable; compact?: boolean; action?: ReactNode }) {
  const setup = ['missing_api_scope', 'not_mapped', 'provider_not_configured', 'named_query_unavailable', 'not_authorized'].includes(state.code);
  return (
    <div className={`adt-notice ${setup ? 'adt-notice--setup' : 'adt-notice--error'}${compact ? ' adt-notice--compact' : ''}`} role="status">
      {setup ? <Info size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}
      <div>
        <p className="adt-notice-msg">{state.message}</p>
        {state.adminHint && !compact ? (
          <details className="adt-notice-hint">
            <summary>Administrator setup</summary>
            <p>{state.adminHint}</p>
          </details>
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="adt-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}
