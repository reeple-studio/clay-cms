import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import type { ClayCMSConfig } from "../types.js";

const CONFIG_FILENAMES = [
	"clay.config.ts",
	"clay.config.mjs",
	"clay.config.js",
];

export type LoadedClayConfig = {
	config: ClayCMSConfig;
	path: string; // ? absolute path to the user's config file.

	// ? every project file jiti loaded while importing the config — used by the
	// ? integration to register watch files so editing collections, fields, hooks,
	// ? etc. triggers an Astro dev-server reload + type regeneration.
	watchFiles: string[];
};

// ? loads the user’s `clay.config.ts` from the Astro project root using jiti (so TS imports + ESM both work in the integration’s Node process).
// ? the user passes nothing to `clay()` — discovery is convention-based, matching Payload, drizzle-kit, etc. An explicit override path is allowed.
export async function loadClayConfig(
	projectRootUrl: URL,
	override?: string,
): Promise<LoadedClayConfig> {
	const projectRoot = fileURLToPath(projectRootUrl);

	const candidate = override
		? resolvePath(projectRoot, override)
		: CONFIG_FILENAMES.map((f) => resolvePath(projectRoot, f)).find((p) =>
				existsSync(p),
			);

	if (!candidate || !existsSync(candidate)) {
		throw new Error(
			`[clay-cms] Could not find a clay config file. Expected one of ${CONFIG_FILENAMES.join(", ")} at ${projectRoot}.`,
		);
	}

	// ? moduleCache: false so each integration setup re-run (triggered by an
	// ? addWatchFile change) re-transforms and re-evaluates the config from disk
	// ? rather than handing back a stale module.
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
	});

	const mod = (await jiti.import(candidate)) as
		| ClayCMSConfig
		| { default: ClayCMSConfig };

	const config =
		(mod as { default?: ClayCMSConfig }).default ?? (mod as ClayCMSConfig);

	if (!config || !config.collections) {
		throw new Error(
			`[clay-cms] ${candidate} did not export a valid config (missing default export or "collections" array).`,
		);
	}

	// ? enumerate every project file jiti loaded so the integration can watch
	// ? them. Filter out node_modules and anything outside the project root.
	const watchFiles = collectWatchFiles(jiti.cache, projectRoot, candidate);

	return { config, path: candidate, watchFiles };
}

function collectWatchFiles(
	cache: Record<string, { filename?: string }> | undefined,
	projectRoot: string,
	configPath: string,
): string[] {
	const out = new Set<string>([configPath]);

	if (!cache) return [...out];

	for (const key of Object.keys(cache)) {
		// ? jiti cache keys are absolute file paths
		if (!key.startsWith(projectRoot)) continue;
		if (key.includes(`${"/"}node_modules${"/"}`)) continue;

		out.add(key);
	}

	return [...out];
}
