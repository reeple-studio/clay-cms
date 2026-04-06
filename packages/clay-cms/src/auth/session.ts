import { eq } from "drizzle-orm";

import {
	type AuthSession,
	SESSION_COOKIE_NAME,
	SESSION_DURATION_MS,
} from "./types.js";

function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ? Tokens are stored hashed, never in plaintext: a DB read (SQL leak, backup
// ? exfil, misconfigured backup-to-R2) then exposes only SHA-256 digests, not
// ? live session tokens. SHA-256 (not bcrypt) because lookups must stay fast and
// ? the token already carries 256 bits of entropy — there's nothing to brute.
// ? The cookie keeps the plaintext token, so the client is unchanged.
async function hashToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ? In production we use the __Host- cookie prefix — the browser enforces
// ? Secure + Path=/ + no Domain, both of which we already set, for free CSRF/
// ? subdomain-fixation hardening. In dev (HTTP localhost) the prefix and the
// ? Secure flag would make the browser silently drop the cookie, so we fall
// ? back to the bare name. The name is computed the same way everywhere it's
// ? read or written, so the two environments never cross wires.
function isProd(): boolean {
	return import.meta.env?.PROD === true;
}

function sessionCookieName(): string {
	return isProd() ? `__Host-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME;
}

export async function createSession(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-dependent
	sessionsTable: any,
	userId: string,
): Promise<AuthSession> {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

	const id = crypto.randomUUID();
	const token = generateToken();
	const tokenHash = await hashToken(token);

	// ? store the hash; the row never holds the plaintext token
	await db.insert(sessionsTable).values({
		id,
		token: tokenHash,
		userId,
		expiresAt: expiresAt.toISOString(),
		createdAt: now.toISOString(),
	});

	// ? return the plaintext token for the cookie — this is the only place it exists
	const session: AuthSession = {
		id,
		token,
		userId,
		expiresAt: expiresAt.toISOString(),
		createdAt: now.toISOString(),
	};

	return session;
}

export async function validateSession(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle tables are dialect-dependent
	tables: { _sessions: any; [key: string]: any },
	token: string,
	authCollectionSlug: string,
): Promise<{ user: Record<string, unknown>; session: AuthSession } | null> {
	// ? look up by the hash of the cookie value — rows store hashes, not plaintext
	const tokenHash = await hashToken(token);

	const rows = await db
		.select()
		.from(tables._sessions)
		.where(eq(tables._sessions.token, tokenHash))
		.limit(1);

	if (rows.length === 0) return null;

	const session = rows[0] as AuthSession;

	// ? check expiry
	if (new Date(session.expiresAt) <= new Date()) {
		// ? clean up expired session
		await db
			.delete(tables._sessions)
			.where(eq(tables._sessions.id, session.id));

		return null;
	}

	// ? fetch user from auth collection
	const authTable = tables[authCollectionSlug];
	if (!authTable) return null;

	const userRows = await db
		.select()
		.from(authTable)
		.where(eq(authTable.id, session.userId))
		.limit(1);

	if (userRows.length === 0) return null;

	return { user: userRows[0] as Record<string, unknown>, session };
}

export async function deleteSession(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-dependent
	sessionsTable: any,
	token: string,
): Promise<void> {
	// ? rows are keyed by hash; hash the plaintext cookie value before deleting
	const tokenHash = await hashToken(token);
	await db.delete(sessionsTable).where(eq(sessionsTable.token, tokenHash));
}

export function setSessionCookie(
	cookies: {
		set: (
			name: string,
			value: string,
			options?: Record<string, unknown>,
		) => void;
	},
	token: string,
): void {
	// ? secure is conditional on PROD: unconditional `secure: true` makes the
	// ? browser silently drop the cookie over HTTP localhost during dev.
	cookies.set(sessionCookieName(), token, {
		path: "/",
		httpOnly: true,
		secure: isProd(),
		sameSite: "lax",
		maxAge: SESSION_DURATION_MS / 1000,
	});
}

export function deleteSessionCookie(cookies: {
	delete: (name: string, options?: Record<string, unknown>) => void;
}): void {
	// ? mirror the set path's `secure`: in prod the cookie carries the `__Host-`
	// ? prefix, and a browser REJECTS any Set-Cookie with that prefix that lacks
	// ? Secure — including this deletion — leaving the cookie stuck client-side.
	cookies.delete(sessionCookieName(), { path: "/", secure: isProd() });
}

export function getSessionToken(cookies: {
	get: (name: string) => { value: string } | undefined;
}): string | null {
	return cookies.get(sessionCookieName())?.value ?? null;
}
