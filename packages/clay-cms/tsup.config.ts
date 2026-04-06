import { defineConfig } from "tsup";
import { peerDependencies } from "./package.json";

export default defineConfig((options) => {
	const dev = !!options.watch;
	return {
		entry: [
			"src/**/*.(ts|js)",
			"!src/**/*.spec.ts",
			"!src/actions.ts",
			"!src/auth/**/*",
			"!src/admin/**/*",
			"!src/runtime/**/*",
		],
		format: ["esm"],
		target: "node18",
		bundle: true,
		dts: true,
		sourcemap: true,
		clean: !dev,
		splitting: false,
		minify: !dev,
		external: [...Object.keys(peerDependencies)],
		tsconfig: "tsconfig.json",
	};
});
