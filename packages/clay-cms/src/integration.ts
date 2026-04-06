import { defineIntegration, withPlugins } from "astro-integration-kit";
import { hasVitePluginPlugin } from "astro-integration-kit/plugins";

import { resolveCollections } from "./collections/resolve.js";
import { validateCollections } from "./collections/validate.js";
import { loadClayConfig } from "./handlers/load-config.js";
import { setupServer } from "./handlers/logging.js";
import { injectAdminMiddleware, injectAdminRoutes } from "./handlers/routes.js";
import { injectClayTypes } from "./handlers/types.js";
import { injectClayVirtuals } from "./handlers/virtuals.js";
import { setupVite } from "./handlers/vite.js";
import type { ClayCMSConfig, ResolvedCollectionConfig } from "./types.js";

export type ClayIntegrationOptions = {
	// ? Override the auto-discovered config file (relative to project root).
	configPath?: string;
};

export const clay = (opts: ClayIntegrationOptions = {}) => {
	return defineIntegration({
		name: "clay-cms",
		setup() {
			// ? shared closure state populated in astro:config:setup and reused
			// ? by config:done + server:setup. Hooks always run in this order.
			let userConfig: ClayCMSConfig;
			let resolved: ResolvedCollectionConfig[];

			return withPlugins({
				name: "clay-cms",
				plugins: [hasVitePluginPlugin],
				hooks: {
					"astro:config:setup": async (params) => {
						const loaded = await loadClayConfig(
							params.config.root,
							opts.configPath,
						);

						userConfig = loaded.config;

						// ? watch the config file + every project file it imports
						// ? (collections, hooks, helpers) so editing any of them
						// ? triggers an Astro reload → integration setup re-runs →
						// ? types regenerate. Auto-typegen, no CLI required.
						for (const file of loaded.watchFiles) {
							params.addWatchFile(file);
						}

						validateCollections(
							userConfig.collections,
							userConfig.localization,
							userConfig.admin,
						);

						resolved = resolveCollections(
							userConfig.collections,
							userConfig.localization,
						);

						if (!userConfig.db.drizzle || !userConfig.db.drizzleModuleCode) {
							throw new Error(
								"[clay-cms] Database adapter must expose `drizzle` and `drizzleModuleCode`. Ensure your adapter supports DrizzleAccessor (required for the SSR runtime, e.g. workerd).",
							);
						}

						const initSqlStatements = userConfig.db.generateInitSQL
							? userConfig.db.generateInitSQL(resolved, userConfig.localization)
							: [];

						setupVite(params);

						injectClayVirtuals(params, {
							drizzleModuleCode: userConfig.db.drizzleModuleCode,
							userConfigPath: loaded.path,
							initSqlStatements,
						});

						injectAdminRoutes(params);
						injectAdminMiddleware(params);
					},
					"astro:config:done": (params) => {
						injectClayTypes(params, resolved);
					},
					"astro:server:setup": () => {
						setupServer({ config: userConfig, resolved });
					},
				},
			});
		},
	})();
};
