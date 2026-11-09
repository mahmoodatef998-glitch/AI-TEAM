import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { approvals, tasks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/session";
import { logoutAction } from "@/app/actions";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const db = getDb();
  const [a] = await db.select({ c: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, "pending"));
  const [b] = await db.select({ c: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.status, "blocked"));
  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-border bg-surface lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-3 lg:block">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-accent">4U Power Generation</div>
            <div className="text-sm font-semibold">AI Workforce</div>
          </div>
        </div>
        <Nav pendingApprovals={a?.c ?? 0} blockedTasks={b?.c ?? 0} />
        <div className="hidden border-t border-border px-4 py-3 text-xs lg:absolute lg:bottom-0 lg:block lg:w-60">
          <div className="font-medium">{user.name}</div>
          <div className="text-muted">{user.role.replace("_", " ")}</div>
          <form action={logoutAction} className="mt-2">
            <button className="text-muted hover:text-text">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
