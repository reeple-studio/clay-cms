import { describe, expect, it } from "vitest";
import { andWhere, matchesWhere, orWhere, type Where } from "./where.js";

describe("matchesWhere — north star (storefront 'my orders')", () => {
	// ? the design rule from the roadmap: this exact shape must round-trip.
	const where: Where = { customer: { equals: "user-123" } };

	it("matches an order owned by the user", () => {
		expect(
			matchesWhere(where, { id: "o1", customer: "user-123", total: 50 }),
		).toBe(true);
	});

	it("rejects an order owned by another user", () => {
		expect(
			matchesWhere(where, { id: "o2", customer: "user-999", total: 50 }),
		).toBe(false);
	});
});

describe("matchesWhere — empty / nullish", () => {
	it("undefined where matches everything", () => {
		expect(matchesWhere(undefined, { x: 1 })).toBe(true);
	});

	it("empty where matches everything", () => {
		expect(matchesWhere({}, { x: 1 })).toBe(true);
	});

	it("null doc never matches a non-empty where", () => {
		expect(matchesWhere({ x: { equals: 1 } }, null)).toBe(false);
	});
});

describe("matchesWhere — operators", () => {
	const doc = {
		title: "Hello World",
		count: 5,
		tags: ["a", "b", "c"],
		deleted: null,
	};

	it("equals / not_equals", () => {
		expect(matchesWhere({ count: { equals: 5 } }, doc)).toBe(true);
		expect(matchesWhere({ count: { equals: 4 } }, doc)).toBe(false);
		expect(matchesWhere({ count: { not_equals: 4 } }, doc)).toBe(true);
	});

	it("in / not_in", () => {
		expect(matchesWhere({ count: { in: [1, 5, 9] } }, doc)).toBe(true);
		expect(matchesWhere({ count: { in: [1, 2] } }, doc)).toBe(false);
		expect(matchesWhere({ count: { not_in: [1, 2] } }, doc)).toBe(true);
	});

	it("exists", () => {
		expect(matchesWhere({ deleted: { exists: false } }, doc)).toBe(true);
		expect(matchesWhere({ deleted: { exists: true } }, doc)).toBe(false);
		expect(matchesWhere({ count: { exists: true } }, doc)).toBe(true);
	});

	it("greater_than / less_than (and _equal)", () => {
		expect(matchesWhere({ count: { greater_than: 4 } }, doc)).toBe(true);
		expect(matchesWhere({ count: { greater_than: 5 } }, doc)).toBe(false);
		expect(matchesWhere({ count: { greater_than_equal: 5 } }, doc)).toBe(true);
		expect(matchesWhere({ count: { less_than: 6 } }, doc)).toBe(true);
		expect(matchesWhere({ count: { less_than_equal: 5 } }, doc)).toBe(true);
	});

	it("like — case-insensitive substring (Payload semantics)", () => {
		expect(matchesWhere({ title: { like: "hello" } }, doc)).toBe(true);
		expect(matchesWhere({ title: { like: "HELLO" } }, doc)).toBe(true);
		expect(matchesWhere({ title: { like: "world" } }, doc)).toBe(true);
		expect(matchesWhere({ title: { like: "nope" } }, doc)).toBe(false);
	});

	it("contains — array field includes value", () => {
		expect(matchesWhere({ tags: { contains: "b" } }, doc)).toBe(true);
		expect(matchesWhere({ tags: { contains: "z" } }, doc)).toBe(false);
	});
});

describe("matchesWhere — and / or", () => {
	const doc = { status: "published", author: "u1", views: 100 };

	it("and: all sub-clauses must match", () => {
		const w: Where = {
			and: [
				{ status: { equals: "published" } },
				{ views: { greater_than: 50 } },
			],
		};

		expect(matchesWhere(w, doc)).toBe(true);
		expect(matchesWhere(w, { ...doc, views: 10 })).toBe(false);
	});

	it("or: any sub-clause may match", () => {
		const w: Where = {
			or: [{ author: { equals: "u1" } }, { author: { equals: "u2" } }],
		};

		expect(matchesWhere(w, doc)).toBe(true);
		expect(matchesWhere(w, { ...doc, author: "u3" })).toBe(false);
	});

	it("nested and/or — admin OR (own doc)", () => {
		// ? the helper combinator pattern: or(isAdmin, ownDocuments("author"))
		const w: Where = {
			or: [{ role: { equals: "admin" } }, { author: { equals: "u1" } }],
		};

		expect(matchesWhere(w, { role: "admin", author: "other" })).toBe(true);
		expect(matchesWhere(w, { role: "user", author: "u1" })).toBe(true);
		expect(matchesWhere(w, { role: "user", author: "other" })).toBe(false);
	});

	it("multiple top-level fields are AND-ed implicitly", () => {
		const w: Where = {
			status: { equals: "published" },
			author: { equals: "u1" },
		};

		expect(matchesWhere(w, doc)).toBe(true);
		expect(matchesWhere(w, { ...doc, author: "u2" })).toBe(false);
	});
});

describe("andWhere / orWhere", () => {
	const a: Where = { status: { equals: "published" } };
	const b: Where = { author: { equals: "u1" } };

	it("andWhere with one undefined returns the other", () => {
		expect(andWhere(a, undefined)).toBe(a);
		expect(andWhere(undefined, b)).toBe(b);
		expect(andWhere(undefined, undefined)).toBeUndefined();
	});

	it("andWhere wraps both into { and: [...] }", () => {
		expect(andWhere(a, b)).toEqual({ and: [a, b] });
	});

	it("orWhere wraps both into { or: [...] }", () => {
		expect(orWhere(a, b)).toEqual({ or: [a, b] });
	});

	it("merged Wheres still evaluate correctly", () => {
		const merged = andWhere(a, b);

		if (!merged) throw new Error("expected merged where");

		expect(matchesWhere(merged, { status: "published", author: "u1" })).toBe(
			true,
		);

		expect(matchesWhere(merged, { status: "published", author: "u2" })).toBe(
			false,
		);
	});
});
