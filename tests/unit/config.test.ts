import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.js";

const strong = {
  DATABASE_URL: "postgres://gwp_runtime:x@127.0.0.1:5432/gwp",
  JWT_SECRET: "4f9c2b7e1d8a6f3c0b5e9d2a7c4f1e8b",
  APP_KEY: "a3e8f1c6d9b2e5a8f1c4d7b0e3a6f9c2",
  BOOTSTRAP_TOKEN: "7d1e4a9c2f5b8e1d4a7c0f3b6e9d2a5c",
  APP_ORIGIN: "https://gwp.example.vn",
  NODE_ENV: "production",
};

describe("loadConfig production secret floor", () => {
  it("accepts strong random secrets", () => {
    expect(() => loadConfig({ ...strong })).not.toThrow();
  });

  it("rejects secrets shorter than 32 chars", () => {
    expect(() => loadConfig({ ...strong, JWT_SECRET: "short" })).toThrow(
      /JWT_SECRET < 32 chars/,
    );
  });

  it("rejects the .env.example placeholders even though they are long enough", () => {
    expect(() =>
      loadConfig({
        ...strong,
        JWT_SECRET: "dummy-jwt-secret-change-me-000000000000",
        APP_KEY: "dummy-app-key-change-me-0000000000000000",
      }),
    ).toThrow(/JWT_SECRET is a \.env\.example placeholder, APP_KEY is a/);
  });

  it("does not apply the placeholder check outside production", () => {
    expect(() =>
      loadConfig({
        ...strong,
        NODE_ENV: "development",
        JWT_SECRET: "dummy-jwt-secret-change-me-000000000000",
      }),
    ).not.toThrow();
  });
});
