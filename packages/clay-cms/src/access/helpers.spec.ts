import { describe, expect, it } from "vitest";
import {
	and,
	isAdmin,
	isLoggedIn,
	isSelf,
	not,
	or,
	ownDocuments,
} from "./helpers.js";
import type { AccessContext } from "./types.js";

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
	user: null,
	operation: "read",
	collection: "test",
	...overrides,
});

describe("isLoggedIn", () => {
	it("returns false when user is null", () => {
		expect(isLoggedIn(ctx())).toBe(false);
	});

	it("returns true when user is present", () => {
		expect(isLoggedIn(ctx({ user: { id: "1" } }))).toBe(true);
	});
});

describe("isAdmin", () => {
	it("returns false when user is null", () => {
		expect(isAdmin(ctx())).toBe(false);
	});

	it("returns false when role is not admin", () => {
		expect(isAdmin(ctx({ user: { id: "1", role: "editor" } }))).toBe(false);
	});

	it("returns true when role is admin", () => {
		expect(isAdmin(ctx({ user: { id: "1", role: "admin" } }))).toBe(true);
	});
});

describe("isSelf", () => {
	it("returns false when user is null", () => {
		expect(isSelf(ctx({ id: "1" }))).toBe(false);
	});

	it("returns false when id is missing", () => {
		expect(isSelf(ctx({ user: { id: "1" } }))).toBe(false);
	});

	it("returns false when user.id !== id", () => {
		expect(isSelf(ctx({ user: { id: "1" }, id: "2" }))).toBe(false);
	});

	it("returns true when user.id === id", () => {
		expect(isSelf(ctx({ user: { id: "1" }, id: "1" }))).toBe(true);
	});
});

describe("and", () => {
	it("returns true when all fns return true", async () => {
		const fn = and(
			() => true,
			() => true,
		);

		expect(await fn(ctx())).toBe(true);
	});

	it("returns false when any fn returns false", async () => {
		const fn = and(
			() => true,
			() => false,
		);

		expect(await fn(ctx())).toBe(false);
	});

	it("awaits async fns", async () => {
		const fn = and(
			async () => true,
			async () => true,
		);

		expect(await fn(ctx())).toBe(true);
	});

	it("returns true for empty list", async () => {
		expect(await and()(ctx())).toBe(true);
	});
});

describe("or", () => {
	it("returns true when any fn returns true", async () => {
		const fn = or(
			() => false,
			() => true,
		);

		expect(await fn(ctx())).toBe(true);
	});

	it("returns false when all fns return false", async () => {
		const fn = or(
			() => false,
			() => false,
		);

		expect(await fn(ctx())).toBe(false);
	});

	it("returns false for empty list", async () => {
		expect(await or()(ctx())).toBe(false);
	});
});

describe("ownDocuments", () => {
	it("returns false for anonymous", () => {
		expect(ownDocuments("customer")(ctx())).toBe(false);
	});

	it("returns a Where filtering on the user id", () => {
		expect(ownDocuments("customer")(ctx({ user: { id: "u1" } }))).toEqual({
			customer: { equals: "u1" },
		});
	});
});

describe("and — Where merging", () => {
	it("false short-circuits to false", async () => {
		const fn = and(
			() => ({ a: { equals: 1 } }),
			() => false,
		);

		expect(await fn(ctx())).toBe(false);
	});

	it("true is identity (drops out)", async () => {
		const fn = and(
			() => true,
			() => ({ a: { equals: 1 } }),
		);

		expect(await fn(ctx())).toEqual({ a: { equals: 1 } });
	});

	it("multiple Wheres merge into { and: [...] }", async () => {
		const fn = and(
			() => ({ a: { equals: 1 } }),
			() => ({ b: { equals: 2 } }),
		);

		expect(await fn(ctx())).toEqual({
			and: [{ a: { equals: 1 } }, { b: { equals: 2 } }],
		});
	});
});

describe("or — Where merging", () => {
	it("true short-circuits to true (most permissive)", async () => {
		const fn = or(
			() => ({ a: { equals: 1 } }),
			() => true,
		);

		expect(await fn(ctx())).toBe(true);
	});

	it("false is identity (drops out)", async () => {
		const fn = or(
			() => false,
			() => ({ a: { equals: 1 } }),
		);

		expect(await fn(ctx())).toEqual({ a: { equals: 1 } });
	});

	it("multiple Wheres merge into { or: [...] }", async () => {
		const fn = or(
			() => ({ a: { equals: 1 } }),
			() => ({ b: { equals: 2 } }),
		);

		expect(await fn(ctx())).toEqual({
			or: [{ a: { equals: 1 } }, { b: { equals: 2 } }],
		});
	});

	it("north star: or(isAdmin, ownDocuments('customer'))", async () => {
		const fn = or(isAdmin, ownDocuments("customer"));

		// ? admin → unrestricted
		expect(await fn(ctx({ user: { id: "u1", role: "admin" } }))).toBe(true);

		// ? non-admin user → Where filter on customer
		expect(await fn(ctx({ user: { id: "u1", role: "customer" } }))).toEqual({
			customer: { equals: "u1" },
		});

		// ? anonymous → false
		expect(await fn(ctx())).toBe(false);
	});
});

describe("not", () => {
	it("inverts boolean result", async () => {
		expect(await not(() => true)(ctx())).toBe(false);
		expect(await not(() => false)(ctx())).toBe(true);
	});

	it("inverts async result", async () => {
		expect(await not(async () => true)(ctx())).toBe(false);
	});
});
