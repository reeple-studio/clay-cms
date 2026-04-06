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

export async function createSession(
	// biome-ignore lint/suspicious/noExplicitAny: drizzle db is dialect-dependent
	db: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table is dialect-dependent
	sessionsTable: any,
	userId: string,
): Promise<AuthSession> {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

	const session: AuthSession = {
		id: crypto.randomUUID(),
		token: generateToken(),
		userId,
		expiresAt: expiresAt.toISOString(),
		createdAt: now.toISOString(),
	};

	await db.insert(sessionsTable).values(session);

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
	const rows = await db
		.select()
		.from(tables._sessions)
		.where(eq(tables._sessions.token, token))
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
	await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
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
	cookies.set(SESSION_COOKIE_NAME, token, {
		path: "/",
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		maxAge: SESSION_DURATION_MS / 1000,
	});
}

export function deleteSessionCookie(cookies: {
	delete: (name: string, options?: Record<string, unknown>) => void;
}): void {
	cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
}

export function getSessionToken(cookies: {
	get: (name: string) => { value: string } | undefined;
}): string | null {
	return cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
