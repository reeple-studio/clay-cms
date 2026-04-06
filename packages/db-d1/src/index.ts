import {
	buildSchema,
	createCrud,
	generateCreateStatements,
	type SchemaBuilderConfig,
	type TableMap,
} from "@clay-cms/drizzle";
import type {
	DatabaseAdapter,
	DatabaseAdapterResult,
	LocalizationConfig,
	ResolvedCollectionConfig,
} from "clay-cms";
import { drizzle } from "drizzle-orm/d1";
import {
	getTableConfig,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export interface D1AdapterConfig {
	binding: string;
}

// ? semantic column vocabulary lowering for SQLite (D1).
// ? `timestamp` → text storing ISO-8601 strings (Payload-aligned, matches Clay's CRUD layer).
// ? `boolean`   → integer with drizzle's mode:boolean coercion.
// ? `json`      → text with drizzle's mode:json auto parse/stringify.
const timestamp = (name: string) => text(name);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name, { mode: "json" });

const sqliteConfig: SchemaBuilderConfig = {
	tableFactory: sqliteTable,
	columns: { text, integer, boolean, timestamp, json },
	unique,
	getTableConfig,
};

export function d1(config: D1AdapterConfig): DatabaseAdapterResult {
	// ? shared lazy drizzle singleton — used by both CRUD and auth
	let db: ReturnType<typeof drizzle> | undefined;

	async function getDb(): Promise<ReturnType<typeof drizzle>> {
		if (db) return db;

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
	}

	return {
		name: "d1",
		drizzle: {
			getDb,
			provider: "sqlite",
			schemaConfig: sqliteConfig,
		},
		drizzleModuleCode: [
			`import { drizzle } from "drizzle-orm/d1";`,
			`import { sqliteTable, text, integer, unique, getTableConfig } from "drizzle-orm/sqlite-core";`,
			"",
			"// ? semantic column vocabulary lowering for SQLite (see ROADMAP P0 #3).",
			"const timestamp = (name) => text(name);",
			'const boolean = (name) => integer(name, { mode: "boolean" });',
			'const json = (name) => text(name, { mode: "json" });',
			"",
			"const schemaConfig = {",
			"  tableFactory: sqliteTable,",
			"  columns: { text, integer, boolean, timestamp, json },",
			"  unique,",
			"  getTableConfig,",
			"};",
			"",
			"let _db;",
			"export default {",
			"  async getDb() {",
			"    if (_db) return _db;",
			`    const { env } = await import("cloudflare:workers");`,
			`    _db = drizzle(env[${JSON.stringify(config.binding)}]);`,
			"    return _db;",
			"  },",
			`  provider: "sqlite",`,
			"  schemaConfig,",
			"};",
		].join("\n"),
		generateInitSQL: (
			collections: ResolvedCollectionConfig[],
			localization?: LocalizationConfig,
		): string[] => {
			const tables = buildSchema(collections, sqliteConfig, localization);
			return generateCreateStatements(tables, getTableConfig);
		},
		init: (
			collections: ResolvedCollectionConfig[],
			localization?: LocalizationConfig,
		): DatabaseAdapter => {
			const tables: TableMap = buildSchema(
				collections,
				sqliteConfig,
				localization,
			);

			let crud: ReturnType<typeof createCrud> | undefined;

			return {
				name: "d1",

				async connect() {
					const instance = await getDb();
					crud = createCrud(instance, tables, collections, localization);
				},
				async disconnect() {
					// ? d1 is HTTP-based, no connection to close
				},

				async find(collection, query, locale) {
					if (!crud) await this.connect();
					return crud!.find(collection, query, locale);
				},
				async findOne(collection, id, locale) {
					if (!crud) await this.connect();
					return crud!.findOne(collection, id, locale);
				},
				async create(collection, data, locale) {
					if (!crud) await this.connect();
					return crud!.create(collection, data, locale);
				},
				async update(collection, id, data, locale) {
					if (!crud) await this.connect();
					return crud!.update(collection, id, data, locale);
				},
				async delete(collection, id) {
					if (!crud) await this.connect();
					return crud!.delete(collection, id);
				},
			};
		},
	};
}
