/**
 * Model routing layer. Tasks ask for a *profile* (reasoning, technical, sales_writing,
 * research_web, research_realtime); the `model_routes` table maps each profile to a provider
 * and model, so providers can be changed per task type without code changes.
 *
 *  - anthropic → official Anthropic SDK (structured outputs, server-side web search,
 *    server-side refusal fallback)
 *  - xai       → Vercel AI SDK (@ai-sdk/xai)
 *
 * No model is assumed to have web access unless the route uses a configured search tool.
 * Every call is recorded in `ai_usage` with tokens, cost and latency.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { generateText, Output } from "ai";
import { createXai } from "@ai-sdk/xai";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { aiUsage, modelRoutes } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";
import { estimateCostUsd, WEB_SEARCH_USD_PER_CALL } from "./pricing";

export type Profile = "reasoning" | "technical" | "sales_writing" | "research_web" | "research_realtime";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class ProviderNotConfiguredError extends Error {
  constructor(public provider: string, public envVar: string) {
    super(`AI provider '${provider}' is not configured (set ${envVar}).`);
  }
}
export class ModelRefusalError extends Error {}

const DEFAULT_ROUTES: Record<Profile, { provider: string; model: string; effort: Effort | null }> = {
  reasoning: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  technical: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  sales_writing: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
  research_web: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
  research_realtime: { provider: "xai", model: "grok-4.7", effort: null },
};

export async function getRoute(db: DB, profile: Profile) {
  const [r] = await db.select().from(modelRoutes).where(eq(modelRoutes.profile, profile));
  if (r) return { provider: r.provider, model: r.model, effort: (r.effort as Effort | null) ?? null };
  return DEFAULT_ROUTES[profile];
}

export function providerConfigured(provider: string) {
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "xai") return !!process.env.XAI_API_KEY;
  return false;
}

function requireProvider(provider: string) {
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new ProviderNotConfiguredError("anthropic", "ANTHROPIC_API_KEY");
  if (provider === "xai" && !process.env.XAI_API_KEY) throw new ProviderNotConfiguredError("xai", "XAI_API_KEY");
  if (provider !== "anthropic" && provider !== "xai") throw new ProviderNotConfiguredError(provider, "a supported provider");
}

let anthropic: Anthropic | null = null;
const anthropicClient = () => (anthropic ??= new Anthropic());

interface CallContext {
  db: DB;
  employeeId?: string | null;
  taskId?: string | null;
}

async function recordUsage(
  ctx: CallContext,
  r: { provider: string; model: string; profile: string; inputTokens: number; outputTokens: number; extraCostUsd?: number; latencyMs: number; success: boolean; error?: string },
) {
  const cost = (estimateCostUsd(r.model, r.inputTokens, r.outputTokens) ?? 0) + (r.extraCostUsd ?? 0);
  await ctx.db.insert(aiUsage).values({
    employeeId: ctx.employeeId ?? null,
    taskId: ctx.taskId ?? null,
    provider: r.provider,
    model: r.model,
    profile: r.profile,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: cost.toFixed(6),
    latencyMs: r.latencyMs,
    success: r.success,
    error: r.error ?? null,
  });
}

/** Structured generation: returns data validated against `schema`. */
export async function generateStructured<S extends z.ZodType>(
  ctx: CallContext,
  args: { profile: Profile; system: string; prompt: string; schema: S; maxTokens?: number },
): Promise<z.infer<S>> {
  const route = await getRoute(ctx.db, args.profile);
  requireProvider(route.provider);
  const started = Date.now();
  try {
    if (route.provider === "anthropic") {
      const res = await anthropicClient().beta.messages.parse({
        model: route.model,
        max_tokens: args.maxTokens ?? 16000,
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
        output_config: { format: betaZodOutputFormat(args.schema), ...(route.effort ? { effort: route.effort } : {}) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      await recordUsage(ctx, {
        provider: "anthropic",
        model: route.model,
        profile: args.profile,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        latencyMs: Date.now() - started,
        success: res.stop_reason !== "refusal" && res.parsed_output != null,
      });
      if (res.stop_reason === "refusal") throw new ModelRefusalError("The model declined this request.");
      if (res.stop_reason === "max_tokens") throw new Error("Model output was truncated (max_tokens).");
      if (res.parsed_output == null) throw new Error("Model output did not match the required schema.");
      return res.parsed_output as z.infer<S>;
    }
    const xai = createXai({ apiKey: process.env.XAI_API_KEY });
    const res = await generateText({
      model: xai(route.model),
      system: args.system,
      prompt: args.prompt,
      output: Output.object({ schema: args.schema }),
    });
    await recordUsage(ctx, {
      provider: "xai",
      model: route.model,
      profile: args.profile,
      inputTokens: res.usage.inputTokens ?? 0,
      outputTokens: res.usage.outputTokens ?? 0,
      latencyMs: Date.now() - started,
      success: true,
    });
    return res.output as z.infer<S>;
  } catch (e) {
    if (e instanceof ModelRefusalError || e instanceof ProviderNotConfiguredError) throw e;
    if (!(e instanceof Error && /truncated|schema/.test(e.message))) {
      await recordUsage(ctx, {
        provider: route.provider,
        model: route.model,
        profile: args.profile,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        success: false,
        error: (e as Error).message,
      });
    }
    throw e;
  }
}

export interface WebResearchResult {
  report: string;
  /** Every URL the search tool actually returned. Used to reject fabricated sources. */
  sourceUrls: Map<string, string>;
  searches: number;
}

/**
 * Real web research with Claude's server-side web search tool. Returns the written report and
 * the set of URLs actually retrieved by the search tool, so callers can verify that every
 * evidence URL in downstream structured output was really found (anti-fabrication check).
 */
export async function researchWeb(
  ctx: CallContext,
  args: { system: string; prompt: string; maxSearches?: number; allowedDomains?: string[] },
): Promise<WebResearchResult> {
  const route = await getRoute(ctx.db, "research_web");
  if (route.provider !== "anthropic") throw new ProviderNotConfiguredError(route.provider, "an Anthropic route for research_web (web search tool)");
  requireProvider("anthropic");
  const started = Date.now();
  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: args.maxSearches ?? 8,
      ...(args.allowedDomains?.length ? { allowed_domains: args.allowedDomains } : {}),
    },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: args.prompt }];
  const sourceUrls = new Map<string, string>();
  let text = "";
  let inTok = 0;
  let outTok = 0;
  let searches = 0;
  try {
    for (let turn = 0; turn < 5; turn++) {
      const res = await anthropicClient().messages.create({
        model: route.model,
        max_tokens: 16000,
        system: args.system,
        messages,
        tools,
        ...(route.effort ? { output_config: { effort: route.effort } } : {}),
      });
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;
      searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      for (const block of res.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) sourceUrls.set(r.url, r.title);
        } else if (block.type === "text") {
          text += block.text;
        }
      }
      if (res.stop_reason === "refusal") throw new ModelRefusalError("The model declined this research request.");
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }
    await recordUsage(ctx, {
      provider: "anthropic",
      model: route.model,
      profile: "research_web",
      inputTokens: inTok,
      outputTokens: outTok,
      extraCostUsd: searches * WEB_SEARCH_USD_PER_CALL,
      latencyMs: Date.now() - started,
      success: true,
    });
    return { report: text, sourceUrls, searches };
  } catch (e) {
    await recordUsage(ctx, {
      provider: "anthropic",
      model: route.model,
      profile: "research_web",
      inputTokens: inTok,
      outputTokens: outTok,
      latencyMs: Date.now() - started,
      success: false,
      error: (e as Error).message,
    });
    throw e;
  }
}
