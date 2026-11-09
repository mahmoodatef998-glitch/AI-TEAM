"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Executive" },
  { href: "/office", label: "Virtual office" },
  { href: "/sales", label: "Sales team" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/leads", label: "Leads" },
  { href: "/approvals", label: "Approvals", badge: "approvals" },
  { href: "/employees", label: "AI employees" },
  { href: "/tasks", label: "Tasks", badge: "blocked" },
  { href: "/messages", label: "Messages" },
  { href: "/marketing", label: "Marketing" },
  { href: "/reports", label: "Reports" },
  { href: "/knowledge", label: "Knowledge & catalogue" },
  { href: "/activity", label: "Audit log" },
  { href: "/settings", label: "Settings" },
] as const;

export function Nav({ pendingApprovals, blockedTasks }: { pendingApprovals: number; blockedTasks: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:block lg:space-y-0.5 lg:overflow-visible lg:pb-24">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        const count = "badge" in i ? (i.badge === "approvals" ? pendingApprovals : blockedTasks) : 0;
        return (
          <Link
            key={i.href}
            href={i.href}
            className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm ${active ? "bg-accent/10 font-medium text-accent" : "text-text hover:bg-surface-2"}`}
          >
            {i.label}
            {count > 0 && (
              <span className={`rounded-full px-1.5 text-[11px] font-semibold ${"badge" in i && i.badge === "approvals" ? "bg-amber-500/20 text-amber-700 dark:text-amber-400" : "bg-red-500/15 text-red-700 dark:text-red-400"}`}>{count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
