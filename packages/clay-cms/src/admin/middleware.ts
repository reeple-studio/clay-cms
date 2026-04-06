import type { APIContext, MiddlewareNext } from "astro";

import { defineMiddleware } from "astro:middleware";
import cms from "virtual:clay-cms/api";
import config from "virtual:clay-cms/config";

// ? admin dashboard guard — runs after the global session middleware.
// ? session resolution + locals.clayUser/claySession/clayCms are already set by runtime/session-middleware.ts.
// ? this middleware only handles /admin/* gating: setup redirect, login redirect, role check via access.admin.

// ? Hardening headers for every /admin response. CSP locks scripts/styles to
// ? 'self' (the admin ships no inline scripts after the list-row fix; Tailwind's
// ? scoped <style> blocks need 'unsafe-inline' for style-src only). frame-ancestors
// ? 'none' + X-Frame-Options DENY block clickjacking; nosniff + same-origin
// ? Referrer-Policy round it out. (same-origin, NOT no-referrer: no-referrer makes
// ? browsers send `Origin: null` on same-origin form POSTs, which trips Astro's
// ? checkOrigin CSRF guard and 403s the login/setup forms — "Cross-site POST
// ? form submissions are forbidden". same-origin keeps the real Origin on
// ? same-origin requests and still leaks nothing cross-origin.)
// ? New admin features must add their sources here explicitly.
const ADMIN_CSP = [
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
].join("; ");

function applySecurityHeaders(response: Response): Response {
	response.headers.set("Content-Security-Policy", ADMIN_CSP);
	response.headers.set("X-Frame-Options", "DENY");
	response.headers.set("Referrer-Policy", "same-origin");
	response.headers.set("X-Content-Type-Options", "nosniff");
	return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;

	if (!pathname.startsWith("/admin")) {
		return next();
	}

	// ? every /admin response (rendered page, redirect, or 403) gets the headers
	return applySecurityHeaders(await guardAdmin(context, next));
});

async function guardAdmin(
	context: APIContext,
	next: MiddlewareNext,
): Promise<Response> {
	const { pathname } = context.url;
	const authSlug = config.admin.user;
	const clayUser = context.locals.clayUser;

	// ? bootstrap: zero users → setup flow
	// ? explicit bypass — this runs before any user could possibly be authenticated,
	// ? and the auth collection's read default is isLoggedIn which would otherwise deny.
	const authApi = cms[authSlug];
	if (!authApi) {
		throw new Error(`[clay-cms] auth collection "${authSlug}" not found`);
	}
	const users = await authApi.find({ overrideAccess: true });
	const hasUsers = users.length > 0;

	if (pathname === "/admin/setup") {
		if (hasUsers) {
			return clayUser
				? context.redirect("/admin")
				: context.redirect("/admin/login");
		}
		return next();
	}

	if (pathname === "/admin/login") {
		if (!hasUsers) {
			return context.redirect("/admin/setup");
		}
		if (clayUser) {
			return context.redirect("/admin");
		}
		return next();
	}

	// ? all other /admin/* routes
	if (!hasUsers) {
		return context.redirect("/admin/setup");
	}
	if (!clayUser) {
		return context.redirect("/admin/login");
	}

	// ? role check via the auth collection's access.admin function
	const authCollection = config.collections.find((c) => c.slug === authSlug);
	const adminFn = authCollection?.access?.admin;
	if (adminFn) {
		const allowed = await adminFn({
			user: clayUser,
			operation: "admin",
			collection: authSlug,
		});
		if (!allowed) {
			return new Response(null, {
				status: 403,
				statusText: "Forbidden",
			});
		}
	}

	return next();
}
