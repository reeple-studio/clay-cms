// @ts-nocheck — shipped as source, type-checked in the consumer's Vite/Astro pipeline.
// ? local API runtime: builds the cms.<slug>.find() proxy on top of @clay-cms/drizzle.
// ? hooks live on collection objects (imported from the user’s clay.config.ts via virtual:clay-cms/config) so closures survive into workerd. No separate hooks codegen module.

import config from "virtual:clay-cms/config";
import drizzle from "virtual:clay-cms/drizzle";
import { buildSchema, createCrud } from "@clay-cms/drizzle";
import {
	AccessDeniedError,
	andWhere,
	applyReadFieldAccess,
	applyWriteFieldAccess,
	matchesWhere,
} from "clay-cms/access";

const { collections, localization } = config;

// ? slug → ResolvedCollectionConfig lookup, used to read hooks + access at request time
const collectionsBySlug = new Map(collections.map((c) => [c.slug, c]));

// ? schemaConfig comes from the db adapter via the drizzle virtual module — see
// ? ROADMAP P0 #3. The adapter ecosystem is the dialect registry; this file
// ? imports zero dialect-specific drizzle packages and works with any adapter
// ? that exposes a SchemaBuilderConfig.

let _tables;
let _crud;

function ensureTables() {
	if (!_tables) {
		_tables = buildSchema(
			collections,
			drizzle.schemaConfig,
			localization ?? undefined,
		);
	}

	return _tables;
}

async function getCrud() {
	if (_crud) return _crud;

	ensureTables();

	const db = await drizzle.getDb();
	_crud = createCrud(db, _tables, collections, localization ?? undefined);

	return _crud;
}

function hooksFor(slug) {
	return collectionsBySlug.get(slug)?.hooks;
}

// ? user passed to hooks is null, never undefined — anonymous and bypass
// ? both surface as null so hooks don't have to distinguish them.
function hookUser(opts) {
	return opts?.user ?? null;
}

// ? hooks share a per-operation scratchpad. Caller can pass their own via
// ? opts.context (Payload parity); otherwise we mint a fresh {} per op.
// ? Critically, the SAME object must reach beforeChange and afterChange — so
// ? each proxy method calls withContext() once at entry and passes the
// ? returned opts to every hook runner, instead of re-evaluating per call.
function withContext(opts) {
	if (opts?.context) return opts;
	return { ...(opts ?? {}), context: {} };
}

function hookContext(opts) {
	return opts?.context ?? {};
}

async function runBeforeChange(slug, data, operation, opts, originalDoc) {
	const hooks = hooksFor(slug)?.beforeChange;

	if (!hooks) return data;

	let current = data;
	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		const args = {
			data: current,
			operation,
			collection: slug,
			user,
			context,
		};
		if (originalDoc !== undefined && originalDoc !== null) {
			args.originalDoc = originalDoc;
			args.id = opts?.id;
		}

		const result = await hook(args);
		if (result !== undefined && result !== null) current = result;
	}

	return current;
}

async function runAfterChange(slug, doc, operation, opts, previousDoc) {
	const hooks = hooksFor(slug)?.afterChange;

	if (!hooks) return;

	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		const args = {
			doc,
			operation,
			collection: slug,
			user,
			context,
		};
		if (previousDoc !== undefined && previousDoc !== null) {
			args.previousDoc = previousDoc;
			args.id = opts?.id;
		}

		await hook(args);
	}
}

// ? per-doc, sequential, awaited. Runs once per row in find() and once in findOne().
// ? before* fires on the raw doc as loaded; after* fires on the projected doc.
async function runBeforeRead(slug, doc, opts) {
	const hooks = hooksFor(slug)?.beforeRead;
	if (!hooks || doc == null) return doc;

	let current = doc;
	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		const result = await hook({
			doc: current,
			collection: slug,
			user,
			context,
		});
		if (result !== undefined && result !== null) current = result;
	}

	return current;
}

async function runAfterRead(slug, doc, opts) {
	const hooks = hooksFor(slug)?.afterRead;
	if (!hooks || doc == null) return doc;

	let current = doc;
	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		const result = await hook({
			doc: current,
			collection: slug,
			user,
			context,
		});
		if (result !== undefined && result !== null) current = result;
	}

	return current;
}

async function runBeforeDelete(slug, id, doc, opts) {
	const hooks = hooksFor(slug)?.beforeDelete;
	if (!hooks) return;

	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		await hook({ id, doc, collection: slug, user, context });
	}
}

async function runAfterDelete(slug, id, doc, opts) {
	const hooks = hooksFor(slug)?.afterDelete;
	if (!hooks) return;

	const user = hookUser(opts);
	const context = hookContext(opts);

	for (const hook of hooks) {
		await hook({ id, doc, collection: slug, user, context });
	}
}

// ? gate — single chokepoint for access enforcement.
// ? Returns:
// ?   undefined → unrestricted (bypass, no access fn, or fn returned true)
// ?   Where     → caller must apply this constraint (filter find / pre-flight check single-doc ops)
// ? Throws AccessDeniedError when the fn returns false.
// ? Single bypass rule:
// ?   overrideAccess === true → root mode, skip the gate entirely
// ? Otherwise we enforce. Missing user defaults to null (anonymous) — secure
// ? by default: forgetting to pass `user` is denied, not leaked.
async function runAccess(slug, op, opts, extra = {}) {
	if (opts?.overrideAccess === true) return undefined;

	const collection = collectionsBySlug.get(slug);
	const fn = collection?.access?.[op];

	if (!fn) return undefined;

	const ctx = {
		user: opts?.user ?? null,
		operation: op,
		collection: slug,
		...extra,
	};

	const result = await fn(ctx);

	if (result === false) throw new AccessDeniedError(slug, op);
	if (result === true) return undefined;

	// ? Where return — caller applies it
	return result;
}

// ? Pre-flight check for single-doc ops (findOne / update / delete / create).
// ? If the gate returned a Where, the doc/data must match it or the op is denied.
function enforceWhereOrThrow(slug, op, where, doc) {
	if (!where) return;

	if (!matchesWhere(where, doc)) {
		throw new AccessDeniedError(slug, op);
	}
}

// ? per-slug operation factory. takes a `crudGetter` so the same gate +
// ? hooks logic can run against either the lazy module-level crud (default)
// ? or a tx-bound crud built inside cms.transaction(fn). Refactored out of
// ? the Proxy in the transaction(fn) slice (ROADMAP P0 #4) — every method
// ? body is byte-for-byte identical to the pre-refactor version, the only
// ? change is `await getCrud()` → `await crudGetter()`.
function makeOps(slug, crudGetter) {
	return {
		find: async (opts) => {
			opts = withContext(opts);
			const aclWhere = await runAccess(slug, "read", opts);
			const c = await crudGetter();

			// ? AND-merge ACL constraint with user-supplied filter
			const merged = andWhere(aclWhere, opts?.where);

			const rows = await c.find(
				slug,
				merged,
				opts?.locale,
				opts?.showHiddenFields,
			);

			// ? per-doc read hooks + field-level ACL strip. Skip the loop
			// ? entirely when nothing is defined — same hot-path rule as hooks.
			// ? Bypass mode (overrideAccess: true) skips the field-gate too,
			// ? Payload parity: bypass means bypass ALL access.
			const hooks = hooksFor(slug);
			const collection = collectionsBySlug.get(slug);
			const fieldGateOn =
				opts?.overrideAccess !== true &&
				collection?.hasFieldLevelAccess?.read === true;

			if (!hooks?.beforeRead && !hooks?.afterRead && !fieldGateOn) {
				return rows;
			}

			const user = opts?.user ?? null;
			const out = [];
			for (const row of rows) {
				let d = await runBeforeRead(slug, row, opts);
				d = await runAfterRead(slug, d, opts);
				if (fieldGateOn && d != null) {
					d = await applyReadFieldAccess(collection, d, user);
				}
				out.push(d);
			}
			return out;
		},

		findOne: async (opts) => {
			opts = withContext(opts);
			const c = await crudGetter();

			const raw = await c.findOne(
				slug,
				opts.id,
				opts?.locale,
				opts?.showHiddenFields,
			);

			const aclWhere = await runAccess(slug, "read", opts, {
				id: opts.id,
				doc: raw,
			});

			enforceWhereOrThrow(slug, "read", aclWhere, raw);

			if (raw == null) return raw;

			let doc = await runBeforeRead(slug, raw, opts);
			doc = await runAfterRead(slug, doc, opts);

			const findOneCollection = collectionsBySlug.get(slug);
			if (
				opts?.overrideAccess !== true &&
				findOneCollection?.hasFieldLevelAccess?.read === true &&
				doc != null
			) {
				doc = await applyReadFieldAccess(
					findOneCollection,
					doc,
					opts?.user ?? null,
				);
			}

			return doc;
		},

		create: async (opts) => {
			opts = withContext(opts);
			const aclWhere = await runAccess(slug, "create", opts);

			// ? Where on create → match against incoming data (Payload parity)
			enforceWhereOrThrow(slug, "create", aclWhere, opts.data);

			const c = await crudGetter();

			// ? field-level ACL: silent-drop denied fields BEFORE hooks see
			// ? the data, so a beforeChange hook can't sneak a value past the
			// ? field gate. Bypass mode skips this (Payload parity).
			const createCol = collectionsBySlug.get(slug);
			let incoming = opts.data;
			if (
				opts?.overrideAccess !== true &&
				createCol?.hasFieldLevelAccess?.create === true
			) {
				incoming = await applyWriteFieldAccess(
					createCol,
					incoming,
					"create",
					opts?.user ?? null,
					null,
				);
			}

			const data = await runBeforeChange(slug, incoming, "create", opts);

			const doc = await c.create(slug, data, opts?.locale);

			await runAfterChange(slug, doc, "create", opts);

			return doc;
		},

		update: async (opts) => {
			opts = withContext(opts);
			const c = await crudGetter();

			// ? load existing doc only when we're going to enforce (non-bypass)
			let existing = null;

			if (opts?.overrideAccess !== true) {
				existing = await c.findOne(slug, opts.id);
			}

			const aclWhere = await runAccess(slug, "update", opts, {
				id: opts.id,
				doc: existing,
			});

			enforceWhereOrThrow(slug, "update", aclWhere, existing);

			// ? immutable invariant — auth-collection role demotions can never:
			// ?   (a) demote the currently-acting admin (self-demote → locks yourself out)
			// ?   (b) leave zero admins in the collection (last-admin demote)
			// ? mirrors the delete invariant; not user-overridable.
			const updateCollection = collectionsBySlug.get(slug);
			if (
				updateCollection?.auth === true &&
				opts?.overrideAccess !== true &&
				existing?.role === "admin" &&
				"role" in (opts.data ?? {}) &&
				opts.data.role !== "admin"
			) {
				if (opts.user?.id === opts.id) {
					throw new AccessDeniedError(
						slug,
						"update",
						"[clay-cms] cannot demote your own admin account.",
					);
				}

				const all = await c.find(slug);

				const remainingAdmins = all.filter(
					(u) => u.role === "admin" && u.id !== opts.id,
				);

				if (remainingAdmins.length === 0) {
					throw new AccessDeniedError(
						slug,
						"update",
						`[clay-cms] cannot demote the last admin in collection "${slug}".`,
					);
				}
			}

			// ? hooks need originalDoc/previousDoc. The gate already loaded
			// ? `existing` for non-bypass calls; in bypass mode we load it
			// ? lazily, but only when hooks would actually use it (don't pay
			// ? the read cost otherwise).
			const updateHooks = hooksFor(slug);
			if (
				existing == null &&
				(updateHooks?.beforeChange || updateHooks?.afterChange)
			) {
				existing = await c.findOne(slug, opts.id);
			}

			// ? field-level ACL: silent-drop denied fields BEFORE hooks see
			// ? the data — same rule as create. Uses `existing` so update
			// ? rules can compare old vs new (e.g. "only admins can change role").
			let incomingUpdate = opts.data;
			if (
				opts?.overrideAccess !== true &&
				updateCollection?.hasFieldLevelAccess?.update === true
			) {
				incomingUpdate = await applyWriteFieldAccess(
					updateCollection,
					incomingUpdate,
					"update",
					opts?.user ?? null,
					existing,
				);
			}

			const data = await runBeforeChange(
				slug,
				incomingUpdate,
				"update",
				opts,
				existing,
			);

			const doc = await c.update(slug, opts.id, data, opts?.locale);

			await runAfterChange(slug, doc, "update", opts, existing);

			return doc;
		},

		// ? "would this op succeed?" — used by the admin UI to hide buttons
		// ? the user can't act on. Runs the gate, catches AccessDeniedError,
		// ? returns boolean. No mutation, no hooks. For ops that need a doc
		// ? (read/update/delete), pass { id } and we'll load it; or pass
		// ? { doc } directly.
		can: async (op, opts) => {
			if (op === "read" || op === "update" || op === "delete") {
				const c = await crudGetter();

				let doc = opts?.doc ?? null;

				if (!doc && opts?.id) {
					doc = await c.findOne(slug, opts.id);
				}

				try {
					const aclWhere = await runAccess(slug, op, opts ?? {}, {
						id: opts?.id,
						doc,
					});

					if (aclWhere && !matchesWhere(aclWhere, doc)) return false;

					return true;
				} catch (err) {
					if (err instanceof AccessDeniedError) return false;
					throw err;
				}
			}

			if (op === "create") {
				try {
					const aclWhere = await runAccess(slug, "create", opts ?? {});

					if (aclWhere && !matchesWhere(aclWhere, opts?.data ?? {}))
						return false;
					return true;
				} catch (err) {
					if (err instanceof AccessDeniedError) return false;
					throw err;
				}
			}

			// ? admin or anything else — boolean only
			try {
				const result = await runAccess(slug, op, opts ?? {});
				return result === undefined; // ? undefined means unrestricted/allowed
			} catch (err) {
				if (err instanceof AccessDeniedError) return false;
				throw err;
			}
		},

		delete: async (opts) => {
			opts = withContext(opts);
			const c = await crudGetter();

			// ? load existing doc only when we're going to enforce (non-bypass)
			let existing = null;

			if (opts?.overrideAccess !== true) {
				existing = await c.findOne(slug, opts.id);
			}

			const aclWhere = await runAccess(slug, "delete", opts, {
				id: opts.id,
				doc: existing,
			});

			enforceWhereOrThrow(slug, "delete", aclWhere, existing);

			// ? immutable invariant — auth-collection deletes can never:
			// ?   (a) delete the currently-acting user (self-delete)
			// ?   (b) leave zero rows in the auth collection (last-user)
			// ? this guard is NOT user-overridable; it's the bug the whole
			// ? ACL system was built to make impossible.
			const collection = collectionsBySlug.get(slug);

			if (collection?.auth === true && opts?.overrideAccess !== true) {
				if (opts.user?.id === opts.id) {
					throw new AccessDeniedError(
						slug,
						"delete",
						"[clay-cms] cannot delete your own account.",
					);
				}

				const remaining = await c.find(slug);

				if (remaining.length <= 1) {
					throw new AccessDeniedError(
						slug,
						"delete",
						`[clay-cms] cannot delete the last user in collection "${slug}".`,
					);
				}
			}

			// ? hooks always receive the doc. Load it now if the gate didn't
			// ? already (bypass path) AND hooks are defined.
			const deleteHooks = hooksFor(slug);
			if (
				existing == null &&
				(deleteHooks?.beforeDelete || deleteHooks?.afterDelete)
			) {
				existing = await c.findOne(slug, opts.id);
			}

			await runBeforeDelete(slug, opts.id, existing, opts);
			await c.delete(slug, opts.id);
			await runAfterDelete(slug, opts.id, existing, opts);
		},
	};
}

// ? cms.transaction(fn) — Payload-style atomic block, Clay-style minimal.
// ?
// ? On adapters whose drizzle driver exposes db.transaction (better-sqlite3,
// ? postgres-js, libsql) the callback runs inside a real interactive
// ? transaction: any throw — including from after* hooks — rolls back every
// ? write made through the `tx` proxy. The `tx` arg is a cms-shaped proxy
// ? whose CRUD calls share a tx-bound crud; access control still enforces
// ? exactly as it does on the global cms (every call carries `user` /
// ? overrideAccess explicitly — no implicit bypass inside the block).
// ?
// ? On D1 (whose HTTP driver has no interactive transaction primitive — it
// ? exposes db.batch() instead, used internally by crud.ts to keep localized
// ? writes atomic) cms.transaction throws a clear error rather than lying
// ? about rollback semantics. Wait for the libsql / postgres adapters, or
// ? rely on the per-op atomicity that batch already gives you.
async function transaction(fn) {
	const db = await drizzle.getDb();

	if (typeof db.transaction !== "function") {
		throw new Error(
			"[clay-cms] cms.transaction(fn) requires an adapter whose drizzle driver supports interactive transactions. Cloudflare D1 does not — its HTTP model has no BEGIN/COMMIT primitive. Localized writes are still atomic via db.batch() inside CRUD; for multi-op atomicity, use a libsql/postgres/better-sqlite3 adapter.",
		);
	}

	return db.transaction(async (tx) => {
		let txCrud;

		const txCrudGetter = async () => {
			if (txCrud) return txCrud;
			ensureTables();
			txCrud = createCrud(tx, _tables, collections, localization ?? undefined);
			return txCrud;
		};

		const txProxy = new Proxy(
			{},
			{
				get(_, slug) {
					if (slug === "transaction") {
						throw new Error(
							"[clay-cms] nested cms.transaction(fn) is not supported.",
						);
					}
					if (slug === "__tables") return () => ensureTables();
					if (slug === "__db") return () => tx;
					if (typeof slug !== "string") return undefined;
					return makeOps(slug, txCrudGetter);
				},
			},
		);

		return fn(txProxy);
	});
}

const cms = new Proxy(
	{},
	{
		get(_, slug) {
			if (slug === "transaction") return transaction;
			if (slug === "__tables") return () => ensureTables();
			if (slug === "__db") return () => drizzle.getDb();

			if (typeof slug !== "string") return undefined;

			return makeOps(slug, getCrud);
		},
	},
);

export default cms;
