import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

export default defineConfig(async () => {
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: hostingConfig.d1
            ? [{
                binding: hostingConfig.d1,
                database_name: "good-cart-day-beta-interest",
                database_id: PLACEHOLDER_DATABASE_ID,
              }]
            : [],
        },
      }),
    ],
  };
});
