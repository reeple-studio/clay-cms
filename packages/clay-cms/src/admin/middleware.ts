import { defineMiddleware } from "astro:middleware";
import cms from "virtual:clay-cms/api";
import config from "virtual:clay-cms/config";

// ? admin dashboard guard — runs after the global session middleware.
// ? session resolution + locals.clayUser/claySession/clayCms are already set by runtime/session-middleware.ts.
// ? this middleware only handles /admin/* gating: setup redirect, login redirect, role check via access.admin.

export const onRequest = defineMiddleware(async (context, next) => {
	const { pathname } = context.url;

	if (!pathname.startsWith("/admin")) {
		return next();
	}

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
});
