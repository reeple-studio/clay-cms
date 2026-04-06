import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.spec.ts"],
	},
	resolve: {
		alias: {
			"clay-cms/access": r("./packages/clay-cms/src/access/index.ts"),
			"clay-cms/auth": r("./packages/clay-cms/src/auth/index.ts"),
			"astro:middleware": r(
				"./packages/clay-cms/src/test-shims/astro-middleware.ts",
			),
			"astro:actions": r("./packages/clay-cms/src/test-shims/astro-actions.ts"),
		},
	},
});
