import { Suspense } from "react";
import { requireUser, WRITE_ROLES } from "@/lib/auth/session";
import { TeamChat } from "./team-chat";

export default async function TeamPage() {
  const user = await requireUser();
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading the team…</p>}>
      <TeamChat userName={user.name} canWrite={WRITE_ROLES.includes(user.role)} />
    </Suspense>
  );
}
