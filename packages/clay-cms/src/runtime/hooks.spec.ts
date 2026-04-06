// ? Tests for the collection-level hooks system in runtime/api.ts.
// ? Mirrors api.spec.ts plumbing: in-memory CRUD fake + mocked virtuals,
// ? so we can exercise hook ordering, arg shape, mutation, throw-aborts,
// ? and bypass-still-runs without spinning up SQLite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCollections } from "../collections/resolve.js";
import type { CollectionConfig } from "../collections/types.js";

// ? -------- in-memory fake CRUD --------
type Doc = Record<string, unknown> & { id: string };
const store: Record<string, Doc[]> = {};

function resetStore(initial: Record<string, Doc[]>) {
	for (const k of Object.keys(store)) delete store[k];
	for (const [slug, rows] of Object.entries(initial)) {
		store[slug] = rows.map((r) => ({ ...r }));
	}
}

const fakeCrud = {
	find: vi.fn(async (slug: string) => store[slug] ?? []),
	findOne: vi.fn(async (slug: string, id: string) => {
		return (store[slug] ?? []).find((r) => r.id === id) ?? null;
	}),
	create: vi.fn(async (slug: string, data: Record<string, unknown>) => {
		const doc = {
			id: String(data.id ?? `g-${Math.random()}`),
			...data,
		} as Doc;
		(store[slug] ??= []).push(doc);
		return doc;
	}),
	update: vi.fn(
		async (slug: string, id: string, data: Record<string, unknown>) => {
			const rows = store[slug] ?? [];
			const idx = rows.findIndex((r) => r.id === id);
			if (idx === -1) return null;
			rows[idx] = { ...rows[idx], ...data, id } as Doc;
			return rows[idx];
		},
	),
	delete: vi.fn(async (slug: string, id: string) => {
		const rows = store[slug] ?? [];
		const idx = rows.findIndex((r) => r.id === id);
		if (idx !== -1) rows.splice(idx, 1);
	}),
};

// ? -------- hook spies (reset per test) --------
// ? wrapping arrays so test bodies can push/swap implementations freely.
type AnyArgs = Record<string, unknown>;
const spies = {
	beforeChange: [] as Array<(args: AnyArgs) => unknown>,
	afterChange: [] as Array<(args: AnyArgs) => unknown>,
	beforeRead: [] as Array<(args: AnyArgs) => unknown>,
	afterRead: [] as Array<(args: AnyArgs) => unknown>,
	beforeDelete: [] as Array<(args: AnyArgs) => unknown>,
	afterDelete: [] as Array<(args: AnyArgs) => unknown>,
};

// ? indirection layer — collection config holds stable thunks that delegate
// ? to whatever the test installs into `spies`. Keeps the resolved config
// ? immutable across tests while still letting each test wire its own hooks.
const postsCol: CollectionConfig = {
	slug: "posts",
	fields: { title: { type: "text", required: true } },
	hooks: {
		beforeChange: [
			async (args) => {
				let data = args.data;
				for (const fn of spies.beforeChange) {
					const r = await fn({ ...args, data });
					if (r !== undefined) data = r as Record<string, unknown>;
				}
				return data;
			},
		],
		afterChange: [
			async (args) => {
				for (const fn of spies.afterChange)
					await fn(args as unknown as AnyArgs);
			},
		],
		beforeRead: [
			async (args) => {
				let doc = args.doc;
				for (const fn of spies.beforeRead) {
					const r = await fn({ ...args, doc });
					if (r !== undefined) doc = r as Record<string, unknown>;
				}
				return doc;
			},
		],
		afterRead: [
			async (args) => {
				let doc = args.doc;
				for (const fn of spies.afterRead) {
					const r = await fn({ ...args, doc });
					if (r !== undefined) doc = r as Record<string, unknown>;
				}
				return doc;
			},
		],
		beforeDelete: [
			async (args) => {
				for (const fn of spies.beforeDelete)
					await fn(args as unknown as AnyArgs);
			},
		],
		afterDelete: [
			async (args) => {
				for (const fn of spies.afterDelete)
					await fn(args as unknown as AnyArgs);
			},
		],
	},
};

// ? a second collection with NO hooks at all — for the hot-path skip test.
const tagsCol: CollectionConfig = {
	slug: "tags",
	fields: { name: { type: "text", required: true } },
};

const resolved = resolveCollections([postsCol, tagsCol]);

vi.mock("virtual:clay-cms/config", () => ({
	default: { collections: resolved, localization: undefined },
}));

vi.mock("virtual:clay-cms/drizzle", () => ({
	default: { getDb: async () => ({}) },
}));

vi.mock("@clay-cms/drizzle", () => ({
	buildSchema: () => ({}),
	createCrud: () => fakeCrud,
}));

type CmsOpts = Record<string, unknown> & { user?: unknown };
type CollectionFake = {
	find: (opts?: CmsOpts) => Promise<Doc[]>;
	findOne: (opts: CmsOpts) => Promise<Doc | null>;
	create: (opts: CmsOpts) => Promise<Doc>;
	update: (opts: CmsOpts) => Promise<Doc | null>;
	delete: (opts: CmsOpts) => Promise<void>;
};
type CmsFake = {
	posts: CollectionFake;
	tags: CollectionFake;
};

const { default: cms } = (await import("./api.js")) as unknown as {
	default: CmsFake;
};

const alice = { id: "u-alice", role: "customer" };

beforeEach(() => {
	resetStore({
		posts: [
			{ id: "p1", title: "First", author: "u-alice" },
			{ id: "p2", title: "Second", author: "u-alice" },
		],
		tags: [{ id: "t1", name: "news" }],
	});
	for (const k of Object.keys(spies) as Array<keyof typeof spies>) {
		spies[k].length = 0;
	}
	for (const fn of Object.values(fakeCrud)) fn.mockClear();
});

// ? --------------------------------------------------------------
// ? beforeChange
// ? --------------------------------------------------------------
describe("beforeChange", () => {
	it("runs on create with the correct arg shape", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.create({
			user: alice,
			data: { title: "hello", author: "u-alice" },
		});

		expect(seen).toHaveLength(1);
		const args = seen[0] as AnyArgs;
		expect(args.operation).toBe("create");
		expect(args.collection).toBe("posts");
		expect(args.user).toEqual(alice);
		expect(args.context).toEqual({});
		expect(args.data).toMatchObject({ title: "hello" });
		// ? originalDoc + id are absent on create
		expect(args.originalDoc).toBeUndefined();
		expect(args.id).toBeUndefined();
	});

	it("runs on update with originalDoc + id present", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.update({
			id: "p1",
			user: alice,
			data: { title: "renamed" },
			overrideAccess: true,
		});

		const args = seen[0] as AnyArgs;
		expect(args.operation).toBe("update");
		expect(args.id).toBe("p1");
		expect(args.originalDoc).toMatchObject({ id: "p1", title: "First" });
	});

	it("can mutate the data by returning a new object", async () => {
		spies.beforeChange.push((args) => ({
			...(args.data as object),
			title: `[mutated] ${(args.data as { title: string }).title}`,
		}));

		const doc = await cms.posts.create({
			user: alice,
			data: { title: "raw", author: "u-alice" },
		});

		expect((doc as unknown as { title: string }).title).toBe("[mutated] raw");
	});

	it("returning void keeps the current data", async () => {
		spies.beforeChange.push(() => undefined);

		const doc = await cms.posts.create({
			user: alice,
			data: { title: "kept", author: "u-alice" },
		});

		expect((doc as unknown as { title: string }).title).toBe("kept");
	});

	it("multiple hooks chain in array order", async () => {
		const order: string[] = [];
		spies.beforeChange.push((args) => {
			order.push("first");
			return { ...(args.data as object), step: 1 };
		});
		spies.beforeChange.push((args) => {
			order.push("second");
			expect((args.data as { step: number }).step).toBe(1);
			return { ...(args.data as object), step: 2 };
		});

		const doc = await cms.posts.create({
			user: alice,
			data: { title: "x", author: "u-alice" },
		});

		expect(order).toEqual(["first", "second"]);
		expect((doc as unknown as { step: number }).step).toBe(2);
	});

	it("throw aborts the operation — no DB write", async () => {
		spies.beforeChange.push(() => {
			throw new Error("nope");
		});

		await expect(
			cms.posts.create({
				user: alice,
				data: { title: "should not persist", author: "u-alice" },
			}),
		).rejects.toThrow(/nope/);

		expect(fakeCrud.create).not.toHaveBeenCalled();
	});
});

// ? --------------------------------------------------------------
// ? afterChange
// ? --------------------------------------------------------------
describe("afterChange", () => {
	it("runs on create with the persisted doc", async () => {
		const seen: AnyArgs[] = [];
		spies.afterChange.push((args) => {
			seen.push(args);
		});

		const doc = await cms.posts.create({
			user: alice,
			data: { title: "x", author: "u-alice" },
		});

		const args = seen[0] as AnyArgs;
		expect(args.operation).toBe("create");
		expect(args.doc).toBe(doc);
		expect(args.previousDoc).toBeUndefined();
		expect(args.id).toBeUndefined();
	});

	it("runs on update with previousDoc + id", async () => {
		const seen: AnyArgs[] = [];
		spies.afterChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.update({
			id: "p1",
			user: alice,
			data: { title: "renamed" },
			overrideAccess: true,
		});

		const args = seen[0] as AnyArgs;
		expect(args.operation).toBe("update");
		expect(args.id).toBe("p1");
		expect((args.previousDoc as { title: string }).title).toBe("First");
		expect((args.doc as { title: string }).title).toBe("renamed");
	});

	it("throw propagates but the write already happened", async () => {
		spies.afterChange.push(() => {
			throw new Error("notify failed");
		});

		await expect(
			cms.posts.create({
				user: alice,
				data: { id: "p-new", title: "persisted", author: "u-alice" },
			}),
		).rejects.toThrow(/notify failed/);

		// ? this is the documented gotcha — the row IS in the store
		expect(store.posts?.find((p) => p.id === "p-new")).toBeDefined();
	});
});

// ? --------------------------------------------------------------
// ? beforeRead / afterRead
// ? --------------------------------------------------------------
describe("read hooks", () => {
	it("beforeRead runs once per doc in find()", async () => {
		const seen: string[] = [];
		spies.beforeRead.push((args) => {
			seen.push((args.doc as { id: string }).id);
		});

		await cms.posts.find({ user: alice, overrideAccess: true });

		expect(seen).toEqual(["p1", "p2"]);
	});

	it("afterRead runs once in findOne()", async () => {
		const seen: string[] = [];
		spies.afterRead.push((args) => {
			seen.push((args.doc as { id: string }).id);
		});

		await cms.posts.findOne({
			id: "p1",
			user: alice,
			overrideAccess: true,
		});

		expect(seen).toEqual(["p1"]);
	});

	it("beforeRead → afterRead can transform the doc", async () => {
		spies.beforeRead.push((args) => ({
			...(args.doc as object),
			redacted: true,
		}));
		spies.afterRead.push((args) => ({
			...(args.doc as object),
			projected: true,
		}));

		const doc = await cms.posts.findOne({
			id: "p1",
			user: alice,
			overrideAccess: true,
		});

		expect(doc).toMatchObject({
			id: "p1",
			redacted: true,
			projected: true,
		});
	});

	it("read hooks are skipped entirely on collections with no hooks", async () => {
		// ? hot-path optimization — tags has no hooks, so the find() should
		// ? return rows directly without allocating a transformation array.
		const rows = await cms.tags.find({ user: alice, overrideAccess: true });
		expect(rows).toEqual([{ id: "t1", name: "news" }]);
	});
});

// ? --------------------------------------------------------------
// ? beforeDelete / afterDelete
// ? --------------------------------------------------------------
describe("delete hooks", () => {
	it("beforeDelete receives the doc + id", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeDelete.push((args) => {
			seen.push(args);
		});

		await cms.posts.delete({
			id: "p1",
			user: alice,
			overrideAccess: true,
		});

		const args = seen[0] as AnyArgs;
		expect(args.id).toBe("p1");
		expect((args.doc as { title: string }).title).toBe("First");
		expect(args.collection).toBe("posts");
	});

	it("afterDelete receives the doc as it was before deletion", async () => {
		const seen: AnyArgs[] = [];
		spies.afterDelete.push((args) => {
			seen.push(args);
		});

		await cms.posts.delete({
			id: "p1",
			user: alice,
			overrideAccess: true,
		});

		const args = seen[0] as AnyArgs;
		expect((args.doc as { title: string }).title).toBe("First");
		// ? but the row is gone from the store
		expect(store.posts?.find((p) => p.id === "p1")).toBeUndefined();
	});

	it("beforeDelete throw aborts — no DB delete", async () => {
		spies.beforeDelete.push(() => {
			throw new Error("locked");
		});

		await expect(
			cms.posts.delete({
				id: "p1",
				user: alice,
				overrideAccess: true,
			}),
		).rejects.toThrow(/locked/);

		expect(store.posts?.find((p) => p.id === "p1")).toBeDefined();
	});
});

// ? --------------------------------------------------------------
// ? context — per-op scratchpad
// ? --------------------------------------------------------------
describe("context", () => {
	it("defaults to {} when not passed", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.create({
			user: alice,
			data: { title: "x", author: "u-alice" },
		});

		expect(seen[0]?.context).toEqual({});
	});

	it("threads the same object from before* to after*", async () => {
		spies.beforeChange.push((args) => {
			(args.context as Record<string, unknown>).flag = "from-before";
		});

		const seenAfter: AnyArgs[] = [];
		spies.afterChange.push((args) => {
			seenAfter.push(args);
		});

		await cms.posts.create({
			user: alice,
			data: { title: "x", author: "u-alice" },
		});

		expect(seenAfter[0]?.context).toEqual({ flag: "from-before" });
	});

	it("caller can pass their own context object", async () => {
		const myCtx = { skipNotify: true, requestId: "abc" };
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.create({
			user: alice,
			data: { title: "x", author: "u-alice" },
			context: myCtx,
		});

		expect(seen[0]?.context).toBe(myCtx);
	});
});

// ? --------------------------------------------------------------
// ? user normalization + bypass-still-runs
// ? --------------------------------------------------------------
describe("user + bypass behavior", () => {
	it("hooks see user: null on overrideAccess bypass with no user", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		// ? explicit bypass with no user → hooks still run with user normalized to null.
		await cms.posts.create({
			data: { title: "x", author: "u-alice" },
			overrideAccess: true,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.user).toBeNull();
	});

	it("hooks STILL run in overrideAccess: true bypass", async () => {
		const seen: string[] = [];
		spies.beforeChange.push(() => {
			seen.push("before");
		});
		spies.afterChange.push(() => {
			seen.push("after");
		});

		await cms.posts.create({
			user: alice,
			overrideAccess: true,
			data: { title: "x", author: "u-alice" },
		});

		// ? load-bearing assertion: bypass means "skip the gate", not
		// ? "skip business logic". Hooks are business logic.
		expect(seen).toEqual(["before", "after"]);
	});

	it("hooks see the resolved user when one is passed", async () => {
		const seen: AnyArgs[] = [];
		spies.beforeChange.push((args) => {
			seen.push(args);
		});

		await cms.posts.create({
			user: alice,
			overrideAccess: true,
			data: { title: "x", author: "u-alice" },
		});

		expect(seen[0]?.user).toEqual(alice);
	});
});
