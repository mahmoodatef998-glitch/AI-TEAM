import { and, desc, eq, or, sql } from "drizzle-orm";
import { messages } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

type MessageKind = (typeof messages.$inferInsert)["kind"];

export interface SendMessageInput {
  fromEmployeeId?: string | null;
  fromUserId?: string | null;
  toEmployeeId?: string | null;
  toUserId?: string | null;
  kind?: MessageKind;
  subject?: string | null;
  body: string;
  relatedType?: string | null;
  relatedId?: string | null;
  taskId?: string | null;
  threadId?: string | null;
}

/** Internal communication between AI employees (and humans). Stored and full-text searchable. */
export async function sendMessage(db: DB, input: SendMessageInput) {
  const [row] = await db
    .insert(messages)
    .values({
      fromEmployeeId: input.fromEmployeeId ?? null,
      fromUserId: input.fromUserId ?? null,
      toEmployeeId: input.toEmployeeId ?? null,
      toUserId: input.toUserId ?? null,
      kind: input.kind ?? "message",
      subject: input.subject ?? null,
      body: input.body,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      taskId: input.taskId ?? null,
      threadId: input.threadId ?? null,
    })
    .returning();
  return row;
}

export async function searchMessages(db: DB, query: string, opts: { employeeId?: string; limit?: number } = {}) {
  const conds = [];
  if (query.trim()) {
    conds.push(
      sql`to_tsvector('english', coalesce(${messages.subject}, '') || ' ' || ${messages.body}) @@ websearch_to_tsquery('english', ${query})`,
    );
  }
  if (opts.employeeId) {
    conds.push(or(eq(messages.fromEmployeeId, opts.employeeId), eq(messages.toEmployeeId, opts.employeeId)));
  }
  return db
    .select()
    .from(messages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(messages.createdAt))
    .limit(opts.limit ?? 100);
}
