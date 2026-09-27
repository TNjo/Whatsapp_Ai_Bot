import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      PGLITE_DIR: "memory://",
      AI_PROVIDER: "mock",
      META_APP_ID: "1234567890",
      META_APP_SECRET: "test-app-secret",
      META_WEBHOOK_VERIFY_TOKEN: "verify-me",
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      LOG_LEVEL: "silent",
      APP_URL: "https://shop.example.com",
    },
  },
});
