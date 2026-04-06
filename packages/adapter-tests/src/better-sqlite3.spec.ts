// ? Runs the shared suite against a second real SQLite driver (better-sqlite3),
// ? proving the suite is adapter-agnostic and pinning the shared @clay-cms/drizzle
// ? logic across two drivers. Doubles as a prototype of the future
// ? @clay-cms/db-better-sqlite3 adapter. better-sqlite3's drizzle transaction is
// ? synchronous-only, so the transaction section is skipped (supportsTransactions: false).

import {
	buildSchema,
	generateCreateStatements,
	sqliteSchemaConfig,
} from "@clay-cms/drizzle";
import Database from "better-sqlite3";
import type { DatabaseAdapterResult } from "clay-cms";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import { runDbConformance } from "./db-conformance.js";

// ? uses the shared @clay-cms/drizzle SQLite vocabulary — the same lowering every
// ? SQLite adapter (D1/libSQL) ships, so this prototype can't drift from them.
const schemaConfig = sqliteSchemaConfig;

runDbConformance({
	name: "better-sqlite3",
	supportsTransactions: false,
	makeAdapter: (): DatabaseAdapterResult => {
		const sqlite = new Database(":memory:");
		const db = drizzle(sqlite);

		return {
			name: "better-sqlite3",
			drizzle: { getDb: async () => db, provider: "sqlite", schemaConfig },
			generateInitSQL: (collections, localization) =>
				generateCreateStatements(
					buildSchema(collections, schemaConfig, localization),
					getTableConfig,
				),
		};
	},
});
