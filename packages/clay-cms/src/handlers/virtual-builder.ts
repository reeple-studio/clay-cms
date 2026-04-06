// ? tiny factory for assembling virtual module imports.
// ? replaces inline `export default ${JSON.stringify(...)}` template strings scattered across the integration with named, intent-revealing helpers.

export type VirtualImports = Record<string, string>;

export type VirtualBuilder = {
	json: (name: string, value: unknown) => void; // ? inline a JSON-serializable value as the default export.
	reexport: (name: string, sourcePath: string) => void; // ? re-export the default export from a real source file (preserves Vite bundling).
	raw: (name: string, code: string) => void; // ? use raw module code (e.g. adapter-provided drizzle module).
	build: () => VirtualImports;
};

export function createVirtualBuilder(): VirtualBuilder {
	const entries: VirtualImports = {};

	return {
		json(name, value) {
			// ? JSON.stringify(undefined) returns undefined; emit a literal `undefined` in that case so the runtime `if (val)` checks still work.
			const serialized = JSON.stringify(value) ?? "undefined";
			entries[name] = `export default ${serialized};`;
		},
		reexport(name, sourcePath) {
			entries[name] = `export { default } from ${JSON.stringify(sourcePath)};`;
		},
		raw(name, code) {
			entries[name] = code;
		},
		build() {
			return entries;
		},
	};
}
