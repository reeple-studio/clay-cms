export interface AuthSession {
	id: string;
	token: string;
	userId: string;
	expiresAt: string;
	createdAt: string;
}

export const SESSION_COOKIE_NAME = "clay-cms.session";
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // ? 30 days
