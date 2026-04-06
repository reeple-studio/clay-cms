import {
	buildSchema,
	generateCreateStatements,
	sqliteSchemaConfig,
	sqliteSchemaModuleSource,
} from "@clay-cms/drizzle";
import type {
	DatabaseAdapterResult,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "clay-cms";
import { drizzle } from "drizzle-orm/d1";
import { getTableConfig } from "drizzle-orm/sqlite-core";

export interface D1AdapterConfig {
	binding: string;
}

export function d1(config: D1AdapterConfig): DatabaseAdapterResult {
	// ? shared lazy drizzle singleton
	let db: ReturnType<typeof drizzle> | undefined;
	let dbPromise: Promise<ReturnType<typeof drizzle>> | undefined;

	async function getDb(): Promise<ReturnType<typeof drizzle>> {
		if (db) return db;

		// ? single-flight: concurrent cold-start requests share one init instead
		// ? of constructing drizzle twice. Cleared on failure so the next retries.
		if (!dbPromise) {
			dbPromise = (async () => {
				const { env } = await import("cloudflare:workers");

				const binding = (env as Record<string, unknown>)[
					config.binding
				] as D1Database;

				if (!binding) {
					throw new Error(
						`[clay-cms/db-d1] Binding "${config.binding}" not found. Check your wrangler.jsonc d1_databases configuration.`,
					);
				}

				db = drizzle(binding);
				return db;
			})().finally(() => {
				dbPromise = undefined;
			});
		}

		return dbPromise;
	}

	// ? friendly diagnostic baked into the runtime module too — a missing binding
	// ? should surface this, not a cryptic "Cannot read properties of undefined"
	// ? deep inside drizzle on the first request.
	const missingBindingMsg = `[clay-cms/db-d1] Binding "${config.binding}" not found. Check your wrangler.jsonc d1_databases configuration.`;

	return {
		name: "d1",
		drizzle: {
			getDb,
			provider: "sqlite",
			schemaConfig: sqliteSchemaConfig,
		},
		drizzleModuleCode: [
			`import { drizzle } from "drizzle-orm/d1";`,
			sqliteSchemaModuleSource,
			"",
			"let _db;",
			"let _dbPromise;",
			"export default {",
			"  async getDb() {",
			"    if (_db) return _db;",
			"    if (!_dbPromise) {",
			"      _dbPromise = (async () => {",
			`        const { env } = await import("cloudflare:workers");`,
			`        const binding = env[${JSON.stringify(config.binding)}];`,
			`        if (!binding) throw new Error(${JSON.stringify(missingBindingMsg)});`,
			"        _db = drizzle(binding);",
			"        return _db;",
			"      })().finally(() => { _dbPromise = undefined; });",
			"    }",
			"    return _dbPromise;",
			"  },",
			`  provider: "sqlite",`,
			"  schemaConfig,",
			"};",
		].join("\n"),
		generateInitSQL: (
			collections: ResolvedCollectionConfig[],
			localization?: LocalizationConfig,
		): string[] => {
			const tables = buildSchema(collections, sqliteSchemaConfig, localization);
			return generateCreateStatements(tables, getTableConfig);
		},
	};
}
