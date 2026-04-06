// ? Tests for auth/rate-limit.ts — the DB-backed fixed-window limiter that
// ? throttles login/setup. A tiny in-memory fake mimics the drizzle surface used:
// ?   select().from(t).where(eq(t.key, v)).limit(n)
// ?   insert(t).values(row)
// ?   update(t).set(patch).where(eq(t.key, v))
// ? `now` is threaded in explicitly so window math needs no fake timers.

import { describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "./rate-limit.js";

type Row = Record<string, unknown>;

// ? stub drizzle-orm's eq so the fake can round-trip { _colName, _value }
vi.mock("drizzle-orm", () => ({
	eq: (col: { name: string }, value: unknown) => ({
		_colName: col.name,
		_value: value,
	}),
}));

type EqMarker = { _colName: string; _value: unknown };

function makeDb() {
	const rows: Row[] = [];

	function matches(row: Row, w: EqMarker): boolean {
		return row[w._colName] === w._value;
	}

	const db = {
		insert() {
			return {
				values(row: Row) {
					rows.push({ ...row });
					return Promise.resolve();
				},
			};
		},
		select() {
			return {
				from() {
					let filtered = rows.slice();
					const chain = {
						where(w: EqMarker) {
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
		update() {
			return {
				set(patch: Row) {
					return {
						where(w: EqMarker) {
							for (const r of rows) {
								if (matches(r, w)) Object.assign(r, patch);
							}
							return Promise.resolve();
						},
					};
				},
			};
		},
		// ? test accessor
		_rows: rows,
	};

	return db;
}

const table = { key: { name: "key" } };

describe("checkRateLimit", () => {
	it("allows the first attempt and opens a window", async () => {
		const db = makeDb();

		const allowed = await checkRateLimit(
			db,
			table,
			"login:1.2.3.4",
			3,
			1000,
			0,
		);

		expect(allowed).toBe(true);
		expect(db._rows).toHaveLength(1);
		expect(db._rows[0]).toMatchObject({ key: "login:1.2.3.4", count: 1 });
	});

	it("allows up to the limit, then blocks within the window", async () => {
		const db = makeDb();
		const key = "login:ip";

		expect(await checkRateLimit(db, table, key, 3, 1000, 0)).toBe(true);
		expect(await checkRateLimit(db, table, key, 3, 1000, 10)).toBe(true);
		expect(await checkRateLimit(db, table, key, 3, 1000, 20)).toBe(true);
		// ? 4th attempt inside the window → blocked
		expect(await checkRateLimit(db, table, key, 3, 1000, 30)).toBe(false);
		// ? still blocked while the window holds
		expect(await checkRateLimit(db, table, key, 3, 1000, 999)).toBe(false);
	});

	it("resets the counter once the window elapses", async () => {
		const db = makeDb();
		const key = "login:ip";

		expect(await checkRateLimit(db, table, key, 2, 1000, 0)).toBe(true);
		expect(await checkRateLimit(db, table, key, 2, 1000, 10)).toBe(true);
		expect(await checkRateLimit(db, table, key, 2, 1000, 20)).toBe(false);

		// ? now past the window → fresh allowance
		expect(await checkRateLimit(db, table, key, 2, 1000, 1500)).toBe(true);
		expect(db._rows[0]).toMatchObject({
			count: 1,
			windowStart: new Date(1500).toISOString(),
		});
	});

	it("tracks distinct keys independently", async () => {
		const db = makeDb();

		expect(await checkRateLimit(db, table, "login:a", 1, 1000, 0)).toBe(true);
		// ? a different key has its own bucket
		expect(await checkRateLimit(db, table, "login:b", 1, 1000, 0)).toBe(true);
		// ? but the first key is now at its cap
		expect(await checkRateLimit(db, table, "login:a", 1, 1000, 1)).toBe(false);
		expect(db._rows).toHaveLength(2);
	});
});
