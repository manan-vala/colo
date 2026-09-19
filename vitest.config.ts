import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { RP_ID: "colo.example", ORIGIN: "https://colo.example", ADMIN_TOKEN: "test-admin-token" },
      },
    }),
  ],
  // Converter tests import Word fixtures with `?inline` (a base64 data URL).
  assetsInclude: ["**/*.docx"],
  test: {
    include: ["test/**/*.test.ts"],
    // The first requests in a fresh workerd runtime load the whole Worker bundle.
    testTimeout: 30_000,
  },
});
