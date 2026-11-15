import { defineConfig } from "vitest/config";

// Load ../.env when present so the database tests can run locally.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  /* no .env: database tests are skipped */
}

export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false },
});
