import Link from "next/link";
import type { ReactNode } from "react";

export const fmtAed = (v: number | string | null | undefined) =>
  v == null || v === "" ? "—" : `AED ${Math.round(Number(v)).toLocaleString("en-US")}`;
export const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dubai" }) : "—";
export const fmtDateTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }) : "—";
export function timeAgo(d: Date | string | null | undefined) {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const humanize = (s: string | null | undefined) => (s ? s.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "estimate" | "warn" | "ok" }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      {tone === "estimate" && <div className="mt-1 text-[11px] font-medium uppercase tracking-wide text-warn">Estimate</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  gray: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  green: "bg-green-500/10 text-green-700 dark:text-green-400",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  red: "bg-red-500/10 text-red-700 dark:text-red-400",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  teal: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  purple: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
};
export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function statusTone(s: string): keyof typeof TONES {
  if (["completed", "won", "approved", "executed", "sent", "verified", "high_priority", "idle", "done"].includes(s)) return "green";
  if (["blocked", "waiting_approval", "pending", "manual_required", "needs_more_research", "awaiting_approval", "pending_approval", "unverified"].includes(s)) return "amber";
  if (["failed", "error", "lost", "rejected", "disqualified", "missed", "low_priority"].includes(s)) return "red";
  if (["running", "working", "researching", "writing", "analyzing", "contacting_customer", "preparing_quotation", "in_meeting"].includes(s)) return "blue";
  if (["qualified", "assigned"].includes(s)) return "teal";
  return "gray";
}
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={statusTone(s)}>{humanize(s)}</Badge>;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className = "", colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => <td colSpan={colSpan} className={`px-4 py-2 align-top ${className}`}>{children}</td>;

export function A({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="font-medium text-accent hover:underline">{children}</Link>;
}

export function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }} aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}
