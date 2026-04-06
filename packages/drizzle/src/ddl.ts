import type { TableConfigInfo, TableMap } from "./types.js";

// ? generates CREATE TABLE IF NOT EXISTS SQL statements from drizzle schema objects. dialect-agnostic: the caller provides a getTableConfig function from their dialect (e.g. drizzle-orm/sqlite-core, drizzle-orm/pg-core).
export function generateCreateStatements(
	tables: TableMap,
	getTableConfig: (table: any) => TableConfigInfo,
): string[] {
	const statements: string[] = [];

	for (const table of Object.values(tables)) {
		const { name, columns, uniqueConstraints } = getTableConfig(table);

		const colDefs: string[] = columns.map((col) => {
			const parts = [`"${col.name}"`, col.getSQLType()];
			if (col.primary) parts.push("PRIMARY KEY");
			else if (col.notNull) parts.push("NOT NULL");
			if (col.isUnique) parts.push("UNIQUE");
			return parts.join(" ");
		});

		for (const uc of uniqueConstraints) {
			colDefs.push(
				`UNIQUE(${uc.columns.map((c) => `"${c.name}"`).join(", ")})`,
			);
		}

		statements.push(
			`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`,
		);
	}

	return statements;
}
