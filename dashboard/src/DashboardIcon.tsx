import type { ReactNode } from 'react';

/** Small, consistent line icons for the dashboard shell. The adjacent text names every action. */
const paths: Record<string, ReactNode> = {
  live: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  monthly: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M8 14h2m4 0h2m-8 4h2"/></>,
  performance: <><path d="M4 20h16M6 17v-5m5 5V7m5 10V4m4 13V9"/></>,
  reports: <><path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M8 12h8M8 16h8"/></>,
  customers: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1"/></>,
  products: <><rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 4V2m8 2V2M8 10h8m-8 4h8m-8 4h4"/></>,
  warehouses: <><path d="m3 10 9-6 9 6v10H3V10Zm4 10v-7h10v7M7 16h10"/></>,
  staff: <><circle cx="12" cy="7" r="3"/><path d="M5 20v-1a7 7 0 0 1 14 0v1M18 5h3m-1.5-1.5v3"/></>,
  team: <><circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0M5 6a2.5 2.5 0 0 0 0 5m14-5a2.5 2.5 0 0 1 0 5M2 18a5 5 0 0 1 3-4m17 4a5 5 0 0 0-3-4"/></>,
  agent: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14ZM5 14l.7 1.8 1.8.7-1.8.7L5 19l-.7-1.8-1.8-.7 1.8-.7L5 14Z"/></>,
  account: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6.5 19a6 6 0 0 1 11 0"/></>,
  signal: <><path d="M5 18a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0m-5 3a1 1 0 1 0 2 0 1 1 0 0 0-2 0ZM3 12a14 14 0 0 1 18 0"/></>,
  distance: <><path d="M4 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm12-10a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM8 17h5a3 3 0 0 0 0-6h-2a2 2 0 0 1 0-4h5"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 6l2 1M4 17l2 1a7 7 0 0 0 12.5-3"/></>,
};
export default function DashboardIcon({name}:{name:string}) {
  return <svg aria-hidden="true" className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
