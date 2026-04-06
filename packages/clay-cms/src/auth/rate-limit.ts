// ? Fixed-window rate limiter backed by a `_rate_limits` row per key. There's no
// ? rate-limit primitive in D1, so we keep state in the DB — portable across every
// ? adapter, on-brand with Clay's runtime-agnostic core. Best-effort by design: the
// ? read-modify-write tolerates the rare concurrent-increment race (rate limiting
// ? doesn't need exactness — an attacker getting one extra attempt past the window
// ? boundary changes nothing). Returns true when the action is allowed.

import { eq } from "drizzle-orm";

interface RateLimitRow {
	key: string;
	count: number;
	windowStart: string;
}

export async function checkRateLimit(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-dependent
	table: any,
	key: string,
	limit: number,
	windowMs: number,
	now: number = Date.now(),
): Promise<boolean> {
	const rows = (await db
		.select()
		.from(table)
		.where(eq(table.key, key))
		.limit(1)) as RateLimitRow[];

	const existing = rows[0];

	// ? first attempt for this key → open a window
	if (!existing) {
		await db.insert(table).values({
			key,
			count: 1,
			windowStart: new Date(now).toISOString(),
		});
		return true;
	}

	const windowStart = new Date(existing.windowStart).getTime();

	// ? window elapsed → reset the counter
	if (now - windowStart > windowMs) {
		await db
			.update(table)
			.set({ count: 1, windowStart: new Date(now).toISOString() })
			.where(eq(table.key, key));
		return true;
	}

	// ? within the window and at/over the cap → block
	if (existing.count >= limit) {
		return false;
	}

	await db
		.update(table)
		.set({ count: existing.count + 1 })
		.where(eq(table.key, key));
	return true;
}

// ? Clear a key's window — call after a SUCCESSFUL attempt so successes don't
// ? consume the brute-force budget (a shared-NAT office IP logging in 5×/15min
// ? shouldn't lock itself out) and the row doesn't linger unbounded. Best-effort.
export async function clearRateLimit(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-dependent
	table: any,
	key: string,
): Promise<void> {
	await db.delete(table).where(eq(table.key, key));
}
