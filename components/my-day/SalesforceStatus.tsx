'use client';

/**
 * The header's Salesforce pill, backed by a real check.
 *
 * It used to read "Salesforce Connected" unconditionally. It now reports what
 * /api/health actually found: "Connected" appears only after a live MCP
 * handshake and tool discovery have succeeded, never from configuration alone.
 */

import Image from 'next/image';
import { useEffect, useState } from 'react';

import type { HealthResponse } from '@/types/chat';

type Indicator = 'connecting' | 'connected' | 'configuration_required' | 'connection_failed';

const PRESENTATION: Record<Indicator, { label: string }> = {
  connecting: { label: 'Checking Salesforce…' },
  connected: { label: 'Salesforce Connected' },
  configuration_required: { label: 'Salesforce Setup Needed' },
  connection_failed: { label: 'Salesforce Unavailable' },
};

export default function SalesforceStatus() {
  const [indicator, setIndicator] = useState<Indicator>('connecting');
  const [detail, setDetail] = useState('Checking Gemini and Salesforce MCP…');

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

  return (
    <div className={`md-sf-pill md-sf-pill--${indicator}`} role="status" title={detail}>
      <span className="md-dot" aria-hidden="true" />
      <Image className="md-sf-logo" src="/assets/my-day/salesforce-logo.png" alt="" width={53} height={39} />
      <span className="md-sf-text">{PRESENTATION[indicator].label}</span>
      <span className="md-sr">. {detail}</span>
    </div>
  );
}
