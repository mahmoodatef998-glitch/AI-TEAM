/** USD per 1M tokens. Used for AI cost tracking in `ai_usage`. Update when provider prices change. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

/** Web search server tool: USD per search (Anthropic list price; verify on your invoice). */
export const WEB_SEARCH_USD_PER_CALL = 0.01;

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null; // unknown pricing (e.g. Grok) — recorded as 0 and flagged in the UI
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
