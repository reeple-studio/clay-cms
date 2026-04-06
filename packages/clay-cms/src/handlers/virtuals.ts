import { fileURLToPath } from "node:url";

import type { HookParameters } from "astro";

import { createVirtualBuilder } from "./virtual-builder.js";

export type VirtualsContext = {
	drizzleModuleCode: string;
	userConfigPath: string; // ? absolute path to the user’s clay.config.ts.
	initSqlStatements: string[];
};

// ? minimal structural shape for a Vite virtual-module plugin. avoids a direct
// ? `vite` dependency — astro nests its own vite under .pnpm, unresolvable from here.
type ClayVitePlugin = {
	name: string;
	resolveId(id: string): string | undefined;
	load(id: string): string | undefined;
};

export function injectClayVirtuals(
	params: HookParameters<"astro:config:setup">,
	ctx: VirtualsContext,
) {
	const { drizzleModuleCode, userConfigPath, initSqlStatements } = ctx;

	// ? runtime files shipped as source under src/runtime/. The virtual `api` and `init-sql` modules are one-line re-exports — actual logic lives in real, type-checked TS files.
	// ? tsup inlines this handler into dist/integration.js, so paths are resolved relative to dist/ — one level up to package root, then src/.
	const runtimeApi = fileURLToPath(
		new URL("../src/runtime/api.ts", import.meta.url),
	);
	const runtimeInitSql = fileURLToPath(
		new URL("../src/runtime/init-sql.ts", import.meta.url),
	);

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

	params.updateConfig({
		vite: { plugins: [clayVirtualsPlugin(v.build())] },
	});
}

// ? hand-rolled virtual-module plugin, replacing astro-integration-kit’s addVirtualImports.
// ? resolveId tags a known id with a leading \0 (Vite convention for virtual modules, so no real file lookup happens); load strips it and returns the pre-built source string.
// ? one identical source string serves every environment, so no ssr/client branching is needed.
function clayVirtualsPlugin(imports: Record<string, string>): ClayVitePlugin {
	return {
		name: "vite-plugin-clay-cms",
		resolveId(id) {
			if (id in imports) {
				return `\0${id}`;
			}
			return undefined;
		},
		load(id) {
			if (id.startsWith("\0")) {
				const real = id.slice(1);
				if (real in imports) {
					return imports[real];
				}
			}
			return undefined;
		},
	};
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
