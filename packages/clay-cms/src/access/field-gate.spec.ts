// ? Unit tests for field-level ACL helpers (access/field-gate.ts).
// ? Pure functions over a ResolvedCollectionConfig — no runtime/api needed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCollections } from "../collections/resolve.js";
import type { CollectionConfig } from "../collections/types.js";
import {
	applyReadFieldAccess,
	applyWriteFieldAccess,
	evaluateFieldAccess,
} from "./field-gate.js";

const adminOnly = (ctx: { user: Record<string, unknown> | null }) =>
	ctx.user?.role === "admin";

const postsCol: CollectionConfig = {
	slug: "posts",
	fields: {
		title: { type: "text", required: true },
		// ? secret notes — readable AND writable by admins only
		secretNotes: {
			type: "text",
			access: { read: adminOnly, update: adminOnly, create: adminOnly },
		},
		// ? read by anyone, but only admins can update
		status: {
			type: "select",
			options: ["draft", "published"],
			access: { update: adminOnly },
		},
	},
};

const [posts] = resolveCollections([postsCol]);
if (!posts) throw new Error("expected resolved collection");

const admin = { id: "u1", role: "admin" };
const customer = { id: "u2", role: "customer" };

// ? --------------------------------------------------------------
// ? resolveCollections — hot-path flag
// ? --------------------------------------------------------------
describe("resolveCollections — hasFieldLevelAccess flag", () => {
	it("sets per-op flags only for ops that have at least one rule", () => {
		expect(posts.hasFieldLevelAccess).toEqual({
			read: true,
			create: true,
			update: true,
		});
	});

	it("leaves the flag undefined when no field defines access", () => {
		const [plain] = resolveCollections([
			{
				slug: "plain",
				fields: { title: { type: "text" } },
			},
		]);
		if (!plain) throw new Error("expected resolved collection");

		expect(plain.hasFieldLevelAccess).toBeUndefined();
	});
});

// ? --------------------------------------------------------------
// ? applyReadFieldAccess — strips read-denied fields
// ? --------------------------------------------------------------
describe("applyReadFieldAccess", () => {
	it("strips fields denied for read", async () => {
		const doc = {
			id: "p1",
			title: "hi",
			secretNotes: "shh",
			status: "draft",
		};
		const out = await applyReadFieldAccess(posts, doc, customer);

		expect(out).toEqual({
			id: "p1",
			title: "hi",
			status: "draft",
		});
		expect(out.secretNotes).toBeUndefined();
	});

	it("keeps all fields when the user is allowed", async () => {
		const doc = {
			id: "p1",
			title: "hi",
			secretNotes: "shh",
			status: "draft",
		};
		const out = await applyReadFieldAccess(posts, doc, admin);

		expect(out).toEqual(doc);
	});

	it("keeps fields with no rule (default-allow)", async () => {
		const doc = { id: "p1", title: "hi" };
		const out = await applyReadFieldAccess(posts, doc, null);

		expect(out.title).toBe("hi");
	});

	it("returns a new object — does not mutate input", async () => {
		const doc = { id: "p1", title: "hi", secretNotes: "shh" };
		const out = await applyReadFieldAccess(posts, doc, customer);

		expect(out).not.toBe(doc);
		expect(doc.secretNotes).toBe("shh");
	});
});

// ? --------------------------------------------------------------
// ? applyWriteFieldAccess — silent-drop denied fields
// ? --------------------------------------------------------------
describe("applyWriteFieldAccess", () => {
	const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	beforeEach(() => {
		warnSpy.mockClear();
	});

	it("drops update-denied fields silently", async () => {
		const data = { title: "edit", status: "published", secretNotes: "x" };
		const out = await applyWriteFieldAccess(posts, data, "update", customer, {
			id: "p1",
			title: "old",
			status: "draft",
		});

		expect(out).toEqual({ title: "edit" });
	});

	it("keeps fields the user can write", async () => {
		const data = { title: "edit", status: "published", secretNotes: "x" };
		const out = await applyWriteFieldAccess(posts, data, "update", admin, {
			id: "p1",
		});

		expect(out).toEqual(data);
	});

	it("warns in dev mode when fields are dropped", async () => {
		const data = { title: "edit", secretNotes: "x" };
		await applyWriteFieldAccess(posts, data, "update", customer, null);

		expect(console.warn).toHaveBeenCalledOnce();
		const msg = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(typeof msg).toBe("string");
		expect(msg).toMatch(/secretNotes/);
	});

	it("does not warn when nothing is dropped", async () => {
		const data = { title: "edit" };
		await applyWriteFieldAccess(posts, data, "update", customer, null);

		expect(console.warn).not.toHaveBeenCalled();
	});

	it("leaves unknown fields alone (validator owns that error)", async () => {
		const data = { title: "edit", phantomField: "what" };
		const out = await applyWriteFieldAccess(
			posts,
			data,
			"update",
			customer,
			null,
		);

		expect(out.phantomField).toBe("what");
	});

	it("threads `existing` doc through to the access fn", async () => {
		const seen: Array<Record<string, unknown> | null | undefined> = [];
		const [col] = resolveCollections([
			{
				slug: "x",
				fields: {
					name: {
						type: "text",
						access: {
							update: (ctx) => {
								seen.push(ctx.doc);
								return true;
							},
						},
					},
				},
			},
		]);
		if (!col) throw new Error("expected resolved collection");

		const existing = { id: "1", name: "old" };
		await applyWriteFieldAccess(
			col,
			{ name: "new" },
			"update",
			admin,
			existing,
		);

		expect(seen[0]).toEqual(existing);
	});
});

// ? --------------------------------------------------------------
// ? evaluateFieldAccess — admin UI permissions snapshot
// ? --------------------------------------------------------------
describe("evaluateFieldAccess", () => {
	it("returns canRead + canUpdate for every field", async () => {
		const doc = {
			id: "p1",
			title: "hi",
			secretNotes: "shh",
			status: "draft",
		};
		const map = await evaluateFieldAccess(posts, doc, customer);

		// ? title: no rule → both true (default-allow)
		expect(map.get("title")).toEqual({ canRead: true, canUpdate: true });
		// ? status: no read rule → readable; update is admin-only → not editable
		expect(map.get("status")).toEqual({ canRead: true, canUpdate: false });
		// ? secretNotes: admin-only on both
		expect(map.get("secretNotes")).toEqual({
			canRead: false,
			canUpdate: false,
		});
	});

	it("flips for admins", async () => {
		const map = await evaluateFieldAccess(posts, null, admin);
		expect(map.get("secretNotes")).toEqual({
			canRead: true,
			canUpdate: true,
		});
		expect(map.get("status")?.canUpdate).toBe(true);
	});
});
