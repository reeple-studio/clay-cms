// ? whereToDrizzle — translate the Where type from clay-cms/access into drizzle SQL.
// ? dialect-agnostic: only uses operators from drizzle-orm core (eq, and, or, inArray, like, sql, etc.).
// ? in-memory equivalent lives in clay-cms/src/access/where.ts (matchesWhere) — same operator set, different evaluator.

import type { Where } from "clay-cms/access";
import {
	and,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";

// ? minimal drizzle table shape we need: a record of column-like things keyed by field name.
type DrizzleTable = Record<string, any>;

export function whereToDrizzle(
	where: Where | undefined,
	table: DrizzleTable,
): SQL | undefined {
	if (!where) return undefined;

	const clauses: (SQL | undefined)[] = [];

	for (const [key, constraint] of Object.entries(where)) {
		if (constraint === undefined) continue;

		if (key === "and") {
			const parts = (constraint as Where[])
				.map((sub) => whereToDrizzle(sub, table))
				.filter((c): c is SQL => c !== undefined);
			if (parts.length > 0) clauses.push(and(...parts));
			continue;
		}

		if (key === "or") {
			const parts = (constraint as Where[])
				.map((sub) => whereToDrizzle(sub, table))
				.filter((c): c is SQL => c !== undefined);
			if (parts.length > 0) clauses.push(or(...parts));
			continue;
		}

		const column = table[key];
		if (!column) {
			throw new Error(
				`[clay-cms/drizzle] whereToDrizzle: unknown column "${key}" on table.`,
			);
		}

		const field = constraint as Record<string, unknown>;

		for (const [op, expected] of Object.entries(field)) {
			clauses.push(opToSql(op, column, expected));
		}
	}

	const filtered = clauses.filter((c): c is SQL => c !== undefined);
	if (filtered.length === 0) return undefined;
	if (filtered.length === 1) return filtered[0];
	return and(...filtered);
}

function opToSql(op: string, column: any, expected: unknown): SQL | undefined {
	switch (op) {
		case "equals":
			return eq(column, expected);

		case "not_equals":
			return ne(column, expected);

		case "in":
			return Array.isArray(expected) ? inArray(column, expected) : undefined;

		case "not_in":
			return Array.isArray(expected) ? notInArray(column, expected) : undefined;

		case "exists":
			return expected ? isNotNull(column) : isNull(column);

		case "greater_than":
			return gt(column, expected);

		case "greater_than_equal":
			return gte(column, expected);

		case "less_than":
			return lt(column, expected);

		case "less_than_equal":
			return lte(column, expected);

		case "like":
			// ? Payload semantics: case-insensitive substring → LOWER(col) LIKE LOWER(?)
			return sql`LOWER(${column}) LIKE LOWER(${`%${expected}%`})`;

		case "contains":
			// ? for hasMany / future array fields. v2 stores arrays as JSON text → fall back to substring match.
			// ? once a real array column type lands this should switch to the proper operator.
			return sql`${column} LIKE ${`%${JSON.stringify(expected)}%`}`;

		default:
			throw new Error(
				`[clay-cms/drizzle] whereToDrizzle: unknown operator "${op}"`,
			);
	}
}
