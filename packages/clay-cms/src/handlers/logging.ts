import type { ClayCMSConfig, ResolvedCollectionConfig } from "../types.js";

export type ServerSetupContext = {
	config: ClayCMSConfig;
	resolved: ResolvedCollectionConfig[];
};

export function setupServer(ctx: ServerSetupContext) {
	const { config, resolved } = ctx;

	console.log(`[clay-cms] db: ${config.db.name}`);
	console.log(`[clay-cms] storage: ${config.storage.name}`);
	console.log(
		`[clay-cms] collections: ${resolved.map((c) => c.slug).join(", ")}`,
	);

	if (config.localization) {
		console.log(
			`[clay-cms] localization: ${config.localization.locales.join(", ")} (default: ${config.localization.defaultLocale})`,
		);
	}

	if (config.admin) {
		console.log(
			`[clay-cms] auth: collection "${config.admin.user}" (session-based)`,
		);
	}

	config.db.init(resolved, config.localization);
}
