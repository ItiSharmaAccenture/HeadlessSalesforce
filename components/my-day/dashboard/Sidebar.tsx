'use client';

import Image from 'next/image';
import { Bot, Briefcase, Calendar, CircleHelp, LayoutDashboard, Package, PanelLeftClose, PanelLeftOpen, Settings, Users, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type NavTarget = 'my-day' | 'schedule' | 'jobs' | 'copilot';

interface Item {
  id: string;
  label: string;
  icon: ReactNode;
  /** Present only for destinations this POC actually supports. */
  target?: NavTarget;
}

const ITEMS: Item[] = [
  { id: 'my-day', label: 'My Day', icon: <LayoutDashboard size={20} />, target: 'my-day' },
  { id: 'schedule', label: 'Schedule', icon: <Calendar size={20} />, target: 'schedule' },
  { id: 'jobs', label: 'Jobs', icon: <Briefcase size={20} />, target: 'jobs' },
  { id: 'inventory', label: 'Inventory', icon: <Package size={20} /> },
  { id: 'customers', label: 'Customers', icon: <Users size={20} /> },
  { id: 'copilot', label: 'Copilot', icon: <Bot size={20} />, target: 'copilot' },
];

const FOOT: Item[] = [
  { id: 'help', label: 'Help', icon: <CircleHelp size={20} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={20} /> },
];

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  active: NavTarget;
  onNavigate: (target: NavTarget) => void;
}

export default function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile, active, onNavigate }: SidebarProps) {
  const render = (item: Item) => {
    const isActive = item.target === active;
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`adt-nav-item${isActive ? ' is-active' : ''}`}
          aria-current={isActive ? 'page' : undefined}
          aria-disabled={!item.target || undefined}
          title={collapsed ? item.label + (item.target ? '' : ' (not available in this version)') : item.target ? undefined : 'Not available in this version'}
          onClick={() => {
            if (!item.target) return;
            onNavigate(item.target);
            onCloseMobile();
          }}
        >
          <span className="adt-nav-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span className="adt-nav-label">{item.label}</span>
          {!item.target ? <span className="adt-nav-soon">Soon</span> : null}
        </button>
      </li>
    );
  };

  return (
    <>
      {mobileOpen ? <div className="adt-nav-scrim" onClick={onCloseMobile} aria-hidden="true" /> : null}
      <nav className={`adt-sidebar${collapsed ? ' is-collapsed' : ''}${mobileOpen ? ' is-mobile-open' : ''}`} aria-label="Main">
        <div className="adt-sidebar-brand">
          <span className="adt-sidebar-logo">
            <Image src="/assets/my-day/adt-logo.png" alt="ADT" width={44} height={43} preload />
          </span>
          <span className="adt-sidebar-name">
            My Day
            <small>Field Technician</small>
          </span>
          <button type="button" className="adt-sidebar-close" onClick={onCloseMobile} aria-label="Close navigation">
            <X size={20} />
          </button>
        </div>
        <ul className="adt-nav">{ITEMS.map(render)}</ul>
        <ul className="adt-nav adt-nav--foot">{FOOT.map(render)}</ul>
        <button type="button" className="adt-sidebar-toggle" onClick={onToggleCollapsed} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          <span className="adt-nav-label">Collapse</span>
        </button>
      </nav>
    </>
  );
}
