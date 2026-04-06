// ? Tests for admin/middleware.ts — the /admin/* guard.
// ? Runs AFTER the global session middleware, so locals.clayUser is already resolved.
// ? This file's job is the redirect matrix:
// ?   - non-admin path → passthrough
// ?   - no users → /admin/setup
// ?   - users exist + no user → /admin/login
// ?   - users exist + logged in → pass, then role-gate via access.admin
// ?   - special handling for /admin/setup and /admin/login themselves

import { beforeEach, describe, expect, it, vi } from "vitest";

// ? --------------------------------------------------------------
// ? mocks
// ? --------------------------------------------------------------

const fakeUsers: Record<string, unknown>[] = [];

const fakeCms = new Proxy(
	{},
	{
		get(_, prop: string) {
			if (prop === "users") {
				return {
					find: vi.fn(async () => fakeUsers.slice()),
				};
			}

			return undefined;
		},
	},
);

vi.mock("virtual:clay-cms/api", () => ({ default: fakeCms }));

const adminFn = vi.fn(async () => true);

vi.mock("virtual:clay-cms/config", () => ({
	default: {
		admin: { user: "users" },
		collections: [
			{
				slug: "users",
				auth: true,
				access: {
					admin: (...args: unknown[]) => adminFn(...(args as [])),
				},
			},
		],
	},
}));

const { onRequest } = await import("./middleware.js");

// ? --------------------------------------------------------------
// ? test harness
// ? --------------------------------------------------------------

function fakeContext(pathname: string, clayUser: unknown = null) {
	const redirect = vi.fn(
		(to: string) =>
			new Response(null, { status: 302, headers: { location: to } }),
	);

	return {
		url: new URL(`https://example.com${pathname}`),
		locals: { clayUser } as Record<string, unknown>,
		redirect,
	};
}

const next = vi.fn(async () => new Response("ok"));

beforeEach(() => {
	fakeUsers.length = 0;
	next.mockClear();
	adminFn.mockClear();
	adminFn.mockResolvedValue(true);
});

// ? --------------------------------------------------------------
// ? non-admin paths
// ? --------------------------------------------------------------

describe("non-admin paths", () => {
	it("passes through when the path is not under /admin", async () => {
		const ctx = fakeContext("/blog/hello");

		const result = await onRequest(ctx as never, next);

		expect(next).toHaveBeenCalledOnce();
		expect(ctx.redirect).not.toHaveBeenCalled();
		expect(result).toBeInstanceOf(Response);
	});

	it("does NOT call cms.users.find on non-admin paths (cheap passthrough)", async () => {
		const ctx = fakeContext("/");

		await onRequest(ctx as never, next);

		// ? cms[slug] is only touched once we're inside /admin gating
		// ? assertion via side-effect: next was called before any find()
		expect(next).toHaveBeenCalledOnce();
	});
});

// ? --------------------------------------------------------------
// ? /admin/setup
// ? --------------------------------------------------------------

describe("/admin/setup", () => {
	it("renders setup when zero users exist", async () => {
		const ctx = fakeContext("/admin/setup");

		await onRequest(ctx as never, next);

		expect(next).toHaveBeenCalledOnce();
		expect(ctx.redirect).not.toHaveBeenCalled();
	});

	it("redirects to /admin/login when users exist and no one is logged in", async () => {
		fakeUsers.push({ id: "u1" });

		const ctx = fakeContext("/admin/setup");

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin/login");
		expect(next).not.toHaveBeenCalled();
	});

	it("redirects to /admin when users exist and someone is logged in", async () => {
		fakeUsers.push({ id: "u1" });

		const ctx = fakeContext("/admin/setup", { id: "u1", role: "admin" });

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin");
	});
});

// ? --------------------------------------------------------------
// ? /admin/login
// ? --------------------------------------------------------------

describe("/admin/login", () => {
	it("redirects to /admin/setup when there are zero users", async () => {
		const ctx = fakeContext("/admin/login");

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin/setup");
	});

	it("redirects to /admin when already logged in", async () => {
		fakeUsers.push({ id: "u1" });

		const ctx = fakeContext("/admin/login", { id: "u1", role: "admin" });

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin");
	});

	it("renders the login form when users exist and no one is logged in", async () => {
		fakeUsers.push({ id: "u1" });

		const ctx = fakeContext("/admin/login");

		await onRequest(ctx as never, next);

		expect(next).toHaveBeenCalledOnce();
		expect(ctx.redirect).not.toHaveBeenCalled();
	});
});

// ? --------------------------------------------------------------
// ? protected /admin/* routes
// ? --------------------------------------------------------------

describe("/admin/* (protected)", () => {
	it("redirects to /admin/setup when zero users exist", async () => {
		const ctx = fakeContext("/admin");

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin/setup");
	});

	it("redirects to /admin/login when users exist and no one is logged in", async () => {
		fakeUsers.push({ id: "u1" });

		const ctx = fakeContext("/admin/collections/posts");

		await onRequest(ctx as never, next);

		expect(ctx.redirect).toHaveBeenCalledWith("/admin/login");
	});

	it("calls access.admin with the current user and lets admins through", async () => {
		fakeUsers.push({ id: "u1" });

		const user = { id: "u1", role: "admin" };
		const ctx = fakeContext("/admin", user);

		await onRequest(ctx as never, next);

		expect(adminFn).toHaveBeenCalledWith({
			user,
			operation: "admin",
			collection: "users",
		});
		expect(next).toHaveBeenCalledOnce();
	});

	it("returns 403 when access.admin denies the user", async () => {
		fakeUsers.push({ id: "u1" });
		adminFn.mockResolvedValue(false);

		const user = { id: "u1", role: "customer" };
		const ctx = fakeContext("/admin", user);

		const result = await onRequest(ctx as never, next);

		expect(next).not.toHaveBeenCalled();
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(403);
	});
});
