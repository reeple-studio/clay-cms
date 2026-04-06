// ? Tests for auth/password.ts — bcryptjs hash/verify primitives.
// ? Thin wrappers, but they're the foundation of every login. Pin the contract.

import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword", () => {
	it("returns a bcrypt hash, never the plaintext", async () => {
		const hash = await hashPassword("correct horse battery staple");

		expect(hash).not.toBe("correct horse battery staple");

		// ? bcryptjs emits $2a$ / $2b$ / $2y$ prefixed hashes
		expect(hash).toMatch(/^\$2[aby]\$/);
	});

	it("encodes the cost factor (10 rounds) — SALT_ROUNDS canary", async () => {
		const hash = await hashPassword("hunter2");

		expect(hash).toMatch(/^\$2[aby]\$10\$/);
	});

	it("produces a different hash for the same input on each call (salt)", async () => {
		const a = await hashPassword("hunter2");
		const b = await hashPassword("hunter2");

		expect(a).not.toBe(b);
	});

	it("handles unicode and long passwords", async () => {
		const pw = `pässwörd-🔒-${"x".repeat(50)}`;
		const hash = await hashPassword(pw);

		expect(await verifyPassword(pw, hash)).toBe(true);
	});
});

describe("verifyPassword", () => {
	it("returns true for the correct password", async () => {
		const hash = await hashPassword("hunter2");

		expect(await verifyPassword("hunter2", hash)).toBe(true);
	});

	it("returns false for the wrong password", async () => {
		const hash = await hashPassword("hunter2");

		expect(await verifyPassword("hunter3", hash)).toBe(false);
	});

	it("returns false for an empty password against a real hash", async () => {
		const hash = await hashPassword("hunter2");

		expect(await verifyPassword("", hash)).toBe(false);
	});

	it("is case-sensitive", async () => {
		const hash = await hashPassword("Hunter2");

		expect(await verifyPassword("hunter2", hash)).toBe(false);
	});
});
