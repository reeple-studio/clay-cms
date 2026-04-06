// ? Shared SQLite dialect vocabulary. Every SQLite-family adapter (D1, libSQL,
// ? better-sqlite3, …) lowers the semantic column vocabulary identically, so it
// ? lives here once instead of being re-declared in each adapter. Two forms:
// ?   - `sqliteSchemaConfig`   — the typed SchemaBuilderConfig for the config-time
// ?     paths (buildSchema / generateInitSQL / the DrizzleAccessor).
// ?   - `sqliteSchemaModuleSource` — the same vocabulary as a raw source string,
// ?     spliced into each adapter's `drizzleModuleCode` (which runs in the SSR
// ?     runtime, e.g. workerd). It defines a module-scope `schemaConfig`; the
// ?     adapter appends its driver-specific `getDb` + default export.
// ? Keeping both in one place means the runtime schemaConfig and the DDL-time
// ? sqliteConfig can never drift (the divergence hazard flagged in review).

import {
	getTableConfig,
	integer,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

import type { SchemaBuilderConfig } from "./types.js";

// ? D1/SQLite lowering — Payload-aligned, matches Clay's CRUD JS-shape contract:
// ?   timestamp → text (ISO-8601 string)   boolean → integer(mode:boolean)
// ?   json      → text(mode:json)          real    → REAL (float)
const timestamp = (name: string) => text(name);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = (name: string) => text(name, { mode: "json" });

export const sqliteSchemaConfig: SchemaBuilderConfig = {
	tableFactory: sqliteTable,
	columns: { text, integer, real, boolean, timestamp, json },
	unique,
	getTableConfig,
};

// ? The vocabulary as injectable source. Note: no `drizzle` driver import here —
// ? that's adapter-specific and prepended by each adapter. Keep the `columns`
// ? set byte-identical to `sqliteSchemaConfig` above.
export const sqliteSchemaModuleSource = [
	`import { sqliteTable, text, integer, real, unique, getTableConfig } from "drizzle-orm/sqlite-core";`,
	"",
	"// ? semantic column vocabulary lowering for SQLite (see ROADMAP P0 #3).",
	"const timestamp = (name) => text(name);",
	'const boolean = (name) => integer(name, { mode: "boolean" });',
	'const json = (name) => text(name, { mode: "json" });',
	"",
	"const schemaConfig = {",
	"  tableFactory: sqliteTable,",
	"  columns: { text, integer, real, boolean, timestamp, json },",
	"  unique,",
	"  getTableConfig,",
	"};",
].join("\n");
