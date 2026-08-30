import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Two projects: the Worker runs in a real Workers runtime; the browser modules under
// public/app/ run in happy-dom, with fetch stubbed by tests/dom/setup.js.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./src/db/migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.example.toml" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/**/*.test.js"],
            exclude: ["tests/dom/**"],
            setupFiles: ["./tests/helpers/setup.js"],
          },
        },
        {
          test: {
            name: "dom",
            environment: "happy-dom",
            include: ["tests/dom/**/*.test.js"],
            setupFiles: ["./tests/dom/setup.js"],
          },
        },
      ],
      coverage: {
        provider: "istanbul",
        include: ["src/**/*.js", "public/app/**/*.js"],
        reporter: ["text-summary", "text"],
      },
    },
  };
});
