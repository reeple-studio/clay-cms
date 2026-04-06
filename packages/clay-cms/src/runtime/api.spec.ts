// ? Tests for the cms proxy gate in runtime/api.ts.
// ? Mocks the virtual modules + @clay-cms/drizzle so the gate logic
// ? (runAccess, enforceWhereOrThrow, can, immutable delete invariants)
// ? can be exercised in isolation against an in-memory fake CRUD.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isAdmin, isSelf, or, ownDocuments } from "../access/helpers.js";
import { resolveCollections } from "../collections/resolve.js";
import type { CollectionConfig } from "../collections/types.js";

// ? -------- in-memory fake CRUD --------
// ? mutated by individual tests via the `store` ref.
type Doc = Record<string, unknown> & { id: string };
const store: Record<string, Doc[]> = {};

function resetStore(initial: Record<string, Doc[]>) {
	for (const k of Object.keys(store)) delete store[k];
	for (const [slug, rows] of Object.entries(initial)) {
		store[slug] = rows.map((r) => ({ ...r }));
	}
}

// ? minimal whereToDrizzle stand-in: just filter the in-memory rows
// ? using matchesWhere from access/where (the same evaluator the gate uses).
import { matchesWhere } from "../access/where.js";

type FindOpts = { where?: unknown };
type IdOpts = { id: string };
type DataOpts = { data: Record<string, unknown> };
type RequireOther = { where?: Record<string, unknown> };
type UpdateOpts = IdOpts & DataOpts & { requireOther?: RequireOther };
type DeleteOpts = IdOpts & { requireOther?: RequireOther };

// ? does at least one OTHER row (id !== id) match requireOther.where?
function otherExists(rows: Doc[], id: string, req?: RequireOther): boolean {
	return rows.some(
		(r) =>
			r.id !== id && (req?.where ? matchesWhere(req.where as never, r) : true),
	);
}

const fakeCrud = {
	find: vi.fn(async (slug: string, opts?: FindOpts) => {
		const rows = store[slug] ?? [];
		const where = opts?.where;
		if (!where) return rows;
		return rows.filter((r) => matchesWhere(where as never, r));
	}),
	findOne: vi.fn(async (slug: string, opts: IdOpts) => {
		return (store[slug] ?? []).find((r) => r.id === opts.id) ?? null;
	}),
	create: vi.fn(async (slug: string, opts: DataOpts) => {
		const data = opts.data;
		const doc = { id: String(data.id ?? Math.random()), ...data } as Doc;
		(store[slug] ??= []).push(doc);
		return doc;
	}),
	update: vi.fn(async (slug: string, opts: UpdateOpts) => {
		const { id, data } = opts;
		const rows = store[slug] ?? [];
		// ? requireOther guard (atomic last-admin demote) — refuse when no other
		// ? matching row exists, mirroring crud.ts's WHERE-embedded count.
		if (opts.requireOther && !otherExists(rows, id, opts.requireOther)) {
			return undefined;
		}
		const idx = rows.findIndex((r) => r.id === id);
		if (idx === -1) return null;
		rows[idx] = { ...rows[idx], ...data, id } as Doc;
		return rows[idx];
	}),
	delete: vi.fn(async (slug: string, opts: DeleteOpts) => {
		const rows = store[slug] ?? [];
		// ? requireOther guard (atomic last-user delete) — refuse when this is the
		// ? last (matching) row, returning false so the proxy raises the invariant.
		if (opts.requireOther && !otherExists(rows, opts.id, opts.requireOther)) {
			return false;
		}
		const idx = rows.findIndex((r) => r.id === opts.id);
		if (idx !== -1) rows.splice(idx, 1);
		return true;
	}),
};

// ? -------- collections under test --------
const postsCol: CollectionConfig = {
	slug: "posts",
	fields: { title: { type: "text", required: true } },
	access: {
		// ? non-admins only see their own posts
		read: or(isAdmin, ownDocuments("author")),
		update: or(isAdmin, ownDocuments("author")),
		delete: isAdmin,
	},
};

// ? collection with field-level ACL for the integration tests below.
// ? `secretNotes` is read+write admin-only; `status` is update-only admin.
const articlesCol: CollectionConfig = {
	slug: "articles",
	fields: {
		title: { type: "text", required: true },
		secretNotes: {
			type: "text",
			access: {
				read: ({ user }) => user?.role === "admin",
				create: ({ user }) => user?.role === "admin",
				update: ({ user }) => user?.role === "admin",
			},
		},
		status: {
			type: "select",
			options: ["draft", "published"],
			access: { update: ({ user }) => user?.role === "admin" },
		},
		// ? write-open, read-closed: anyone may write it (no create/update rule),
		// ? but only admins may read it. Pins the write-echo strip — a non-admin's
		// ? own write must not be reflected back.
		internalRef: {
			type: "text",
			access: { read: ({ user }) => user?.role === "admin" },
		},
	},
	access: {
		// ? collection-level: anyone logged-in can read/write — field gate is
		// ? what filters within
		read: () => true,
		create: () => true,
		update: () => true,
		delete: () => true,
	},
};

// ? collection with BOTH a field-level ACL rule and a beforeChange hook. Proves
// ? the write field-gate strips denied fields BEFORE the hook runs — so a hook
// ? can never observe (nor re-smuggle) a value the user wasn't allowed to write.
// ? The two facts (gate drops the field / hooks run) each have coverage, but
// ? nothing pinned the ORDER between them until this fixture shared one op.
const beforeChangeSaw: Array<Record<string, unknown>> = [];
const gatedCol: CollectionConfig = {
	slug: "gated",
	fields: {
		title: { type: "text", required: true },
		secret: {
			type: "text",
			access: { update: ({ user }) => user?.role === "admin" },
		},
	},
	access: {
		read: () => true,
		create: () => true,
		update: () => true,
		delete: () => true,
	},
	hooks: {
		beforeChange: [
			(args) => {
				// ? snapshot exactly what the hook received
				beforeChangeSaw.push({ ...args.data });
			},
		],
	},
};

const usersCol: CollectionConfig = {
	slug: "users",
	auth: true,
	fields: { name: { type: "text", required: true } },
	access: {
		// ? users can update themselves; admins can update anyone
		update: or(isAdmin, isSelf),
		// ? deliberately permissive delete so the immutable invariant
		// ? (and not the auth default) is what blocks self-/last-user delete.
		// ? this is the whole reason the invariant lives in api.ts, not defaults.
		delete: () => true,
	},
};

// ? collection whose read access fn throws a plain (non-AccessDenied) Error —
// ? lets us assert can()/the gate RETHROWS unexpected errors instead of
// ? swallowing them as "denied" (a DB outage must not silently read as false).
const boomCol: CollectionConfig = {
	slug: "boom",
	fields: { x: { type: "text" } },
	access: {
		read: () => {
			throw new Error("kaboom");
		},
	},
};

const resolved = resolveCollections([
	postsCol,
	usersCol,
	articlesCol,
	boomCol,
	gatedCol,
]);

// ? -------- mock virtuals + @clay-cms/drizzle --------
vi.mock("virtual:clay-cms/config", () => ({
	default: { collections: resolved, localization: undefined },
}));

// ? mutable db stub so individual tests can attach a `.transaction` method
// ? (or remove it) to exercise the cms.transaction(fn) wrapper. The drizzle
// ? virtual mock returns this same object every call.
const dbStub: { transaction?: (fn: (tx: unknown) => unknown) => unknown } = {};

vi.mock("virtual:clay-cms/drizzle", () => ({
	default: { getDb: async () => dbStub },
}));

vi.mock("@clay-cms/drizzle", () => ({
	buildSchema: () => ({}),
	createCrud: () => fakeCrud,
}));

// ? import after mocks are registered.
// ? api.ts is @ts-nocheck'd source — describe just the runtime shape we touch.
type CmsOpts = Record<string, unknown> & { user?: unknown };
type CollectionFake = {
	find: (opts?: CmsOpts) => Promise<Doc[]>;
	findOne: (opts: CmsOpts) => Promise<Doc | null>;
	create: (opts: CmsOpts) => Promise<Doc>;
	update: (opts: CmsOpts) => Promise<Doc | null>;
	delete: (opts: CmsOpts) => Promise<void>;
	can: (op: string, opts?: CmsOpts) => Promise<boolean>;
};
// ? known slugs are non-optional so call sites don't need `cms.posts!`.
// ? string-indexed fallback is still there for the few dynamic-slug tests.
type CmsFake = {
	posts: CollectionFake;
	users: CollectionFake;
	articles: CollectionFake;
	gated: CollectionFake;
	transaction: (fn: (tx: CmsFake) => Promise<unknown>) => Promise<unknown>;
} & { [slug: string]: CollectionFake };

const { default: cms } = (await import("./api.js")) as unknown as {
	default: CmsFake;
};
const { AccessDeniedError } = await import("../access/index.js");

// ? typed accessor for the in-memory store — avoids `store.posts!` everywhere.
function rowsOf(slug: string): Doc[] {
	const rows = store[slug];
	if (!rows) throw new Error(`expected store["${slug}"] to be initialized`);

	return rows;
}

const admin = { id: "u-admin", role: "admin" };
const alice = { id: "u-alice", role: "customer" };
const bob = { id: "u-bob", role: "customer" };

beforeEach(() => {
	resetStore({
		posts: [
			{ id: "p1", title: "Alice 1", author: "u-alice" },
			{ id: "p2", title: "Alice 2", author: "u-alice" },
			{ id: "p3", title: "Bob 1", author: "u-bob" },
		],
		users: [
			{ id: "u-admin", name: "Admin", role: "admin" },
			{ id: "u-alice", name: "Alice", role: "customer" },
			{ id: "u-bob", name: "Bob", role: "customer" },
		],
		articles: [
			{
				id: "a1",
				title: "Hello",
				secretNotes: "internal",
				status: "draft",
			},
		],
	});
	for (const fn of Object.values(fakeCrud)) fn.mockClear();
});

// ? --------------------------------------------------------------
// ? bypass paths — single bypass rule: overrideAccess: true.
// ? Missing user defaults to null (anonymous), enforced not bypassed.
// ? --------------------------------------------------------------
describe("runAccess — bypass paths", () => {
	it("overrideAccess: true bypasses even with a user", async () => {
		const all = await cms.posts.find({ user: alice, overrideAccess: true });
		expect(all).toHaveLength(3);
	});

	it("overrideAccess: true bypasses with no user at all", async () => {
		const all = await cms.posts.find({ overrideAccess: true });
		expect(all).toHaveLength(3);
	});

	it("missing user is enforced as anonymous (default-deny)", async () => {
		// ? posts.read = or(isAdmin, ownDocuments("author"))
		// ? anonymous → both branches return false → AccessDeniedError
		await expect(cms.posts.find({})).rejects.toBeInstanceOf(AccessDeniedError);
	});

	it("user: null is enforced (anonymous), not bypassed", async () => {
		await expect(
			cms.posts.findOne({ id: "p1", user: null }),
		).rejects.toBeInstanceOf(AccessDeniedError);
	});

	it("missing user → findOne is denied (same as user: null)", async () => {
		await expect(cms.posts.findOne({ id: "p1" })).rejects.toBeInstanceOf(
			AccessDeniedError,
		);
	});
});

// ? --------------------------------------------------------------
// ? find: ACL Where AND-merged with user filter
// ? --------------------------------------------------------------
describe("find — ACL Where filtering", () => {
	it("non-admin only sees own documents", async () => {
		const rows = await cms.posts.find({ user: alice });
		expect(rows.map((r: Doc) => r.id)).toEqual(["p1", "p2"]);
	});

	it("admin sees all (Where short-circuits to true)", async () => {
		const rows = await cms.posts.find({ user: admin });
		expect(rows).toHaveLength(3);
	});

	it("AND-merges ACL Where with user-supplied where", async () => {
		const rows = await cms.posts.find({
			user: alice,
			where: { title: { like: "alice 1" } },
		});

		expect(rows.map((r: Doc) => r.id)).toEqual(["p1"]);
	});
});

// ? --------------------------------------------------------------
// ? findOne / update / delete pre-flight enforcement
// ? --------------------------------------------------------------
describe("single-doc ops — Where pre-flight enforcement", () => {
	it("findOne allows owner", async () => {
		const doc = await cms.posts.findOne({ id: "p1", user: alice });
		expect(doc?.id).toBe("p1");
	});

	it("findOne throws AccessDeniedError when doc fails Where", async () => {
		// ? Bob can't read Alice's post
		await expect(
			cms.posts.findOne({ id: "p1", user: bob }),
		).rejects.toBeInstanceOf(AccessDeniedError);
	});

	it("update throws when existing doc fails Where", async () => {
		await expect(
			cms.posts.update({ id: "p1", user: bob, data: { title: "hax" } }),
		).rejects.toBeInstanceOf(AccessDeniedError);

		// ? store untouched
		expect(rowsOf("posts").find((r) => r.id === "p1")?.title).toBe("Alice 1");
	});

	it("update allows when doc matches Where", async () => {
		const doc = await cms.posts.update({
			id: "p1",
			user: alice,
			data: { title: "Alice 1 edited" },
		});

		expect(doc?.title).toBe("Alice 1 edited");
	});

	it("delete throws when boolean access returns false", async () => {
		// ? posts.delete = isAdmin → alice denied
		await expect(
			cms.posts.delete({ id: "p1", user: alice }),
		).rejects.toBeInstanceOf(AccessDeniedError);

		expect(store.posts).toHaveLength(3);
	});
});

// ? --------------------------------------------------------------
// ? immutable auth-collection delete invariants
// ? --------------------------------------------------------------
describe("delete — immutable auth-collection invariants", () => {
	it("cannot delete your own account (self-delete)", async () => {
		await expect(
			cms.users.delete({ id: "u-admin", user: admin }),
		).rejects.toThrow(/cannot delete your own account/);

		expect(rowsOf("users").find((u) => u.id === "u-admin")).toBeDefined();
	});

	it("cannot delete the last user", async () => {
		// ? leave only one user
		store.users = [{ id: "u-only", name: "Only", role: "admin" }];

		await expect(
			cms.users.delete({
				id: "u-only",
				user: { id: "u-other", role: "admin" },
			}),
		).rejects.toThrow(/cannot delete the last user/);

		expect(store.users).toHaveLength(1);
	});

	it("invariants do NOT apply to non-auth collections", async () => {
		// ? content collection: even the last row can be deleted
		store.posts = [{ id: "only", title: "x", author: "u-admin" }];
		await cms.posts.delete({ id: "only", user: admin });

		expect(store.posts).toHaveLength(0);
	});

	it("self-delete invariant is enforced even with overrideAccess: false (the default)", async () => {
		// ? regression guard: don't accidentally let admins nuke themselves
		await expect(
			cms.users.delete({ id: "u-admin", user: admin }),
		).rejects.toThrow(/cannot delete your own account/);
	});

	it("invariants are bypassed by overrideAccess: true with no user", async () => {
		// ? trusted server code with explicit bypass can do anything, including last-user delete
		store.users = [{ id: "u-only", name: "Only", role: "admin" }];
		await cms.users.delete({ id: "u-only", overrideAccess: true });

		expect(store.users).toHaveLength(0);
	});

	it("invariants are bypassed by overrideAccess: true", async () => {
		store.users = [{ id: "u-only", name: "Only", role: "admin" }];

		await cms.users.delete({
			id: "u-only",
			user: admin,
			overrideAccess: true,
		});

		expect(store.users).toHaveLength(0);
	});
});

// ? --------------------------------------------------------------
// ? immutable auth-collection demote invariant (role admin → non-admin)
// ? mirrors the delete invariant; the "another admin remains" half is enforced
// ? atomically via requireOther (see crud.spec.ts for the real-SQL race test).
// ? --------------------------------------------------------------
describe("update — immutable last-admin demote invariant", () => {
	it("demotes an admin when another admin remains", async () => {
		resetStore({
			users: [
				{ id: "u-admin", name: "Admin", role: "admin" },
				{ id: "u-admin2", name: "Admin 2", role: "admin" },
			],
		});

		const doc = await cms.users.update({
			id: "u-admin",
			user: { id: "u-admin2", role: "admin" },
			data: { role: "customer" },
		});

		expect(doc?.role).toBe("customer");
	});

	it("refuses to demote the last admin", async () => {
		resetStore({
			users: [
				{ id: "u-onlyadmin", name: "Only Admin", role: "admin" },
				{ id: "u-alice", name: "Alice", role: "customer" },
			],
		});

		await expect(
			cms.users.update({
				id: "u-onlyadmin",
				user: { id: "u-other", role: "admin" },
				data: { role: "customer" },
			}),
		).rejects.toThrow(/cannot demote the last admin/);

		// ? store untouched — the guard refused the write
		expect(rowsOf("users").find((u) => u.id === "u-onlyadmin")?.role).toBe(
			"admin",
		);
	});

	it("cannot demote your own admin account, even with another admin present", async () => {
		resetStore({
			users: [
				{ id: "u-admin", name: "Admin", role: "admin" },
				{ id: "u-admin2", name: "Admin 2", role: "admin" },
			],
		});

		await expect(
			cms.users.update({
				id: "u-admin",
				user: { id: "u-admin", role: "admin" },
				data: { role: "customer" },
			}),
		).rejects.toThrow(/cannot demote your own admin account/);

		expect(rowsOf("users").find((u) => u.id === "u-admin")?.role).toBe("admin");
	});

	it("does not trigger on non-demoting updates to an admin", async () => {
		resetStore({
			users: [{ id: "u-onlyadmin", name: "Only Admin", role: "admin" }],
		});

		// ? name change keeps role admin → not a demotion → no guard, no throw
		const doc = await cms.users.update({
			id: "u-onlyadmin",
			user: { id: "u-onlyadmin", role: "admin" },
			data: { name: "Renamed" },
		});

		expect(doc?.name).toBe("Renamed");
		expect(doc?.role).toBe("admin");
	});
});

// ? --------------------------------------------------------------
// ? can() — pre-flight permission check
// ? --------------------------------------------------------------
describe("can() — pre-flight checks", () => {
	it("returns true when op is allowed", async () => {
		expect(await cms.posts.can("update", { id: "p1", user: alice })).toBe(true);
	});

	it("returns false when op is denied (Where mismatch)", async () => {
		expect(await cms.posts.can("update", { id: "p1", user: bob })).toBe(false);
	});

	it("returns false when op is denied (boolean false)", async () => {
		// ? posts.delete = isAdmin
		expect(await cms.posts.can("delete", { id: "p1", user: alice })).toBe(
			false,
		);

		expect(await cms.posts.can("delete", { id: "p1", user: admin })).toBe(true);
	});

	it("accepts a doc directly without re-loading", async () => {
		const doc = { id: "p1", title: "x", author: "u-alice" };
		expect(await cms.posts.can("update", { doc, user: alice })).toBe(true);
		expect(await cms.posts.can("update", { doc, user: bob })).toBe(false);

		// ? findOne should NOT have been called when doc is provided
		expect(fakeCrud.findOne).not.toHaveBeenCalled();
	});

	it("returns boolean (not Where) for create", async () => {
		expect(
			await cms.posts.can("create", {
				user: alice,
				data: { title: "new", author: "u-alice" },
			}),
		).toBe(true);
	});

	it("returns true for the admin op when allowed", async () => {
		expect(await cms.users.can("admin", { user: admin })).toBe(true);
		expect(await cms.users.can("admin", { user: alice })).toBe(false);
	});

	it("rethrows non-AccessDeniedError errors instead of returning false", async () => {
		// ? the `boom` collection's read fn throws a plain Error. can() must let it
		// ? propagate — swallowing it as `false` would render a DB-outage as a
		// ? silent "denied" in the admin UI.
		await expect(
			cms.boom.can("read", { id: "x1", user: admin }),
		).rejects.toThrow(/kaboom/);
	});
});

// ? --------------------------------------------------------------
// ? showHiddenFields is a system-only escape hatch — the proxy must only
// ? forward it under overrideAccess, else any logged-in user could read
// ? hidden columns (hashedPassword). Regression for the July 2026 review.
// ? --------------------------------------------------------------
describe("showHiddenFields — system-only", () => {
	it("does NOT forward showHiddenFields for a gated (non-override) find", async () => {
		await cms.users.find({ user: admin, showHiddenFields: true });

		const lastCall = fakeCrud.find.mock.calls.at(-1);
		expect(lastCall?.[1]?.showHiddenFields).toBeUndefined();
	});

	it("does NOT forward showHiddenFields for a gated findOne", async () => {
		await cms.users.findOne({
			id: "u-admin",
			user: admin,
			showHiddenFields: true,
		});

		const lastCall = fakeCrud.findOne.mock.calls.at(-1);
		expect(lastCall?.[1]?.showHiddenFields).toBeUndefined();
	});

	it("DOES forward showHiddenFields under overrideAccess (trusted bootstrap)", async () => {
		await cms.users.find({ overrideAccess: true, showHiddenFields: true });

		const lastCall = fakeCrud.find.mock.calls.at(-1);
		expect(lastCall?.[1]?.showHiddenFields).toBe(true);
	});
});

// ? --------------------------------------------------------------
// ? update — immutable self-/last-admin PROMOTION invariant (mirror of the
// ? demotion guard). A non-admin must not be able to grant itself admin via
// ? the default auth `update = or(isAdmin, isSelf)`.
// ? --------------------------------------------------------------
describe("update — immutable admin-promotion invariant", () => {
	it("refuses a non-admin self-promoting to admin", async () => {
		await expect(
			cms.users.update({
				id: "u-alice",
				user: alice, // customer, isSelf → passes collection gate
				data: { role: "admin" },
			}),
		).rejects.toThrow(/only an admin can grant the admin role/);

		expect(rowsOf("users").find((u) => u.id === "u-alice")?.role).toBe(
			"customer",
		);
	});

	it("allows an admin to promote another user to admin", async () => {
		const doc = await cms.users.update({
			id: "u-bob",
			user: admin,
			data: { role: "admin" },
		});

		expect(doc?.role).toBe("admin");
	});

	it("does not fire when role is unchanged / already admin", async () => {
		const doc = await cms.users.update({
			id: "u-admin",
			user: admin,
			data: { name: "Renamed", role: "admin" },
		});

		expect(doc?.name).toBe("Renamed");
	});
});

// ? --------------------------------------------------------------
// ? cms.transaction(fn) — Payload-style atomic block.
// ? D1 (no db.transaction) → throws with a clear message.
// ? Adapters with db.transaction → callback runs inside it, throws roll back.
// ? --------------------------------------------------------------
describe("cms.transaction(fn)", () => {
	beforeEach(() => {
		// ? reset to D1-like state (no transaction primitive) before each test
		delete dbStub.transaction;
	});

	it("throws on adapters without db.transaction (D1 path)", async () => {
		await expect(cms.transaction(async () => "ok")).rejects.toThrow(
			/cms\.transaction\(fn\) requires an adapter whose drizzle driver supports interactive transactions/,
		);
	});

	it("runs the callback inside db.transaction and returns its result", async () => {
		let txCalled = 0;
		dbStub.transaction = async (fn) => {
			txCalled += 1;
			// ? mimic drizzle: run the callback with a tx instance, return its value
			return fn({ __isTx: true });
		};

		const result = await cms.transaction(async (tx) => {
			// ? tx is a cms-shaped proxy, not the raw drizzle tx
			expect(typeof tx.posts.find).toBe("function");
			return "result-value";
		});

		expect(txCalled).toBe(1);
		expect(result).toBe("result-value");
	});

	it("propagates throws so drizzle rolls back", async () => {
		let txInvoked = false;
		dbStub.transaction = async (fn) => {
			txInvoked = true;
			// ? real drizzle catches the throw, marks the tx for rollback, rethrows
			return fn({ __isTx: true });
		};

		await expect(
			cms.transaction(async (tx) => {
				await tx.posts.find({ overrideAccess: true });
				throw new Error("rollback me");
			}),
		).rejects.toThrow("rollback me");

		expect(txInvoked).toBe(true);
	});

	it("an afterChange-like throw inside the callback bubbles up (rollback path)", async () => {
		// ? simulates the after* hook rollback story: any throw inside the
		// ? tx callback — including from a hook running on a tx-bound write —
		// ? rejects the outer promise so drizzle rolls everything back.
		dbStub.transaction = async (fn) => fn({ __isTx: true });

		await expect(
			cms.transaction(async (tx) => {
				await tx.posts.create({
					data: { title: "x", author: "u-alice" },
					user: alice,
				});
				// ? pretend an afterChange threw downstream
				throw new Error("afterChange failed");
			}),
		).rejects.toThrow("afterChange failed");
	});

	it("tx proxy still enforces ACL — anonymous read denied", async () => {
		dbStub.transaction = async (fn) => fn({ __isTx: true });

		// ? posts.read = or(isAdmin, ownDocuments("author"))
		// ? anonymous (no user) → both branches reject → AccessDeniedError.
		// ? proves the tx proxy isn't a stealth bypass — same gate as global cms.
		await expect(
			cms.transaction(async (tx) => {
				return tx.posts.find();
			}),
		).rejects.toThrow(AccessDeniedError);
	});

	it("tx proxy still enforces ACL — alice sees only her own posts", async () => {
		dbStub.transaction = async (fn) => fn({ __isTx: true });

		const rows = (await cms.transaction(async (tx) => {
			return tx.posts.find({ user: alice });
		})) as Doc[];

		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.author === "u-alice")).toBe(true);
	});

	it("tx proxy honors overrideAccess: true the same way the global cms does", async () => {
		dbStub.transaction = async (fn) => fn({ __isTx: true });

		const rows = (await cms.transaction(async (tx) => {
			return tx.posts.find({ overrideAccess: true });
		})) as Doc[];

		expect(rows.length).toBe(3);
	});

	it("nested cms.transaction throws", async () => {
		dbStub.transaction = async (fn) => fn({ __isTx: true });

		await expect(
			cms.transaction(async (tx) => {
				return (tx as unknown as CmsFake).transaction(async () => "x");
			}),
		).rejects.toThrow(/nested cms\.transaction/);
	});
});

// ? --------------------------------------------------------------
// ? Field-level ACL — integration through the cms proxy.
// ? Pure helpers are unit-tested in access/field-gate.spec.ts; here we
// ? verify the runtime wires them in correctly: read-strip, write-drop,
// ? bypass-skips-both, and the hot-path skip flag.
// ? --------------------------------------------------------------
describe("field-level access — proxy integration", () => {
	beforeEach(() => {
		// ? silence the dev-mode drop warning so test output stays clean
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("find strips read-denied fields for non-admins", async () => {
		const rows = await cms.articles.find({ user: alice });

		expect(rows[0]?.title).toBe("Hello");
		expect(rows[0]?.secretNotes).toBeUndefined();
		expect(rows[0]?.status).toBe("draft");
	});

	it("find returns the full doc for admins", async () => {
		const rows = await cms.articles.find({ user: admin });

		expect(rows[0]?.secretNotes).toBe("internal");
	});

	it("findOne strips read-denied fields for non-admins", async () => {
		const doc = await cms.articles.findOne({ id: "a1", user: alice });

		expect(doc?.title).toBe("Hello");
		expect(doc?.secretNotes).toBeUndefined();
	});

	it("overrideAccess: true skips the field gate (read)", async () => {
		const rows = await cms.articles.find({ overrideAccess: true });
		expect(rows[0]?.secretNotes).toBe("internal");
	});

	it("update silently drops fields denied for non-admins", async () => {
		const doc = await cms.articles.update({
			id: "a1",
			user: alice,
			data: {
				title: "Hello, edited",
				secretNotes: "leaked?",
				status: "published",
			},
		});

		// ? title kept; secretNotes + status dropped
		expect(doc?.title).toBe("Hello, edited");
		// ? store reflects the drop
		const stored = rowsOf("articles").find((r) => r.id === "a1");
		expect(stored?.secretNotes).toBe("internal");
		expect(stored?.status).toBe("draft");
	});

	it("update preserves fields the user CAN write", async () => {
		await cms.articles.update({
			id: "a1",
			user: admin,
			data: {
				title: "Admin edit",
				secretNotes: "updated",
				status: "published",
			},
		});

		const stored = rowsOf("articles").find((r) => r.id === "a1");
		expect(stored?.secretNotes).toBe("updated");
		expect(stored?.status).toBe("published");
	});

	it("create silently drops create-denied fields", async () => {
		const doc = await cms.articles.create({
			user: alice,
			data: {
				id: "a-new",
				title: "Mine",
				secretNotes: "should not stick",
			},
		});

		expect(doc.title).toBe("Mine");
		const stored = rowsOf("articles").find((r) => r.id === "a-new");
		expect(stored?.secretNotes).toBeUndefined();
	});

	it("strips read-denied fields from the update echo (write-but-not-read)", async () => {
		const doc = await cms.articles.update({
			id: "a1",
			user: alice,
			data: { title: "Edited", internalRef: "alice-was-here" },
		});

		// ? the write landed (alice may write internalRef)…
		const stored = rowsOf("articles").find((r) => r.id === "a1");
		expect(stored?.internalRef).toBe("alice-was-here");
		// ? …but the echo back to alice must not include the read-denied field
		expect(doc?.title).toBe("Edited");
		expect(doc?.internalRef).toBeUndefined();
	});

	it("strips read-denied fields from the create echo (write-but-not-read)", async () => {
		const doc = await cms.articles.create({
			user: alice,
			data: { id: "a-echo", title: "Mine", internalRef: "secret" },
		});

		const stored = rowsOf("articles").find((r) => r.id === "a-echo");
		expect(stored?.internalRef).toBe("secret");
		expect(doc.title).toBe("Mine");
		expect(doc.internalRef).toBeUndefined();
	});

	it("returns the read-denied field to an admin on write echo", async () => {
		const doc = await cms.articles.update({
			id: "a1",
			user: admin,
			data: { internalRef: "admin-write" },
		});

		expect(doc?.internalRef).toBe("admin-write");
	});

	it("overrideAccess: true skips the field gate (write)", async () => {
		await cms.articles.update({
			id: "a1",
			overrideAccess: true,
			data: { secretNotes: "system update" },
		});

		const stored = rowsOf("articles").find((r) => r.id === "a1");
		expect(stored?.secretNotes).toBe("system update");
	});

	it("hot-path skip: collections without field-level rules don't run the gate", async () => {
		// ? `posts` has no field-level rules → hasFieldLevelAccess is undefined.
		// ? This test exists as a smoke check that the skip branch doesn't break
		// ? normal find() behavior.
		const rows = await cms.posts.find({ user: alice });
		expect(rows.map((r: Doc) => r.id)).toEqual(["p1", "p2"]);
	});
});

// ? --------------------------------------------------------------
// ? field gate runs BEFORE beforeChange (anti-smuggle ordering)
// ? --------------------------------------------------------------
describe("field gate runs before beforeChange (anti-smuggle)", () => {
	beforeEach(() => {
		beforeChangeSaw.length = 0;
		// ? seeded here (the shared beforeEach doesn't know about `gated`)
		store.gated = [{ id: "g1", title: "orig-title", secret: "orig-secret" }];
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("beforeChange never sees a field the user is denied at the field level", async () => {
		await cms.gated.update({
			id: "g1",
			user: alice, // customer → cannot write `secret`
			data: { title: "edited", secret: "smuggled" },
		});

		expect(beforeChangeSaw).toHaveLength(1);
		const saw = beforeChangeSaw[0] ?? {};

		// ? the writable field reached the hook…
		expect(saw.title).toBe("edited");
		// ? …but the denied field was stripped BEFORE the hook — not after, and not
		// ? merely dropped on write. If the gate ran after beforeChange, `secret`
		// ? would be visible here (and a hook could act on the smuggled value).
		expect("secret" in saw).toBe(false);
		// ? and the stored value is untouched
		expect(rowsOf("gated").find((r) => r.id === "g1")?.secret).toBe(
			"orig-secret",
		);
	});

	it("beforeChange receives fields the user IS allowed to write", async () => {
		await cms.gated.update({
			id: "g1",
			user: admin,
			data: { secret: "admin-set" },
		});

		expect(beforeChangeSaw[0]?.secret).toBe("admin-set");
		expect(rowsOf("gated").find((r) => r.id === "g1")?.secret).toBe(
			"admin-set",
		);
	});
});
