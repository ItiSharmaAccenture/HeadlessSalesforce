'use client';

/**
 * Right-side drawer (full screen on mobile). Modal: focus moves in, is
 * trapped while open, Escape closes, and focus returns to the opener.
 */

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  size?: 'md' | 'lg' | 'xl';
  children: ReactNode;
  footer?: ReactNode;
}

export default function Drawer({ open, onClose, title, subtitle, icon, size = 'md', children, footer }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      const opener = openerRef.current;
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="adt-drawer-root" onKeyDown={onKeyDown}>
      <div className="adt-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className={`adt-drawer adt-drawer--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="adt-drawer-head">
          {icon ? <span className="adt-drawer-icon" aria-hidden="true">{icon}</span> : null}
          <div className="adt-drawer-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="adt-icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
            <X size={20} />
          </button>
        </header>
        <div className="adt-drawer-body">{children}</div>
        {footer ? <footer className="adt-drawer-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
