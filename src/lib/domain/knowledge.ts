import { and, eq, inArray } from "drizzle-orm";
import { knowledgeItems } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

/**
 * Retrieve knowledge for AI employees. Only VERIFIED items are treated as facts the AI may
 * state externally; unverified items are returned separately so prompts can mark them.
 */
export async function getKnowledge(db: DB, categories?: string[]) {
  const rows = await db
    .select()
    .from(knowledgeItems)
    .where(categories?.length ? inArray(knowledgeItems.category, categories) : undefined);
  return { verified: rows.filter((r) => r.verified), unverified: rows.filter((r) => !r.verified) };
}

export function knowledgeAsPrompt(k: Awaited<ReturnType<typeof getKnowledge>>) {
  const v = k.verified.map((r) => `- [${r.category}] ${r.title}: ${r.content}`).join("\n") || "(none)";
  return `VERIFIED COMPANY FACTS (you may state these):\n${v}`;
}

export async function hasVerifiedCategory(db: DB, category: string) {
  const rows = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.category, category), eq(knowledgeItems.verified, true)))
    .limit(1);
  return rows.length > 0;
}
