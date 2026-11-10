'use client';

/**
 * Top bar: title, real Salesforce connection status, notifications, and the
 * technician profile dropdown (profile data from Salesforce REST, never Gemini).
 */

import { Bell, ChevronDown, LogOut, Menu } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import type { TechnicianProfileResult } from '@/types/dashboard';
import type { Technician } from '@/types/technician';
import { initials } from './format';
import { UnavailableNotice } from './Notice';

export type Connection = { state: 'checking' | 'connected' | 'setup' | 'error'; detail: string };

const LABEL: Record<Connection['state'], string> = {
  checking: 'Checking Salesforce…',
  connected: 'Salesforce Connected',
  setup: 'Salesforce Setup Needed',
  error: 'Salesforce Unavailable',
};

interface HeaderProps {
  technician: Technician;
  connection: Connection;
  profile: TechnicianProfileResult | null;
  onOpenMobileNav: () => void;
}

export default function Header({ technician, connection, profile, onOpenMobileNav }: HeaderProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/session', { method: 'DELETE' });
      try {
        window.sessionStorage.removeItem('adt-copilot:v1');
      } catch {
        // Storage disabled; nothing to clear.
      }
      router.refresh();
    } catch {
      setBusy(false);
    }
  };

  const ok = profile?.status === 'ok' ? profile : null;
  const displayName = ok?.userName ?? ok?.name ?? technician.fullName;

  return (
    <header className="adt-header">
      <button type="button" className="adt-icon-btn adt-header-menu" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu size={22} />
      </button>
      <h1 className="adt-header-title">My Day</h1>

      <div className="adt-header-right">
        <div className={`adt-conn adt-conn--${connection.state}`} role="status" title={connection.detail}>
          <span className="adt-conn-dot" aria-hidden="true" />
          <span className="adt-conn-label">{LABEL[connection.state]}</span>
          <span className="adt-sr">. {connection.detail}</span>
        </div>

        <button type="button" className="adt-icon-btn adt-bell" aria-label="Notifications (none)">
          <Bell size={20} />
        </button>

        <div className="adt-profile-wrap" ref={wrapRef}>
          <button
            ref={buttonRef}
            type="button"
            className="adt-profile"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="adt-avatar" aria-hidden="true">
              {initials(displayName)}
            </span>
            <span className="adt-profile-name">{displayName}</span>
            <ChevronDown size={16} className={open ? 'adt-rot' : undefined} aria-hidden="true" />
          </button>

          {open ? (
            <div className="adt-profile-menu" id={menuId} role="dialog" aria-label="Technician profile">
              <div className="adt-profile-head">
                <span className="adt-avatar adt-avatar--lg" aria-hidden="true">
                  {initials(displayName)}
                </span>
                <div>
                  <p className="adt-profile-full">{displayName}</p>
                  <p className="adt-muted adt-tiny">Technician ID {technician.id}</p>
                </div>
              </div>
              {ok ? (
                <dl className="adt-dl adt-dl--compact">
                  <dt>Service Resource</dt>
                  <dd className="adt-mono">{ok.serviceResourceId}</dd>
                  {ok.resourceType ? (
                    <>
                      <dt>Resource type</dt>
                      <dd>{ok.resourceType === 'T' ? 'Technician' : ok.resourceType}</dd>
                    </>
                  ) : null}
                  {ok.isActive !== null ? (
                    <>
                      <dt>Active</dt>
                      <dd>{ok.isActive ? 'Yes' : 'No'}</dd>
                    </>
                  ) : null}
                  {ok.territories && ok.territories.length > 0 ? (
                    <>
                      <dt>Territory</dt>
                      <dd>{ok.territories.join(', ')}</dd>
                    </>
                  ) : null}
                  {ok.skills && ok.skills.length > 0 ? (
                    <>
                      <dt>Skills</dt>
                      <dd>{ok.skills.map((skill) => skill.name).join(', ')}</dd>
                    </>
                  ) : null}
                  {ok.timezone ? (
                    <>
                      <dt>Time zone</dt>
                      <dd>{ok.timezone}</dd>
                    </>
                  ) : null}
                  {ok.dutyStatus ? (
                    <>
                      <dt>Duty status</dt>
                      <dd>{ok.dutyStatus}</dd>
                    </>
                  ) : null}
                </dl>
              ) : profile?.status === 'unavailable' ? (
                <UnavailableNotice state={profile} compact />
              ) : (
                <p className="adt-muted adt-tiny">Loading profile…</p>
              )}
              <button type="button" className="adt-menu-item" onClick={signOut} disabled={busy}>
                <LogOut size={16} aria-hidden="true" />
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
