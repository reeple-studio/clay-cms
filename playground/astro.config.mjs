import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import clay from "clay-cms";

// ? https://astro.build/config
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [clay()],
	vite: {
		plugins: [tailwindcss()],
	},
});
