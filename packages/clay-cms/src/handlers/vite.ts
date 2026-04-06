import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import type { HookParameters } from "astro";

// ? tailwind v4 + workaround for workerd not following pnpm symlinks.
// ? both tweaks are unrelated to the rest of setup, so they live alone.
export function setupVite(
	params: HookParameters<"astro:config:setup"> & {
		hasVitePlugin: (name: string) => boolean;
	},
) {
	const { updateConfig, hasVitePlugin } = params;

	// ? tailwind v4 — only register if user hasn’t already.
	if (!hasVitePlugin("@tailwindcss/vite")) {
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
