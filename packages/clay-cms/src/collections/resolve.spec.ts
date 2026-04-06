import { describe, expect, it } from "vitest";
import { isLoggedIn } from "../access/helpers.js";
import { resolveCollections } from "./resolve.js";
import type { CollectionConfig } from "./types.js";

const post: CollectionConfig = {
	slug: "posts",
	fields: { title: { type: "text", required: true } },
};

const users: CollectionConfig = {
	slug: "users",
	auth: true,
	fields: { name: { type: "text", required: true } },
};

describe("resolveCollections — access defaults", () => {
	it("fills content defaults: read public, writes require login", async () => {
		const [resolved] = resolveCollections([post]);

		if (!resolved) throw new Error("expected resolved collection");

		const ctx = {
			user: null,
			operation: "read" as const,
			collection: "posts",
		};

		expect(await resolved.access.read(ctx)).toBe(true);

		expect(await resolved.access.create({ ...ctx, operation: "create" })).toBe(
			false,
		);

		expect(
			await resolved.access.create({
				...ctx,
				operation: "create",
				user: { id: "1" },
			}),
		).toBe(true);

		expect(resolved.access.admin).toBeUndefined();
	});

	it("fills auth defaults: read requires login, create/delete admin-only, admin op present", async () => {
		const [resolved] = resolveCollections([users]);

		if (!resolved) throw new Error("expected resolved collection");

		const baseCtx = {
			operation: "read" as const,
			collection: "users",
		};

		// ? read denied for anonymous, allowed for any logged-in user
		expect(await resolved.access.read({ ...baseCtx, user: null })).toBe(false);

		expect(
			await resolved.access.read({
				...baseCtx,
				user: { id: "1", role: "customer" },
			}),
		).toBe(true);

		// ? create requires admin role
		expect(
			await resolved.access.create({
				...baseCtx,
				operation: "create",
				user: { id: "1", role: "editor" },
			}),
		).toBe(false);

		expect(
			await resolved.access.create({
				...baseCtx,
				operation: "create",
				user: { id: "1", role: "admin" },
			}),
		).toBe(true);

		// ? update: admin OR self
		expect(
			await resolved.access.update({
				...baseCtx,
				operation: "update",
				id: "1",
				user: { id: "1", role: "customer" },
			}),
		).toBe(true);

		expect(
			await resolved.access.update({
				...baseCtx,
				operation: "update",
				id: "2",
				user: { id: "1", role: "customer" },
			}),
		).toBe(false);

		// ? delete: admin AND not self
		expect(
			await resolved.access.delete({
				...baseCtx,
				operation: "delete",
				id: "1",
				user: { id: "1", role: "admin" },
			}),
		).toBe(false);

		expect(
			await resolved.access.delete({
				...baseCtx,
				operation: "delete",
				id: "2",
				user: { id: "1", role: "admin" },
			}),
		).toBe(true);

		// ? admin op present and gates by role
		const adminOp = resolved.access.admin;

		if (!adminOp) throw new Error("expected admin op on auth collection");

		expect(
			await adminOp({
				...baseCtx,
				operation: "admin",
				user: { id: "1", role: "admin" },
			}),
		).toBe(true);

		expect(
			await adminOp({
				...baseCtx,
				operation: "admin",
				user: { id: "1", role: "customer" },
			}),
		).toBe(false);
	});

	it("per-op override leaves other ops at defaults", async () => {
		const [resolved] = resolveCollections([
			{ ...post, access: { read: isLoggedIn } },
		]);

		if (!resolved) throw new Error("expected resolved collection");

		const ctx = {
			user: null,
			operation: "read" as const,
			collection: "posts",
		};

		// ? read overridden — anonymous now denied
		expect(await resolved.access.read(ctx)).toBe(false);

		// ? create still falls back to content default (requires login)
		expect(
			await resolved.access.create({
				...ctx,
				operation: "create",
				user: { id: "1" },
			}),
		).toBe(true);
	});
});
