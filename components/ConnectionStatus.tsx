'use client';

import { useEffect, useState } from 'react';

import type { HealthResponse } from '@/types/chat';

type Indicator = 'connecting' | 'connected' | 'configuration_required' | 'connection_failed';

const PRESENTATION: Record<Indicator, { label: string; dot: string; text: string; ring: string }> = {
  connecting: { label: 'Connecting', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-700', ring: 'ring-amber-200' },
  connected: { label: 'Connected', dot: 'bg-emerald-500', text: 'text-emerald-700', ring: 'ring-emerald-200' },
  configuration_required: {
    label: 'Configuration required',
    dot: 'bg-slate-400',
    text: 'text-slate-600',
    ring: 'ring-slate-200',
  },
  connection_failed: { label: 'Connection failed', dot: 'bg-red-500', text: 'text-red-700', ring: 'ring-red-200' },
};

/**
 * Live connection indicator.
 *
 * Reports "Connected" only after /api/health has verified a real Salesforce MCP
 * handshake — never from the presence of environment variables alone.
 */
export default function ConnectionStatus() {
  const [indicator, setIndicator] = useState<Indicator>('connecting');
  const [detail, setDetail] = useState<string>('Checking Gemini and Salesforce MCP…');

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`health check returned ${response.status}`);

        const health = (await response.json()) as HealthResponse;
        if (cancelled) return;

        setIndicator(health.status);
        setDetail(
          [
            `Gemini: ${health.checks.gemini.detail}`,
            `Salesforce OAuth: ${health.checks.salesforceOAuth.detail}`,
            `Salesforce MCP: ${health.checks.salesforceMcp.detail}`,
          ].join('\n'),
        );
      } catch {
        if (cancelled) return;
        setIndicator('connection_failed');
        setDetail('The health endpoint could not be reached.');
      }
    };

    void check();
    // The probe is cached server-side for 30s, so polling stays cheap.
    const timer = setInterval(() => void check(), 60_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const presentation = PRESENTATION[indicator];

  return (
    <span
      title={detail}
      className={`inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${presentation.ring} ${presentation.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${presentation.dot}`} aria-hidden />
      <span>{presentation.label}</span>
      <span className="sr-only">. {detail}</span>
    </span>
  );
}
