import type { Metadata } from "next";
import Image from "next/image";
import { Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
import CopilotChat from "@/components/my-day/CopilotChat";
import { currentTechnician as technician } from "@/lib/technician";
import "./my-day.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ADT – My Day",
};

/* ------------------------------------------------------------------ Data
   Static demo values from the design. Replace with Salesforce data later
   (e.g. the Get Technician Appointments action via your API route). The
   technician comes from lib/technician so the Copilot API uses the same one. */

const stats: { value: string; label: string; tone: "blue" | "green" | "amber"; icon: ReactNode }[] = [
  { value: "3", label: "Jobs Today", tone: "blue", icon: <CalendarIcon /> },
  { value: "2", label: "Ready to Start", tone: "green", icon: <CheckCircleIcon /> },
  { value: "1", label: "Needs Parts", tone: "amber", icon: <AlertIcon /> },
  { value: "7.5 h", label: "Total Time", tone: "blue", icon: <ClockIcon /> },
];

const details: { label: string; value: ReactNode; icon: ReactNode }[] = [
  { label: "Technician ID", value: "TCH-7842", icon: <BadgeIcon /> },
  { label: "Home Territory", value: "Round Rock, TX", icon: <PinIcon /> },
  { label: "Vehicle", value: "ADT-3487 (Ford Transit)", icon: <TruckIcon /> },
  { label: "Today’s Hours", value: "8:00 AM – 4:30 PM", icon: <ClockOutlineIcon /> },
  {
    label: "Certifications",
    value: (
      <>
        Installation • Smart Home<span className="md-wrap">• Life Safety</span>
      </>
    ),
    icon: <AwardIcon />,
  },
];

/* ------------------------------------------------------------------ Page */

export default function MyDayPage() {
  return (
    <div className={`myday ${jakarta.variable}`}>
      <div className="md-frame">
        {/* Header */}
        <header className="md-header">
          <Image className="md-logo" src="/assets/my-day/adt-logo.png" alt="ADT" width={82} height={80} preload />
          <div className="md-vdivider md-vdivider--brand" aria-hidden="true" />
          <h1 className="md-page-title">My Day</h1>

          <div className="md-header-right">
            <div className="md-sf-pill" role="status">
              <span className="md-dot" aria-hidden="true" />
              <Image className="md-sf-logo" src="/assets/my-day/salesforce-logo.png" alt="" width={53} height={39} />
              <span>Salesforce Connected</span>
            </div>

            <button className="md-bell" type="button" aria-label="Notifications, new items">
              <BellIcon />
              <span className="md-bell-badge" aria-hidden="true" />
            </button>

            <div className="md-vdivider md-vdivider--profile" aria-hidden="true" />

            <button className="md-profile" type="button" aria-label={`Account menu for ${technician.fullName}`}>
              <Image className="md-profile-avatar" src={technician.photo} alt="" width={58} height={58} />
              <span className="md-profile-name">{technician.fullName}</span>
              <ChevronDownIcon />
            </button>
          </div>
        </header>

        {/* Hero + stats */}
        <section className="md-hero" aria-labelledby="md-greeting">
          <Image className="md-hero-photo" src="/assets/my-day/hero-house.webp" alt="" width={982} height={243} preload />
          <h2 className="md-greeting" id="md-greeting">
            Good morning, {technician.firstName}!
          </h2>

          <ul className="md-stats" aria-label="Today at a glance">
            {stats.map((s) => (
              <li className="md-stat" key={s.label}>
                <span className={`md-tile md-tile--${s.tone}`} aria-hidden="true">
                  {s.icon}
                </span>
                <span className="md-stat-text">
                  <span className="md-stat-value">{s.value}</span>
                  <span className="md-stat-label">{s.label}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Mission card */}
        <section className="md-mission" aria-labelledby="md-mission-title">
          <Image className="md-van" src="/assets/my-day/van.webp" alt="ADT service van" width={523} height={392} />
          <h2 className="md-mission-title" id="md-mission-title">
            Your Mission Today
          </h2>

          <Image className="md-tech-photo" src={technician.photo} alt={technician.fullName} width={196} height={196} />

          <div className="md-tech">
            <p className="md-tech-name">{technician.fullName}</p>
            <p className="md-tech-role">{technician.role}</p>
            {technician.onDuty && (
              <span className="md-duty">
                <DutyCheckIcon />
                On Duty
              </span>
            )}
          </div>

          <CopilotChat firstName={technician.firstName} fontClassName={jakarta.variable} />

          <div className="md-mission-divider" aria-hidden="true" />

          <dl className="md-details">
            {details.map((d) => (
              <div className="md-detail" key={d.label}>
                <dt>
                  {d.icon}
                  {d.label}
                </dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Icons */

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.6v1.2" />
      <path d="M6.2 9.6a5.8 5.8 0 0 1 11.6 0c0 6.4 2.7 8.2 2.7 8.2H3.5s2.7-1.8 2.7-8.2" />
      <path d="M10.2 21a2 2 0 0 0 3.6 0" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="16" rx="3" />
      <path d="M8 2.75v3.5M16 2.75v3.5M3.5 10h17" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="m7.8 12.3 3 3 5.6-6" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4.2M12 17h.01" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 6.8V12l3.6 2.2" />
    </svg>
  );
}

function DutyCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#12a80b" />
      <path d="m7 12.4 3.2 3.1L17 8.8" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4.5" width="16" height="17" rx="2.5" />
      <path d="M9 2.8h6v3.4H9z" />
      <circle cx="12" cy="11.6" r="2.3" />
      <path d="M8 18c.7-1.9 2.2-2.9 4-2.9s3.3 1 4 2.9" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.5 10c0 4.9-5.4 10-7 11.4a.8.8 0 0 1-1 0C9.9 20 4.5 14.9 4.5 10a7.5 7.5 0 0 1 15 0Z" />
      <circle cx="12" cy="10" r="2.8" />
    </svg>
  );
}

function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M.8 5.8C.8 4.8 1.6 4 2.6 4h11.1c1 0 1.8.8 1.8 1.8V17H.8V5.8Z" fill="currentColor" />
      <path d="M15.5 7.8h4.1c.6 0 1.1.3 1.5.7l2.3 3.2c.2.3.3.7.3 1V17h-8.2V7.8Z" fill="currentColor" />
      <path d="M17.2 9.5h2.3l1.8 2.5h-4.1z" fill="#fff" />
      <circle cx="5.6" cy="18" r="2.8" fill="currentColor" stroke="#fff" strokeWidth={1.3} />
      <circle cx="18.6" cy="18" r="2.8" fill="currentColor" stroke="#fff" strokeWidth={1.3} />
    </svg>
  );
}

function ClockOutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </svg>
  );
}

function AwardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8.8" r="7" />
      <path d="m9.7 6.5 4.6 4.6M14.3 6.5l-4.6 4.6" />
      <path d="m8 14.6-1.9 7.9 5.9-3.2 5.9 3.2-1.9-7.9" />
    </svg>
  );
}
