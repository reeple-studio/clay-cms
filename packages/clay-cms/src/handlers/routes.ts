import type { HookParameters } from "astro";

const ADMIN_ROUTES = [
	{ pattern: "/admin", entrypoint: "clay-cms/admin/index.astro" },
	{ pattern: "/admin/setup", entrypoint: "clay-cms/admin/setup.astro" },
	{ pattern: "/admin/login", entrypoint: "clay-cms/admin/login.astro" },
	{
		pattern: "/admin/collections/[slug]",
		entrypoint: "clay-cms/admin/collections/[slug].astro",
	},
	{
		pattern: "/admin/collections/[slug]/[id]",
		entrypoint: "clay-cms/admin/collections/[slug]/[id].astro",
	},
];

export function injectAdminRoutes(
	params: HookParameters<"astro:config:setup">,
) {
	for (const route of ADMIN_ROUTES) {
		params.injectRoute(route);
	}
}

export function injectAdminMiddleware(
	params: HookParameters<"astro:config:setup">,
) {
	// ? global session resolver runs first (pre) — sets locals.clayUser/claySession/clayCms on every request
	params.addMiddleware({
		entrypoint: "clay-cms/runtime/session-middleware.ts",
		order: "pre",
	});

	// ? admin dashboard guard runs after — only acts on /admin/* and reads what session middleware set
	params.addMiddleware({
		entrypoint: "clay-cms/admin/middleware.ts",
		order: "post",
	});
}
