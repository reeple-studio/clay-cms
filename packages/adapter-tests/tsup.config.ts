import { defineConfig } from "tsup";

import { dependencies, peerDependencies } from "./package.json";

export default defineConfig((options) => {
	const dev = !!options.watch;
	return {
		// ? only ship the reusable suite factory — *.spec.ts stay out of the build
		entry: ["src/index.ts"],
		format: ["esm"],
		target: "node18",
		bundle: true,
		dts: true,
		sourcemap: true,
		clean: !dev,
		splitting: false,
		minify: !dev,
		external: [...Object.keys(peerDependencies), ...Object.keys(dependencies)],
		tsconfig: "tsconfig.json",
	};
});
