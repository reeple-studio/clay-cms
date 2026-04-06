import {
	buildSchema,
	generateCreateStatements,
	sqliteSchemaConfig,
	sqliteSchemaModuleSource,
} from "@clay-cms/drizzle";
import { createClient } from "@libsql/client";
import type {
	DatabaseAdapterResult,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "clay-cms";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig } from "drizzle-orm/sqlite-core";

export interface LibsqlAdapterConfig {
	// ? Literal connection URL. A `file:` URL is fine for local dev; for a remote
	// ? Turso DB prefer leaving this unset and using env (below) so the URL/secret
	// ? isn't baked into the SSR bundle.
	url?: string;
	authToken?: string;
	// ? Env var names read at runtime when the literals above are unset.
	// ? Default to Turso's conventional names.
	urlEnv?: string;
	authTokenEnv?: string;
}

const DEFAULT_URL_ENV = "TURSO_DATABASE_URL";
const DEFAULT_AUTH_TOKEN_ENV = "TURSO_AUTH_TOKEN";

function resolveConnection(config: LibsqlAdapterConfig): {
	url: string;
	authToken: string | undefined;
} {
	const url = config.url ?? process.env[config.urlEnv ?? DEFAULT_URL_ENV];
	const authToken =
		config.authToken ??
		process.env[config.authTokenEnv ?? DEFAULT_AUTH_TOKEN_ENV];

	if (!url) {
		throw new Error(
			`[clay-cms/db-libsql] No libSQL URL. Pass \`url\` or set the \`${config.urlEnv ?? DEFAULT_URL_ENV}\` env var (e.g. a Turso libsql:// URL, or file:local.db for dev).`,
		);
	}

	return { url, authToken };
}

export function libsql(
	config: LibsqlAdapterConfig = {},
): DatabaseAdapterResult {
	// ? shared lazy drizzle singleton
	let db: ReturnType<typeof drizzle> | undefined;
	let dbPromise: Promise<ReturnType<typeof drizzle>> | undefined;

	async function getDb(): Promise<ReturnType<typeof drizzle>> {
		if (db) return db;

		// ? single-flight: concurrent cold-start requests share one init instead
		// ? of opening two clients. Cleared on failure so the next request retries.
		if (!dbPromise) {
			dbPromise = (async () => {
				const { url, authToken } = resolveConnection(config);
				const client = createClient(authToken ? { url, authToken } : { url });
				db = drizzle(client);
				return db;
			})().finally(() => {
				dbPromise = undefined;
			});
		}

		return dbPromise;
	}

	// ? URL / token expressions baked into the runtime module: a literal when the
	// ? config carries one (local file: URLs), otherwise a process.env lookup so
	// ? remote secrets stay out of the bundle.
	const urlEnv = config.urlEnv ?? DEFAULT_URL_ENV;
	const authTokenEnv = config.authTokenEnv ?? DEFAULT_AUTH_TOKEN_ENV;
	const urlExpr =
		config.url !== undefined
			? JSON.stringify(config.url)
			: `process.env[${JSON.stringify(urlEnv)}]`;
	const authTokenExpr =
		config.authToken !== undefined
			? JSON.stringify(config.authToken)
			: `process.env[${JSON.stringify(authTokenEnv)}]`;

	return {
		name: "libsql",
		drizzle: {
			getDb,
			provider: "sqlite",
			schemaConfig: sqliteSchemaConfig,
		},
		drizzleModuleCode: [
			`import { drizzle } from "drizzle-orm/libsql";`,
			`import { createClient } from "@libsql/client";`,
			sqliteSchemaModuleSource,
			"",
			"let _db;",
			"let _dbPromise;",
			"export default {",
			"  async getDb() {",
			"    if (_db) return _db;",
			"    if (!_dbPromise) {",
			"      _dbPromise = (async () => {",
			`        const url = ${urlExpr};`,
			`        const authToken = ${authTokenExpr};`,
			'        if (!url) throw new Error("[clay-cms/db-libsql] No libSQL URL at runtime — set the connection env var.");',
			"        _db = drizzle(createClient(authToken ? { url, authToken } : { url }));",
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
