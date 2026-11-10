'use client';

/**
 * Technician sign-in for My Day.
 *
 * A stand-in for real authentication: whatever is entered here is who the
 * Copilot looks up in Salesforce. The name has to match the technician as
 * Salesforce knows them, because that is what the appointment action is asked
 * for; the ID is only shown on the dashboard.
 *
 * Rendered *instead of* the dashboard, never inside it: `.myday` is a size
 * container, which would become the containing block for anything fixed.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Image from 'next/image';

import type { CopilotErrorBody } from '@/types/copilot';

export default function TechnicianLogin({ fontClassName, demoMode = false }: { fontClassName?: string; demoMode?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, id, ...(accessCode ? { accessCode } : {}) }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as CopilotErrorBody | null;
        setError(body?.error ?? 'Could not sign in. Please try again.');
        setBusy(false);
        return;
      }

      // The dashboard is a server component, so it re-reads the cookie.
      router.refresh();
    } catch {
      setError('Could not reach the server. Check that it is still running.');
      setBusy(false);
    }
  };

  return (
    <div className={`tl-screen ${fontClassName ?? ''}`}>
      <form className="tl-card" onSubmit={submit}>
        <Image className="tl-logo" src="/assets/my-day/adt-logo.png" alt="ADT" width={82} height={80} priority />

        <h1 className="tl-title">My Day</h1>
        <p className="tl-subtitle">Sign in to see your schedule and talk to ADT Copilot.</p>

        <label className="tl-label" htmlFor="tl-name">
          Full name
        </label>
        <input
          id="tl-name"
          className="tl-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="As Salesforce knows you"
          autoComplete="name"
          maxLength={120}
          required
          autoFocus
        />

        <label className="tl-label" htmlFor="tl-id">
          Technician ID
        </label>
        <input
          id="tl-id"
          className="tl-input"
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="TCH-0000"
          maxLength={120}
          required
        />

        {demoMode ? (
          <>
            <label className="tl-label" htmlFor="tl-code">
              Access code <span className="tl-optional">(demo mode)</span>
            </label>
            <input
              id="tl-code"
              className="tl-input"
              type="password"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="Required to load your Salesforce schedule"
              autoComplete="one-time-code"
              maxLength={120}
            />
          </>
        ) : null}

        {error ? (
          <p className="tl-error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="tl-submit" type="submit" disabled={busy || !name.trim() || !id.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
