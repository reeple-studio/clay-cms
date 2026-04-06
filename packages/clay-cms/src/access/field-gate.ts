// ? field-level access — boolean-only, Payload-aligned, Clay-shaped.
// ?
// ? Three primitives, one source of truth (the resolved field map):
// ?
// ?   evaluateFieldAccess(collection, ctx)         → Map<name, FieldPermissions>
// ?   applyReadFieldAccess(collection, doc, ctx)   → strips read-denied fields
// ?   applyWriteFieldAccess(collection, data, op, ctx, existing?)
// ?                                                → silent-drops write-denied fields
// ?
// ? Skip rules (hot path):
// ?   - the runtime checks `collection.hasFieldLevelAccess?.<op>` before
// ?     calling these helpers, so collections without any field-level rules
// ?     pay zero cost.
// ?   - overrideAccess: true also skips, in the runtime gate (Payload parity:
// ?     bypass means bypass all access — collection AND field).
// ?
// ? Update semantics: silent drop with a dev-mode console.warn breadcrumb.
// ? Throwing on a denied write would force the admin UI (and any user form)
// ? to perfectly match the current user's permissions before submitting,
// ? which defeats the point of having field-level ACL in the first place.

import type {
	FieldAccessContext,
	FieldAccessFn,
	FieldAccessOperation,
	ResolvedCollectionConfig,
} from "../collections/types.js";

export interface FieldPermissions {
	canRead: boolean;
	canUpdate: boolean;
}

export interface FieldAccessUserContext {
	user: Record<string, unknown> | null;
}

// ? evaluator shared by all three helpers — runs the per-field fn (if any),
// ? returns true when no rule is defined (default-allow at field level —
// ? gating happens at collection level first).
async function evaluateOne(
	fn: FieldAccessFn | undefined,
	ctx: FieldAccessContext,
): Promise<boolean> {
	if (!fn) return true;
	return await fn(ctx);
}

function makeCtx(
	collection: ResolvedCollectionConfig,
	op: FieldAccessOperation,
	user: Record<string, unknown> | null,
	doc: Record<string, unknown> | null | undefined,
	data: Record<string, unknown> | undefined,
): FieldAccessContext {
	const ctx: FieldAccessContext = {
		user,
		operation: op,
		collection: collection.slug,
	};

	if (doc !== undefined) ctx.doc = doc;
	if (data !== undefined) {
		ctx.data = data;
		// ? siblingData mirrors data for top-level fields. Once group/array/blocks
		// ? land, the parent walker will pass the nested object instead.
		ctx.siblingData = data;
	}

	return ctx;
}

// ? Strip fields the current user can't read. Returns a NEW object — never
// ? mutates the input — so the runtime can call this after hooks without
// ? worrying about leaking the stripped shape back into hook closures.
export async function applyReadFieldAccess(
	collection: ResolvedCollectionConfig,
	doc: Record<string, unknown>,
	user: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};

	for (const [name, field] of Object.entries(collection.fields)) {
		const fn = field.access?.read;

		if (!fn) {
			// ? no rule → keep the field. Default-allow at field level.
			if (name in doc) out[name] = doc[name];
			continue;
		}

		const allowed = await evaluateOne(
			fn,
			makeCtx(collection, "read", user, doc, undefined),
		);

		if (allowed && name in doc) out[name] = doc[name];
	}

	return out;
}

// ? Drop fields the current user can't write. Returns a NEW object so the
// ? caller can hand it straight to CRUD without aliasing.
// ? `existing` is the pre-update doc (null on create) — passed through as
// ? `doc` on the access ctx so update rules can compare old/new.
export async function applyWriteFieldAccess(
	collection: ResolvedCollectionConfig,
	data: Record<string, unknown>,
	op: "create" | "update",
	user: Record<string, unknown> | null,
	existing?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	const dropped: string[] = [];

	for (const [name, value] of Object.entries(data)) {
		const field = collection.fields[name];
		// ? unknown field → leave it alone, the validator owns that error
		if (!field) {
			out[name] = value;
			continue;
		}

		const fn = field.access?.[op];

		if (!fn) {
			out[name] = value;
			continue;
		}

		const allowed = await evaluateOne(
			fn,
			makeCtx(collection, op, user, existing ?? null, data),
		);

		if (allowed) {
			out[name] = value;
		} else {
			dropped.push(name);
		}
	}

	// ? dev-mode breadcrumb so a typo or stale form doesn't look like a phantom
	// ? bug. Production stays silent — Payload parity.
	if (
		dropped.length > 0 &&
		typeof process !== "undefined" &&
		process.env?.NODE_ENV !== "production"
	) {
		console.warn(
			`[clay-cms] field-level access dropped ${dropped.length} field(s) on ${op} "${collection.slug}": ${dropped.join(", ")}`,
		);
	}

	return out;
}

// ? Per-field permissions snapshot for the admin UI. One walk, one Map; the
// ? edit page iterates collection.fields and looks up each name. Computes
// ? both read and update in a single pass — admin renders both decisions.
export async function evaluateFieldAccess(
	collection: ResolvedCollectionConfig,
	doc: Record<string, unknown> | null,
	user: Record<string, unknown> | null,
): Promise<Map<string, FieldPermissions>> {
	const out = new Map<string, FieldPermissions>();

	for (const [name, field] of Object.entries(collection.fields)) {
		const canRead = await evaluateOne(
			field.access?.read,
			makeCtx(collection, "read", user, doc, undefined),
		);

		const canUpdate = await evaluateOne(
			field.access?.update,
			makeCtx(collection, "update", user, doc, undefined),
		);

		out.set(name, { canRead, canUpdate });
	}

	return out;
}
