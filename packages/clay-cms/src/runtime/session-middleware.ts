// @ts-nocheck — shipped as source, type-checked in the consumer's Vite/Astro pipeline.
// ? global session middleware — runs on every request, regardless of route.
// ? resolves the session cookie into locals.clayUser / locals.claySession.
// ? this middleware never redirects. dashboard gating lives in admin/middleware.ts.
// ? consumers thread the user explicitly: cms.foo.find({ user: Astro.locals.clayUser }).

import { defineMiddleware } from "astro:middleware";
import cms from "virtual:clay-cms/api";
import config from "virtual:clay-cms/config";
import ensureTables from "virtual:clay-cms/init-sql";
import {
	deleteSessionCookie,
	getSessionToken,
	validateSession,
} from "clay-cms/auth";

export const onRequest = defineMiddleware(async (context, next) => {
	// ? ensure tables exist on first request — cheap no-op after that
	await ensureTables();

	const authSlug = config.admin.user;
	const token = getSessionToken(context.cookies);

	let user = null;
	let session = null;

	if (token) {
		const db = await cms.__db();
		const tables = cms.__tables();

		const result = await validateSession(db, tables, token, authSlug);

		if (result) {
			user = result.user;
			session = result.session;
		} else {
			// ? cookie present but invalid/expired — clean it up
			deleteSessionCookie(context.cookies);
		}
	}

	context.locals.clayUser = user;
	context.locals.claySession = session;

	return next();
});
