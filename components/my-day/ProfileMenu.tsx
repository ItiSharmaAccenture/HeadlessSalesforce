'use client';

/**
 * The header profile control.
 *
 * Opens a menu rather than signing out on click: signing out on a single click
 * of your own name is too easy to do by accident.
 */

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

interface ProfileMenuProps {
  fullName: string;
  technicianId: string;
  photo: string;
}

export default function ProfileMenu({ fullName, technicianId, photo }: ProfileMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Clicking elsewhere, or Escape, dismisses the menu.
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
      router.refresh();
    } catch {
      // The cookie is still set, so the dashboard stays; let them try again.
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div className="md-profile-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        className="md-profile"
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Image className="md-profile-avatar" src={photo} alt="" width={58} height={58} />
        <span className="md-profile-name">{fullName}</span>
        <span className={`md-profile-chevron${open ? ' md-profile-chevron--open' : ''}`} aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>

      {open && (
        <div className="md-menu" id={menuId} role="menu" aria-label={`Account menu for ${fullName}`}>
          <div className="md-menu-head">
            <p className="md-menu-name">{fullName}</p>
            <p className="md-menu-id">{technicianId}</p>
          </div>

          <button className="md-menu-item" type="button" role="menuitem" onClick={signOut} disabled={busy} autoFocus>
            <SignOutIcon />
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
      <path d="M10 12h10m0 0-3.2-3.2M20 12l-3.2 3.2" />
    </svg>
  );
}
