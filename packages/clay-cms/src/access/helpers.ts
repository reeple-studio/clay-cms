// ? access helpers — small composable predicates for collection access blocks.
// ? combinators handle the cross product of boolean and Where results (Payload parity).

import type { FieldAccessFn } from "../collections/types.js";
import type { AccessContext, AccessFn, AccessResult } from "./types.js";
import type { Where } from "./where.js";

// ? Boolean-returning predicates are usable at BOTH levels: collection
// ? `access` (typed AccessFn → boolean | Where) and field `access` (typed
// ? FieldAccessFn → boolean only). A function that always returns `boolean`
// ? satisfies both, but TypeScript needs the intersection to make the
// ? assignment legal in both slots without a cast at the call site.
type DualPredicate = AccessFn & FieldAccessFn;

export const isLoggedIn: DualPredicate = ((ctx: { user: unknown }) =>
	!!ctx.user) as DualPredicate;

export const isAdmin: DualPredicate = ((ctx: {
	user: Record<string, unknown> | null;
}) => ctx.user?.role === "admin") as DualPredicate;

// ? isSelf reads `id`, which only exists on collection AccessContext. Keep
// ? it AccessFn-only — using it at field level is meaningless (fields don't
// ? have their own id).
export const isSelf: AccessFn = ({ user, id }) =>
	!!user && !!id && user.id === id;

// ? "user owns docs where field X equals their id" — the storefront pattern.
// ? returns a Where so the runtime gate can AND-merge it into find() and pre-flight checks.
export function ownDocuments(fieldName: string): AccessFn {
	return ({ user }) => {
		if (!user) return false;
		return { [fieldName]: { equals: user.id } } as Where;
	};
}

// ? AND combinator:
// ?   - false short-circuits → false
// ?   - true is identity (drop)
// ?   - Where values accumulate into { and: [...] }
// ?   - all true → true
// ?   - mix of true + Wheres → the merged Where (or single Where if only one)
export function and(...fns: AccessFn[]): AccessFn {
	return async (ctx: AccessContext) => {
		const wheres: Where[] = [];

		for (const fn of fns) {
			const result = await fn(ctx);
			if (result === false) return false;
			if (result === true) continue;
			wheres.push(result);
		}

		if (wheres.length === 0) return true;
		if (wheres.length === 1) return wheres[0]!;

		return { and: wheres } as Where;
	};
}

// ? OR combinator:
// ?   - true short-circuits → true (most permissive wins)
// ?   - false is identity (drop)
// ?   - Where values accumulate into { or: [...] }
// ?   - all false → false
// ?   - mix produces the merged Where
export function or(...fns: AccessFn[]): AccessFn {
	return async (ctx: AccessContext) => {
		const wheres: Where[] = [];

		for (const fn of fns) {
			const result = await fn(ctx);

			if (result === true) return true;
			if (result === false) continue;

			wheres.push(result);
		}

		if (wheres.length === 0) return false;
		if (wheres.length === 1) return wheres[0]!;

		return { or: wheres } as Where;
	};
}

// ? not — boolean only. Negating a Where is ill-defined (would need a NOT operator in the type), so we coerce: Where → true (allowed) becomes false.
// ? in practice not() is only used with boolean predicates like isSelf.
export function not(fn: AccessFn): AccessFn {
	return async (ctx: AccessContext) => {
		const result: AccessResult = await fn(ctx);
		return !result;
	};
}
