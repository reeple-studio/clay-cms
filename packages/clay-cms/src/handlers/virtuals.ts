import type { HookParameters } from "astro";
import { addVirtualImports, createResolver } from "astro-integration-kit";

import { createVirtualBuilder } from "./virtual-builder.js";

export type VirtualsContext = {
	drizzleModuleCode: string;
	userConfigPath: string; // ? absolute path to the user’s clay.config.ts.
	initSqlStatements: string[];
};

export function injectClayVirtuals(
	params: HookParameters<"astro:config:setup">,
	ctx: VirtualsContext,
) {
	const { drizzleModuleCode, userConfigPath, initSqlStatements } = ctx;

	// ? runtime files shipped as source under src/runtime/. The virtual `api` and `init-sql` modules are one-line re-exports — actual logic lives in real, type-checked TS files.
	// ? tsup inlines this handler into dist/integration.js, so paths are resolved relative to dist/ — one level up to package root, then src/.
	const { resolve } = createResolver(import.meta.url);
	const runtimeApi = resolve("../src/runtime/api.ts");
	const runtimeInitSql = resolve("../src/runtime/init-sql.ts");

	const v = createVirtualBuilder();

	// ? code modules — runtime logic in real source files
	v.raw("virtual:clay-cms/drizzle", drizzleModuleCode);
	v.reexport("virtual:clay-cms/api", runtimeApi);
	v.reexport("virtual:clay-cms/init-sql", runtimeInitSql);

	// ? generated bridge: imports the user’s clay.config.ts as a real ESM module (so collection hooks/closures survive into workerd) and exposes the resolved shape the runtime needs.
	// ? initSqlStatements is baked in as JSON since it’s pure data computed at config time.
	v.raw(
		"virtual:clay-cms/config",
		buildConfigModule(userConfigPath, initSqlStatements),
	);

	addVirtualImports(params, {
		name: "clay-cms",
		imports: v.build(),
	});
}

function buildConfigModule(
	userConfigPath: string,
	initSqlStatements: string[],
): string {
	return [
		`import userConfig from ${JSON.stringify(userConfigPath)};`,
		`import { resolveCollections } from "clay-cms/config";`,
		"",
		"const localization = userConfig.localization ?? null;",
		"const collections = resolveCollections(userConfig.collections, localization ?? undefined);",
		"const admin = userConfig.admin;",
		`const initSqlStatements = ${JSON.stringify(initSqlStatements)};`,
		"",
		"export default { collections, localization, admin, initSqlStatements };",
	].join("\n");
}
