/* Inline SVG icons for ADT Copilot, drawn on the same 24 px grid and stroke
   style as the My Day page. All are decorative; buttons carry the labels. */

import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Stroke({ className, children, width = 2 }: IconProps & { children: ReactNode; width?: number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ChatIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M8 4.5h16A4.5 4.5 0 0 1 28.5 9v10a4.5 4.5 0 0 1-4.5 4.5h-8.2l-5.6 4.4a.8.8 0 0 1-1.3-.6v-3.8H8A4.5 4.5 0 0 1 3.5 19V9A4.5 4.5 0 0 1 8 4.5Z"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinejoin="round"
      />
      <circle cx="10.5" cy="14" r="1.9" fill="currentColor" />
      <circle cx="16" cy="14" r="1.9" fill="currentColor" />
      <circle cx="21.5" cy="14" r="1.9" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Stroke>
  );
}

export function MinimiseIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.2}>
      <path d="M5.5 12h13" />
    </Stroke>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.2}>
      <path d="m6 15 6-6 6 6" />
    </Stroke>
  );
}

/** Diagonal arrows out: make the panel bigger. */
export function EnlargeIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.1}>
      <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
    </Stroke>
  );
}

/** Diagonal arrows in: return the panel to the corner card. */
export function ShrinkIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.1}>
      <path d="M20 4l-6 6m0 0V5m0 5h5M4 20l6-6m0 0v5m0-5H5" />
    </Stroke>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.1}>
      <path d="M21 3 10.2 13.8" />
      <path d="M21 3 14.4 21a.6.6 0 0 1-1.1 0L10.2 13.8 3 10.7a.6.6 0 0 1 0-1.1Z" />
    </Stroke>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.2}>
      <path d="M19 12H5.5M11 18l-6-6 6-6" />
    </Stroke>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Stroke {...props} width={1.9}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </Stroke>
  );
}

export function CustomerIcon(props: IconProps) {
  return (
    <Stroke {...props} width={1.9}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20.2c.9-3.6 3.7-5.6 7.2-5.6s6.3 2 7.2 5.6" />
    </Stroke>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Stroke {...props} width={1.9}>
      <path d="M19.5 10c0 4.9-5.4 10-7 11.4a.8.8 0 0 1-1 0C9.9 20 4.5 14.9 4.5 10a7.5 7.5 0 0 1 15 0Z" />
      <circle cx="12" cy="10" r="2.8" />
    </Stroke>
  );
}

export function DirectionsIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2}>
      <path d="M3.5 11.2 20.2 3.8a.4.4 0 0 1 .5.5L13.3 21a.4.4 0 0 1-.8-.1l-1.7-7-7-1.9a.4.4 0 0 1-.3-.8Z" />
    </Stroke>
  );
}

export function DetailsIcon(props: IconProps) {
  return (
    <Stroke {...props} width={1.9}>
      <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </Stroke>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4.2M12 17h.01" />
    </Stroke>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4.5V11h-6.5" />
    </Stroke>
  );
}

export function StatusIcon(props: IconProps) {
  return (
    <Stroke {...props} width={2.1}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.8 2.8L16.3 9.5" />
    </Stroke>
  );
}
