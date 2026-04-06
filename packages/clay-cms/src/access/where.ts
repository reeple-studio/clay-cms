// ? Where type + matchesWhere evaluator — the day-one operator surface for ACL v2 and CRUD query operators.
// ? Same shape as Payload's Where (subset). Used by:
// ?   - ACL v2: access fns return `boolean | Where`
// ?   - CRUD: `find({ where })` user-supplied filter
// ?   - Admin: filter UI (future)
// ? Two evaluators share this type:
// ?   - matchesWhere(where, doc) — in-memory, here, for findOne/create/update/delete pre-flight checks
// ?   - whereToDrizzle(where, table) — SQL, in @clay-cms/drizzle, for find() SELECTs

export type WhereOperator =
	| "equals"
	| "not_equals"
	| "in"
	| "not_in"
	| "exists"
	| "greater_than"
	| "greater_than_equal"
	| "less_than"
	| "less_than_equal"
	| "like"
	| "contains";

export type WhereField = {
	[K in WhereOperator]?: unknown;
};

export interface Where {
	[field: string]: WhereField | Where[] | undefined;
	and?: Where[];
	or?: Where[];
}

// ? in-memory Where evaluator. Returns true if `doc` matches `where`.
// ? Empty where ({}) matches everything (Payload semantics).
export function matchesWhere(
	where: Where | undefined,
	doc: Record<string, unknown> | null | undefined,
): boolean {
	if (!where) return true;
	if (!doc) return false;

	for (const [key, constraint] of Object.entries(where)) {
		if (constraint === undefined) continue;

		if (key === "and") {
			const arr = constraint as Where[];

			for (const sub of arr) {
				if (!matchesWhere(sub, doc)) return false;
			}

			continue;
		}

		if (key === "or") {
			const arr = constraint as Where[];
			if (arr.length === 0) continue;

			let any = false;

			for (const sub of arr) {
				if (matchesWhere(sub, doc)) {
					any = true;
					break;
				}
			}

			if (!any) return false;

			continue;
		}

		const value = doc[key];
		const field = constraint as WhereField;

		for (const [op, expected] of Object.entries(field)) {
			if (!matchOp(op as WhereOperator, value, expected)) return false;
		}
	}

	return true;
}

function matchOp(
	op: WhereOperator,
	value: unknown,
	expected: unknown,
): boolean {
	switch (op) {
		case "equals":
			return value === expected;

		case "not_equals":
			return value !== expected;

		case "in":
			return Array.isArray(expected) && expected.includes(value);

		case "not_in":
			return Array.isArray(expected) && !expected.includes(value);

		case "exists":
			return expected ? value != null : value == null;

		case "greater_than":
			return (
				isComparable(value, expected) &&
				(value as number) > (expected as number)
			);

		case "greater_than_equal":
			return (
				isComparable(value, expected) &&
				(value as number) >= (expected as number)
			);

		case "less_than":
			return (
				isComparable(value, expected) &&
				(value as number) < (expected as number)
			);

		case "less_than_equal":
			return (
				isComparable(value, expected) &&
				(value as number) <= (expected as number)
			);

		case "like":
			// ? Payload semantics: case-insensitive substring
			return (
				typeof value === "string" &&
				typeof expected === "string" &&
				value.toLowerCase().includes(expected.toLowerCase())
			);

		case "contains":
			// ? for hasMany / array fields: array contains the expected value
			return Array.isArray(value) && value.includes(expected);

		default:
			return false;
	}
}

function isComparable(a: unknown, b: unknown): boolean {
	return (
		a != null &&
		b != null &&
		(typeof a === "number" || typeof a === "string") &&
		typeof a === typeof b
	);
}

// ? AND-merge two Wheres into one. Used to combine ACL constraints with user-supplied filters.
// ? Either side may be undefined.
export function andWhere(
	a: Where | undefined,
	b: Where | undefined,
): Where | undefined {
	if (!a) return b;
	if (!b) return a;
	return { and: [a, b] };
}

// ? OR-merge two Wheres into one. Used by the `or()` access combinator when multiple fns return Where.
export function orWhere(
	a: Where | undefined,
	b: Where | undefined,
): Where | undefined {
	if (!a) return b;
	if (!b) return a;
	return { or: [a, b] };
}
