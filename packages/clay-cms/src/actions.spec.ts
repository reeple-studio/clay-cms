// ? Tests for actions.ts — setup / login / logout handlers.
// ? Critical invariants this file pins:
// ?   1. setup: the first-user race-condition guard (users.length > 0 → FORBIDDEN).
// ?   2. setup: force-assigns role: "admin", ignoring any client-supplied role.
// ?   3. setup: creates a session and sets the cookie on success.
// ?   4. login: unknown email → UNAUTHORIZED (no user enumeration leak via 404).
// ?   5. login: wrong password → UNAUTHORIZED.
// ?   6. login: success → session created, cookie set.
// ?   7. logout: delete session row + clear cookie.
// ?   8. logout: missing cookie → still clears, no crash.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ? --------------------------------------------------------------
// ? mocks
// ? --------------------------------------------------------------

const store: { users: Array<Record<string, unknown>> } = { users: [] };

const usersApi = {
	find: vi.fn(async (_opts?: unknown) => store.users.slice()),
	create: vi.fn(
		async (opts: { data: Record<string, unknown>; requireEmpty?: boolean }) => {
			// ? mirror crud's requireEmpty guard: refuse (null) when a row exists
			if (opts.requireEmpty && store.users.length > 0) return null;

			const doc = { id: `u-${store.users.length + 1}`, ...opts.data };
			store.users.push(doc);

			return doc;
		},
	),
};

const INTERNAL_DB = Symbol.for("clay-cms.internal.db");
const INTERNAL_TABLES = Symbol.for("clay-cms.internal.tables");

const fakeCms = new Proxy(
	{},
	{
		get(_, prop) {
			if (prop === "users") return usersApi;
			if (prop === INTERNAL_DB) return async () => ({ fake: "db" });
			if (prop === INTERNAL_TABLES)
				return () => ({
					_sessions: { name: "_sessions" },
					_rate_limits: { name: "_rate_limits" },
				});

			return undefined;
		},
	},
);

vi.mock("virtual:clay-cms/api", () => ({
	default: fakeCms,
	INTERNAL_DB,
	INTERNAL_TABLES,
}));

vi.mock("virtual:clay-cms/config", () => ({
	default: {
		admin: { user: "users" },
		collections: [{ slug: "users", auth: true, fields: {} }],
	},
}));

// ? auth helper mocks — we want to observe calls without running real bcrypt/db
const createSession = vi.fn(async () => ({
	id: "s1",
	token: "tok-abc",
	userId: "u-1",
	expiresAt: new Date().toISOString(),
	createdAt: new Date().toISOString(),
}));

const deleteSession = vi.fn(
	async (_db: unknown, _table: unknown, _token: string) => undefined,
);
const setSessionCookie = vi.fn();
const deleteSessionCookie = vi.fn();
const getSessionToken = vi.fn();
const hashPassword = vi.fn(async (p: string) => `hashed::${p}`);
const verifyPassword = vi.fn(
	async (plain: string, hash: string) => hash === `hashed::${plain}`,
);
// ? constant-time not-found branch — always false, but we assert it IS called
const fakeVerifyPassword = vi.fn(async () => false);
// ? rate limiter is exercised against a real fake in rate-limit.spec.ts; here
// ? we let every attempt through so the auth-flow assertions stay focused.
const checkRateLimit = vi.fn(async () => true);
// ? cleared on successful login so a shared IP isn't locked out by its own logins
const clearRateLimit = vi.fn(async () => {});

vi.mock("clay-cms/auth", () => ({
	createSession,
	deleteSession,
	setSessionCookie,
	deleteSessionCookie,
	getSessionToken,
	hashPassword,
	verifyPassword,
	fakeVerifyPassword,
	checkRateLimit,
	clearRateLimit,
}));

// ? import after mocks
// ? astro:actions wraps handlers at the type level, but the vitest shim exposes
// ? `.handler` at runtime. We describe just the runtime shape we touch.
type ActionHandler<I> = {
	handler: (input: I, ctx: { cookies: { id: string } }) => Promise<unknown>;
};

interface ServerShape {
	cms: {
		setup: ActionHandler<{
			name: string;
			email: string;
			password: string;
		}>;
		login: ActionHandler<{ email: string; password: string }>;
		logout: ActionHandler<Record<string, never>>;
	};
}

const { server } = (await import("./actions.js")) as unknown as {
	server: ServerShape;
};
const { ActionError } = await import("./test-shims/astro-actions.js");

// ? --------------------------------------------------------------
// ? helpers
// ? --------------------------------------------------------------

function fakeContext() {
	return { cookies: { id: "cookie-jar" } };
}

beforeEach(() => {
	store.users = [];

	for (const fn of [
		usersApi.find,
		usersApi.create,
		createSession,
		deleteSession,
		setSessionCookie,
		deleteSessionCookie,
		getSessionToken,
		hashPassword,
		verifyPassword,
		fakeVerifyPassword,
		checkRateLimit,
		clearRateLimit,
	]) {
		fn.mockClear();
	}

	checkRateLimit.mockImplementation(async () => true);

	verifyPassword.mockImplementation(
		async (plain: string, hash: string) => hash === `hashed::${plain}`,
	);
});

// ? --------------------------------------------------------------
// ? setup
// ? --------------------------------------------------------------

describe("server.cms.setup", () => {
	const input = {
		name: "Alice",
		email: "alice@example.com",
		password: "supersecret",
	};

	it("creates the first user, hashes the password, and sets a session cookie", async () => {
		const ctx = fakeContext();

		const result = await server.cms.setup.handler(input, ctx);

		expect(hashPassword).toHaveBeenCalledWith("supersecret");
		expect(usersApi.create).toHaveBeenCalledOnce();

		const call = usersApi.create.mock.calls[0];

		if (!call) throw new Error("expected create to have been called");

		const [{ data: created }] = call;

		expect(created).toMatchObject({
			name: "Alice",
			email: "alice@example.com",
			hashedPassword: "hashed::supersecret",
			role: "admin",
		});

		expect(createSession).toHaveBeenCalledOnce();
		expect(setSessionCookie).toHaveBeenCalledWith(ctx.cookies, "tok-abc");
		expect(result).toEqual({ userId: "u-1" });
	});

	it("force-assigns role: admin even if the client tries to smuggle in a different role", async () => {
		const ctx = fakeContext();

		// ? exercise untrusted input — client tries to smuggle a role field that isn't in the action's zod schema. Cast through unknown to model that.
		await server.cms.setup.handler(
			{ ...input, role: "customer" } as unknown as typeof input,
			ctx,
		);

		const call = usersApi.create.mock.calls[0];
		if (!call) throw new Error("expected create to have been called");

		const [{ data: created }] = call;

		expect(created.role).toBe("admin");
	});

	it("throws FORBIDDEN if setup has already been completed (requireEmpty guard returns null)", async () => {
		store.users.push({ id: "u-existing", email: "someone@example.com" });

		await expect(
			server.cms.setup.handler(input, fakeContext()),
		).rejects.toMatchObject({
			name: "ActionError",
			code: "FORBIDDEN",
		});

		// ? create IS attempted (with requireEmpty) but the guard returns null →
		// ? no session, no second user.
		expect(usersApi.create).toHaveBeenCalledOnce();
		expect(usersApi.create.mock.calls[0]?.[0]).toMatchObject({
			requireEmpty: true,
			overrideAccess: true,
		});
		expect(setSessionCookie).not.toHaveBeenCalled();
		expect(store.users).toHaveLength(1);
	});

	it("two concurrent setups create exactly one user (singleton guard)", async () => {
		// ? both fire before either resolves; the requireEmpty guard (simulated in
		// ? the fake, real INSERT … WHERE NOT EXISTS in crud) lets only one win.
		const results = await Promise.allSettled([
			server.cms.setup.handler(
				{ name: "A", email: "a@example.com", password: "passwordA" },
				fakeContext(),
			),
			server.cms.setup.handler(
				{ name: "B", email: "b@example.com", password: "passwordB" },
				fakeContext(),
			),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(store.users).toHaveLength(1);
	});

	it("returns the generic 'Setup unavailable.' error (no state disclosure)", async () => {
		store.users.push({ id: "u-existing", email: "someone@example.com" });

		await expect(
			server.cms.setup.handler(input, fakeContext()),
		).rejects.toMatchObject({ message: "Setup unavailable." });
	});

	it("rejects with the generic error when rate-limited", async () => {
		checkRateLimit.mockImplementation(async () => false);

		await expect(
			server.cms.setup.handler(input, fakeContext()),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Setup unavailable.",
		});

		expect(usersApi.create).not.toHaveBeenCalled();
	});

	it("throttles setup at 3 per hour, keyed setup:<ip>", async () => {
		await server.cms.setup.handler(input, fakeContext());

		// ? checkRateLimit(db, table, key, limit, windowMs) — pin the POLICY, not
		// ? just that it's called. A regression to 3→30 or 1h→1min would slip past
		// ? a "was it called" assertion; this trips on the numbers.
		const [, , key, limit, windowMs] = (checkRateLimit.mock.calls[0] ??
			[]) as unknown[];

		expect(key).toBe("setup:unknown");
		expect(limit).toBe(3);
		expect(windowMs).toBe(60 * 60 * 1000);
	});
});

// ? --------------------------------------------------------------
// ? login
// ? --------------------------------------------------------------

describe("server.cms.login", () => {
	function seedAlice() {
		store.users.push({
			id: "u-alice",
			email: "alice@example.com",
			hashedPassword: "hashed::supersecret",
			role: "admin",
		});
	}

	it("returns UNAUTHORIZED for unknown email", async () => {
		await expect(
			server.cms.login.handler(
				{ email: "ghost@example.com", password: "supersecret" },
				fakeContext(),
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(createSession).not.toHaveBeenCalled();
		expect(setSessionCookie).not.toHaveBeenCalled();
	});

	it("returns UNAUTHORIZED for wrong password", async () => {
		seedAlice();

		await expect(
			server.cms.login.handler(
				{ email: "alice@example.com", password: "wrongwrong" },
				fakeContext(),
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(createSession).not.toHaveBeenCalled();
	});

	it("queries users with showHiddenFields so the hashedPassword is available", async () => {
		seedAlice();

		await server.cms.login.handler(
			{ email: "alice@example.com", password: "supersecret" },
			fakeContext(),
		);

		expect(usersApi.find).toHaveBeenCalledWith({
			where: { email: { equals: "alice@example.com" } },
			showHiddenFields: true,
			overrideAccess: true,
		});
	});

	it("creates a session and sets the cookie on success", async () => {
		seedAlice();
		const ctx = fakeContext();

		const result = await server.cms.login.handler(
			{ email: "alice@example.com", password: "supersecret" },
			ctx,
		);

		expect(createSession).toHaveBeenCalledOnce();
		expect(setSessionCookie).toHaveBeenCalledWith(ctx.cookies, "tok-abc");
		expect(result).toEqual({ userId: "u-alice" });
	});

	it("uses the same error shape for unknown email and wrong password (no enumeration)", async () => {
		let unknownErr: unknown;
		let wrongPwErr: unknown;

		try {
			await server.cms.login.handler(
				{ email: "ghost@example.com", password: "supersecret" },
				fakeContext(),
			);
		} catch (e) {
			unknownErr = e;
		}

		seedAlice();

		try {
			await server.cms.login.handler(
				{ email: "alice@example.com", password: "wrongwrong" },
				fakeContext(),
			);
		} catch (e) {
			wrongPwErr = e;
		}

		expect(unknownErr).toBeInstanceOf(ActionError);
		expect(wrongPwErr).toBeInstanceOf(ActionError);

		expect((unknownErr as InstanceType<typeof ActionError>).code).toBe(
			"UNAUTHORIZED",
		);

		expect((wrongPwErr as InstanceType<typeof ActionError>).code).toBe(
			"UNAUTHORIZED",
		);

		expect((unknownErr as Error).message).toBe((wrongPwErr as Error).message);
	});

	it("runs a bcrypt verify even for an unknown email (constant-time)", async () => {
		await expect(
			server.cms.login.handler(
				{ email: "ghost@example.com", password: "supersecret" },
				fakeContext(),
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		// ? the not-found branch burns a dummy bcrypt so timing can't leak existence
		expect(fakeVerifyPassword).toHaveBeenCalledOnce();
		expect(verifyPassword).not.toHaveBeenCalled();
	});

	it("rotates the session: kills the caller's prior cookie session on login", async () => {
		seedAlice();
		getSessionToken.mockReturnValue("prior-token");

		await server.cms.login.handler(
			{ email: "alice@example.com", password: "supersecret" },
			fakeContext(),
		);

		// ? the pre-login token is deleted before the new session is minted
		expect(deleteSession).toHaveBeenCalledOnce();
		expect(deleteSession.mock.calls[0]?.[2]).toBe("prior-token");
		expect(createSession).toHaveBeenCalledOnce();
	});

	it("does not delete a session when no prior cookie is present", async () => {
		seedAlice();
		getSessionToken.mockReturnValue(null);

		await server.cms.login.handler(
			{ email: "alice@example.com", password: "supersecret" },
			fakeContext(),
		);

		expect(deleteSession).not.toHaveBeenCalled();
		expect(createSession).toHaveBeenCalledOnce();
	});

	it("returns the generic credentials error when rate-limited", async () => {
		seedAlice();
		checkRateLimit.mockImplementation(async () => false);

		await expect(
			server.cms.login.handler(
				{ email: "alice@example.com", password: "supersecret" },
				fakeContext(),
			),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Invalid email or password.",
		});

		// ? rate-limited before any credential work
		expect(verifyPassword).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
	});

	it("throttles login at 5 per 15 minutes, keyed login:<ip>", async () => {
		seedAlice();

		await server.cms.login.handler(
			{ email: "alice@example.com", password: "supersecret" },
			fakeContext(),
		);

		// ? pin the POLICY numbers (see setup) — 5/15min, per action+IP.
		const [, , key, limit, windowMs] = (checkRateLimit.mock.calls[0] ??
			[]) as unknown[];

		expect(key).toBe("login:unknown");
		expect(limit).toBe(5);
		expect(windowMs).toBe(15 * 60 * 1000);
	});
});

// ? --------------------------------------------------------------
// ? logout
// ? --------------------------------------------------------------

describe("server.cms.logout", () => {
	it("deletes the session row and clears the cookie when a token is present", async () => {
		getSessionToken.mockReturnValue("tok-abc");

		const ctx = fakeContext();
		const result = await server.cms.logout.handler({}, ctx);

		expect(deleteSession).toHaveBeenCalledOnce();
		expect(deleteSessionCookie).toHaveBeenCalledWith(ctx.cookies);
		expect(result).toEqual({ success: true });
	});

	it("still clears the cookie and succeeds when no token is present", async () => {
		getSessionToken.mockReturnValue(null);

		const ctx = fakeContext();
		const result = await server.cms.logout.handler({}, ctx);

		expect(deleteSession).not.toHaveBeenCalled();
		expect(deleteSessionCookie).toHaveBeenCalledWith(ctx.cookies);
		expect(result).toEqual({ success: true });
	});
});
