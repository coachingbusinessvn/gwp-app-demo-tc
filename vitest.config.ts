import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Bounded parallelism: every fixture pays ~10 argon2id ops (seed +
    // real logins), so unbounded workers CPU-starve each other and flake
    // on the hash budget under load. 4 keeps reasonable parallelism.
    maxWorkers: 4,
    // One retry absorbs host-level transients on this dev box (ephemeral-
    // port churn, argon2 scheduling stalls). A deterministic failure still
    // fails both attempts — nothing is masked.
    retry: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
