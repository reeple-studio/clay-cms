// ? Tests for the global session middleware (runtime/session-middleware.ts).
// ? Surface under test: token validation, locals population, invalid-token cookie cleanup.
// ? Must NOT redirect (admin gating lives in admin/middleware.ts).
// ? The middleware no longer wraps cms — consumers thread `user: Astro.locals.clayUser`
// ? on each call site so the gate enforces against them.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ? -------- mocks for the virtuals + auth helpers --------
const fakeCms = new Proxy(
	{},
	{
		get(_, prop: string) {
			if (prop === "__tables") return () => ({ users: { fake: true } });
			if (prop === "__db") return async () => ({ fakeDb: true });
			return undefined;
		},
	},
);

vi.mock("virtual:clay-cms/api", () => ({ default: fakeCms }));

vi.mock("virtual:clay-cms/config", () => ({
	default: { admin: { user: "users" } },
}));

vi.mock("virtual:clay-cms/init-sql", () => ({
	default: vi.fn(async () => undefined),
}));

const validateSession = vi.fn();
const getSessionToken = vi.fn();
const deleteSessionCookie = vi.fn();

vi.mock("clay-cms/auth", () => ({
	validateSession: (...args: unknown[]) => validateSession(...args),
	getSessionToken: (...args: unknown[]) => getSessionToken(...args),
	deleteSessionCookie: (...args: unknown[]) => deleteSessionCookie(...args),
}));

// ? import after mocks are registered
const { onRequest } = await import("./session-middleware.js");

function fakeContext() {
	return {
		cookies: { fake: true },
		locals: {} as Record<string, unknown>,
	};
}

beforeEach(() => {
	validateSession.mockReset();
	getSessionToken.mockReset();
	deleteSessionCookie.mockReset();
});

// ? --------------------------------------------------------------
// ? onRequest — token validation flow
// ? --------------------------------------------------------------
describe("onRequest — session token flow", () => {
	it("no token → locals user/session are null, no validation attempt", async () => {
		getSessionToken.mockReturnValue(null);

		const ctx = fakeContext();
		await onRequest(ctx as never, async () => new Response());

		expect(ctx.locals.clayUser).toBeNull();
		expect(ctx.locals.claySession).toBeNull();
		expect(ctx.locals.clayCms).toBeUndefined();
		expect(validateSession).not.toHaveBeenCalled();
		expect(deleteSessionCookie).not.toHaveBeenCalled();
	});

	it("valid token → locals populated with user + session", async () => {
		const user = { id: "u1", role: "admin" };
		const session = { id: "s1", token: "token-abc" };

		getSessionToken.mockReturnValue("token-abc");
		validateSession.mockResolvedValue({ user, session });

		const ctx = fakeContext();
		await onRequest(ctx as never, async () => new Response());

		expect(ctx.locals.clayUser).toEqual(user);
		expect(ctx.locals.claySession).toEqual(session);
		expect(validateSession).toHaveBeenCalledOnce();
		expect(deleteSessionCookie).not.toHaveBeenCalled();
	});

	it("invalid/expired token → cookie cleared, locals null", async () => {
		getSessionToken.mockReturnValue("token-bad");
		validateSession.mockResolvedValue(null);

		const ctx = fakeContext();
		await onRequest(ctx as never, async () => new Response());

		expect(ctx.locals.clayUser).toBeNull();
		expect(ctx.locals.claySession).toBeNull();
		expect(deleteSessionCookie).toHaveBeenCalledOnce();
	});

	it("validateSession is called with the auth slug from config.admin.user", async () => {
		getSessionToken.mockReturnValue("token-abc");

		validateSession.mockResolvedValue({
			user: { id: "u1" },
			session: { id: "s1" },
		});

		await onRequest(fakeContext() as never, async () => new Response());

		expect(validateSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"token-abc",
			"users",
		);
	});

	it("middleware calls next() and never redirects", async () => {
		getSessionToken.mockReturnValue(null);

		const next = vi.fn(async () => new Response("ok"));
		const result = await onRequest(fakeContext() as never, next);

		expect(next).toHaveBeenCalledOnce();
		expect(result).toBeInstanceOf(Response);
	});
});
