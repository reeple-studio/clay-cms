// ? whereToDrizzle — translate the Where type from clay-cms/access into drizzle SQL.
// ? dialect-agnostic: only uses operators from drizzle-orm core (eq, and, or, inArray, sql, etc.).
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

		// ? translation-table internals are real columns on `_translations`, so
		// ? the unknown-column guard below wouldn't catch them. Deny them explicitly
		// ? at the entry point: no user-supplied `where` can pivot off `_parentId` /
		// ? `_locale` (documents the boundary for the upcoming localized-join work too).
		if (key === "_parentId" || key === "_locale") {
			throw new Error(
				`[clay-cms/drizzle] whereToDrizzle: "${key}" is a translation-table system column and cannot be used in a where clause.`,
			);
		}

		// ? own-property check, not truthiness — a key like "constructor"/"toString"
		// ? resolves to an inherited function and would slip past a `!column` guard,
		// ? feeding a non-column into opToSql.
		if (!Object.hasOwn(table, key)) {
			throw new Error(
				`[clay-cms/drizzle] whereToDrizzle: unknown column "${key}" on table.`,
			);
		}

		const column = table[key];

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

// ? Escape LIKE pattern metacharacters so user input matches as a literal substring.
// ? Order matters: backslash first, otherwise the escape char itself gets re-escaped.
// ? Paired with `ESCAPE '\'` on the emitted SQL so the DB treats `\%` / `\_` as literals.
function escapeLikePattern(raw: string): string {
	return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function opToSql(op: string, column: any, expected: unknown): SQL | undefined {
	switch (op) {
		case "equals":
			return eq(column, expected);

		case "not_equals":
			// ? NULL-inclusive to match the in-memory matchesWhere (`null !== v` is
			// ? true there). Bare `col != v` is UNKNOWN → excludes NULL rows in SQL,
			// ? so find() and the findOne/update/delete gate disagreed on the same
			// ? ACL Where for NULL-valued columns.
			return or(ne(column, expected), isNull(column));

		case "in":
			// ? non-array operand → matches nothing (fail CLOSED), same as
			// ? matchesWhere. Previously returned undefined → the clause was
			// ? dropped, so a malformed ACL `in` made find() leak the whole table.
			return Array.isArray(expected) ? inArray(column, expected) : sql`1 = 0`;

		case "not_in":
			// ? array → NULL-inclusive (parity with matchesWhere); non-array →
			// ? fail closed (matches nothing), same as matchesWhere.
			return Array.isArray(expected)
				? or(notInArray(column, expected), isNull(column))
				: sql`1 = 0`;

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

		case "like": {
			// ? Payload semantics: case-insensitive substring, `%` and `_` in the query value
			// ? are LITERAL, not wildcards. Escape them (plus the escape char itself) and
			// ? declare the escape char to LIKE. Without this, a query of "%" matches every
			// ? non-null row — CVE-class filter-widening.
			const raw = typeof expected === "string" ? expected : String(expected);
			const pattern = `%${escapeLikePattern(raw)}%`;
			return sql`LOWER(${column}) LIKE LOWER(${pattern}) ESCAPE '\\'`;
		}

		case "contains": {
			// ? for hasMany / future array fields. v2 stores arrays as JSON text → fall back to
			// ? substring match. Escape the JSON-stringified value the same way as `like` so a
			// ? payload containing `%` / `_` can't widen the filter.
			const pattern = `%${escapeLikePattern(JSON.stringify(expected))}%`;
			return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
		}

		default:
			throw new Error(
				`[clay-cms/drizzle] whereToDrizzle: unknown operator "${op}"`,
			);
	}
}
