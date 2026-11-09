import { and, desc, eq, or, isNull } from "drizzle-orm";
import { agentMemories } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

export interface MemoryInput {
  employeeId: string;
  kind: "customer_preference" | "objection" | "promise" | "conversation" | "fact" | "lesson" | "assignment";
  content: string;
  subjectType?: "company" | "opportunity" | "lead" | null;
  subjectId?: string | null;
  importance?: number;
  sourceTaskId?: string | null;
}

/** Individual persistent memory for an AI employee. */
export async function remember(db: DB, m: MemoryInput) {
  const [row] = await db
    .insert(agentMemories)
    .values({
      employeeId: m.employeeId,
      kind: m.kind,
      content: m.content,
      subjectType: m.subjectType ?? null,
      subjectId: m.subjectId ?? null,
      importance: Math.min(5, Math.max(1, m.importance ?? 3)),
      sourceTaskId: m.sourceTaskId ?? null,
    })
    .returning();
  return row;
}

/**
 * Retrieve relevant memories before a decision: everything about the subject plus the
 * employee's general (subject-less) memories, most important / most recent first.
 */
export async function recall(
  db: DB,
  employeeId: string,
  subject?: { type: string; id: string },
  limit = 30,
) {
  const subjectCond = subject
    ? or(
        and(eq(agentMemories.subjectType, subject.type), eq(agentMemories.subjectId, subject.id)),
        isNull(agentMemories.subjectId),
      )
    : undefined;
  return db
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.employeeId, employeeId), subjectCond))
    .orderBy(desc(agentMemories.importance), desc(agentMemories.createdAt))
    .limit(limit);
}
