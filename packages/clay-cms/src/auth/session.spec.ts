// ? Tests for auth/session.ts — token generation, session CRUD, cookie helpers.
// ? The db is a tiny in-memory fake that mimics the drizzle surface used here:
// ?   select().from(t).where(eq(t.col, v)).limit(n)
// ?   insert(t).values(row)
// ?   delete(t).where(eq(t.col, v))
// ? Good enough to pin behaviour without pulling in sqlite.

import type { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createSession,
	deleteSession,
	deleteSessionCookie,
	getSessionToken,
	setSessionCookie,
	validateSession,
} from "./session.js";
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "./types.js";

// ? --------------------------------------------------------------
// ? fake drizzle db
// ? --------------------------------------------------------------

type Row = Record<string, unknown>;

// ? tables are plain objects keyed by column name — drizzle's `eq(col, val)` reads col.name
function makeTable(name: string, columns: string[]) {
	const t: Record<string, unknown> = { __name: name };

	for (const c of columns) t[c] = { name: c, table: name };

	return t;
}

function makeDb() {
	const rows: Record<string, Row[]> = {};

	function tableName(t: { __name: string }) {
		return t.__name;
	}

	function matches(row: Row, where: ReturnType<typeof eq>): boolean {
		// ? drizzle's eq() returns an SQL object; we cheat by introspecting the call
		// ? via a marker we attach in a Proxy below. Simpler: re-do the comparison here.
		const w = where as unknown as { _colName: string; _value: unknown };

		return row[w._colName] === w._value;
	}

	// ? typed accessor so specs never have to index `rows` with `| undefined` in the way
	function rowsOf(name: string): Row[] {
		return (rows[name] ??= []);
	}

	function setRows(name: string, next: Row[]): void {
		rows[name] = next;
	}

	const db = {
		rowsOf,
		setRows,

		insert(table: { __name: string }) {
			return {
				values(row: Row) {
					(rows[tableName(table)] ??= []).push({ ...row });
					return Promise.resolve();
				},
			};
		},

		select() {
			return {
				from(table: { __name: string }) {
					let filtered: Row[] = rows[tableName(table)] ?? [];

					const chain = {
						where(w: ReturnType<typeof eq>) {
							filtered = filtered.filter((r) => matches(r, w));
							return chain;
						},
						limit(n: number) {
							return Promise.resolve(filtered.slice(0, n));
						},
					};

					return chain;
				},
			};
		},

		delete(table: { __name: string }) {
			return {
				where(w: ReturnType<typeof eq>) {
					const key = tableName(table);
					rows[key] = (rows[key] ?? []).filter((r) => !matches(r, w));
					return Promise.resolve();
				},
			};
		},
	};

	return db;
}

// ? stub drizzle-orm's eq so we can round-trip { _colName, _value } through the fake
vi.mock("drizzle-orm", () => ({
	eq: (col: { name: string }, value: unknown) => ({
		_colName: col.name,
		_value: value,
	}),
}));

// ? --------------------------------------------------------------
// ? createSession
// ? --------------------------------------------------------------

describe("createSession", () => {
	it("inserts a session row with a 64-char hex token", async () => {
		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);

		const session = await createSession(db, sessions, "u-alice");

		// ? the returned (cookie) token is the 64-char hex plaintext
		expect(session.token).toMatch(/^[0-9a-f]{64}$/);
		expect(session.userId).toBe("u-alice");
		const stored = db.rowsOf("_sessions");

		expect(stored).toHaveLength(1);
		// ? the stored token is the SHA-256 hash (also 64 hex), never the plaintext
		expect(stored[0]?.token).toMatch(/^[0-9a-f]{64}$/);
		expect(stored[0]?.token).not.toBe(session.token);
		expect(stored[0]).toMatchObject({ userId: "u-alice" });
	});

	it("generates a unique token and id on every call", async () => {
		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);

		const a = await createSession(db, sessions, "u-alice");
		const b = await createSession(db, sessions, "u-alice");

		expect(a.token).not.toBe(b.token);
		expect(a.id).not.toBe(b.id);
	});

	it("sets expiresAt exactly 30 days in the future", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));

		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);

		const session = await createSession(db, sessions, "u-alice");

		const created = new Date(session.createdAt).getTime();
		const expires = new Date(session.expiresAt).getTime();

		expect(expires - created).toBe(SESSION_DURATION_MS);

		vi.useRealTimers();
	});
});

// ? --------------------------------------------------------------
// ? validateSession
// ? --------------------------------------------------------------

describe("validateSession", () => {
	function seedUser(db: ReturnType<typeof makeDb>, id: string, rest: Row = {}) {
		db.rowsOf("users").push({ id, ...rest });
	}

	function setup() {
		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);
		const users = makeTable("users", ["id"]);

		return { db, tables: { _sessions: sessions, users } };
	}

	it("returns null for an unknown token", async () => {
		const { db, tables } = setup();

		const result = await validateSession(db, tables, "nope", "users");

		expect(result).toBeNull();
	});

	it("returns { user, session } for a valid token", async () => {
		const { db, tables } = setup();

		seedUser(db, "u-alice", { name: "Alice" });
		const session = await createSession(db, tables._sessions, "u-alice");

		const result = await validateSession(db, tables, session.token, "users");

		expect(result).not.toBeNull();
		expect(result?.user).toMatchObject({ id: "u-alice", name: "Alice" });
		// ? the row stores the hash, so the returned session.token is the hash,
		// ? not the plaintext cookie value — assert identity via userId instead.
		expect(result?.session.userId).toBe("u-alice");
	});

	it("deletes the row and returns null for an expired session", async () => {
		const { db, tables } = setup();
		seedUser(db, "u-alice");

		// ? create a real (hashed) session, then force its stored row into the past.
		// ? validating with the plaintext token hits the expiry branch, which deletes.
		const session = await createSession(db, tables._sessions, "u-alice");
		const stored = db.rowsOf("_sessions");
		if (!stored[0]) throw new Error("expected a stored session row");
		stored[0].expiresAt = new Date(Date.now() - 1000).toISOString();

		const result = await validateSession(db, tables, session.token, "users");

		expect(result).toBeNull();
		expect(db.rowsOf("_sessions")).toHaveLength(0);
	});

	it("returns null when the session's user no longer exists", async () => {
		const { db, tables } = setup();

		// ? session exists but the user row was deleted out from under it
		const session = await createSession(db, tables._sessions, "u-ghost");

		const result = await validateSession(db, tables, session.token, "users");

		expect(result).toBeNull();
	});

	it("returns null when the auth collection table is missing", async () => {
		const { db, tables } = setup();

		const session = await createSession(db, tables._sessions, "u-alice");

		const result = await validateSession(
			db,
			tables,
			session.token,
			"nonexistent",
		);

		expect(result).toBeNull();
	});
});

// ? --------------------------------------------------------------
// ? deleteSession
// ? --------------------------------------------------------------

describe("deleteSession", () => {
	it("removes the row matching the given token", async () => {
		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);

		const a = await createSession(db, sessions, "u-alice");
		await createSession(db, sessions, "u-bob");

		await deleteSession(db, sessions, a.token);

		const stored = db.rowsOf("_sessions");

		expect(stored).toHaveLength(1);
		// ? only Bob's row remains (tokens are stored hashed; identify via userId)
		expect(stored[0]).toMatchObject({ userId: "u-bob" });
	});

	it("is a no-op for an unknown token", async () => {
		const db = makeDb();
		const sessions = makeTable("_sessions", [
			"id",
			"token",
			"userId",
			"expiresAt",
			"createdAt",
		]);

		await createSession(db, sessions, "u-alice");
		await deleteSession(db, sessions, "nope");

		expect(db.rowsOf("_sessions")).toHaveLength(1);
	});
});

// ? --------------------------------------------------------------
// ? cookie helpers
// ? --------------------------------------------------------------

describe("setSessionCookie", () => {
	it("sets the session cookie with hardened flags", () => {
		const set = vi.fn();

		setSessionCookie({ set }, "tok-abc");

		expect(set).toHaveBeenCalledOnce();

		const call = set.mock.calls[0];

		if (!call)
			throw new Error("expected setSessionCookie to invoke cookies.set");

		const [name, value, options] = call;

		// ? under vitest import.meta.env.PROD is false → dev cookie name + secure:false.
		// ? In prod the name becomes __Host-clay-cms.session and secure flips on.
		expect(name).toBe(SESSION_COOKIE_NAME);
		expect(value).toBe("tok-abc");
		expect(options).toEqual({
			path: "/",
			httpOnly: true,
			secure: false,
			sameSite: "lax",
			maxAge: SESSION_DURATION_MS / 1000,
		});
	});
});

describe("deleteSessionCookie", () => {
	it("deletes the cookie at path /", () => {
		const del = vi.fn();

		deleteSessionCookie({ delete: del });

		// ? secure mirrors the set path (false under vitest's non-prod env). In prod
		// ? the `__Host-` cookie MUST carry Secure or the browser drops the deletion.
		expect(del).toHaveBeenCalledWith(SESSION_COOKIE_NAME, {
			path: "/",
			secure: false,
		});
	});
});

describe("getSessionToken", () => {
	it("returns the cookie value when present", () => {
		const get = vi.fn().mockReturnValue({ value: "tok-abc" });

		expect(getSessionToken({ get })).toBe("tok-abc");
		expect(get).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
	});

	it("returns null when the cookie is absent", () => {
		const get = vi.fn().mockReturnValue(undefined);

		expect(getSessionToken({ get })).toBeNull();
	});
});

// ? --------------------------------------------------------------
// ? cookie helpers in production (__Host- prefix + Secure)
// ? --------------------------------------------------------------
// ? isProd() reads import.meta.env.PROD at call time; the specs above cover the
// ? dev branch (vitest's default PROD=false). Here we stub PROD=true to exercise
// ? the hardened prod branch and, crucially, assert the cookie NAME is identical
// ? across set/read/delete — a mismatch there silently strands the session.

describe("cookie helpers in production", () => {
	const PROD_NAME = `__Host-${SESSION_COOKIE_NAME}`;

	beforeEach(() => {
		vi.stubEnv("PROD", true);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("setSessionCookie uses the __Host- prefix and Secure", () => {
		const set = vi.fn();

		setSessionCookie({ set }, "tok-abc");

		const call = set.mock.calls[0];
		if (!call)
			throw new Error("expected setSessionCookie to invoke cookies.set");

		const [name, value, options] = call;

		expect(name).toBe(PROD_NAME);
		expect(value).toBe("tok-abc");
		expect(options).toEqual({
			path: "/",
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			maxAge: SESSION_DURATION_MS / 1000,
		});
	});

	it("deleteSessionCookie mirrors the __Host- name + Secure (else the browser rejects the deletion)", () => {
		const del = vi.fn();

		deleteSessionCookie({ delete: del });

		expect(del).toHaveBeenCalledWith(PROD_NAME, { path: "/", secure: true });
	});

	it("getSessionToken reads the __Host- name — parity across set/read/delete", () => {
		const get = vi.fn().mockReturnValue({ value: "tok-abc" });

		expect(getSessionToken({ get })).toBe("tok-abc");
		expect(get).toHaveBeenCalledWith(PROD_NAME);
	});
});

// ? --------------------------------------------------------------
// ? test hygiene
// ? --------------------------------------------------------------

beforeEach(() => {
	// ? reset any lingering fake timers
});

afterEach(() => {
	vi.useRealTimers();
});
