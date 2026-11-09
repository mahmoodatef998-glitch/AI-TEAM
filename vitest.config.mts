import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(root, "src") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000, pool: "forks" },
});
