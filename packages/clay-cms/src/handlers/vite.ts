import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import type { HookParameters } from "astro";

// ? tailwind v4 + workaround for workerd not following pnpm symlinks.
// ? both tweaks are unrelated to the rest of setup, so they live alone.
export function setupVite(params: HookParameters<"astro:config:setup">) {
	const { config, updateConfig } = params;

	// ? tailwind v4 — only register if the user hasn’t already. astro-integration-kit
	// ? used to inject a hasVitePlugin helper; inline the same name-string check.
	// ? at config:setup, config only reflects user + earlier-ordered integration plugins
	// ? (same scope the kit had) — the playground registers tailwind itself, so this dedupes.
	// ? cast to unknown[] before flattening: vite's PluginOption nests arrays recursively,
	// ? and FlatArray over it blows up TS instantiation depth (TS2589).
	const plugins = ((config.vite?.plugins ?? []) as unknown[]).flat(
		Number.POSITIVE_INFINITY,
	);
	const hasTailwind = plugins.some(
		(p) =>
			typeof p === "object" &&
			p !== null &&
			"name" in p &&
			(p as { name?: unknown }).name === "@tailwindcss/vite",
	);

	if (!hasTailwind) {
		updateConfig({
			vite: { plugins: [tailwindcss()] },
		});
	}

	// ? resolve @clay-cms/drizzle to its filesystem path. workerd can’t follow pnpm symlinks, but Vite can bundle a resolved file path.
	const drizzlePkgPath = fileURLToPath(
		import.meta.resolve("@clay-cms/drizzle"),
	);

	updateConfig({
		vite: {
			resolve: {
				alias: {
					"@clay-cms/drizzle": drizzlePkgPath,
				},
			},
		},
	});
}
