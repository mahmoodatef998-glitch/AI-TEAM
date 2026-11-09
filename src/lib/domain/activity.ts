import { activityLog } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

export type Actor =
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "system"; id?: null };

export const SYSTEM: Actor = { type: "system", id: null };

/** Append-only audit trail. Also the event feed for the virtual office and employee profiles. */
export async function logActivity(
  db: DB,
  actor: Actor,
  action: string,
  summary: string,
  opts: { entityType?: string; entityId?: string | null; detail?: Record<string, unknown> } = {},
) {
  await db.insert(activityLog).values({
    actorType: actor.type,
    actorId: actor.id ?? null,
    action,
    summary,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
    detail: opts.detail ?? null,
  });
}
