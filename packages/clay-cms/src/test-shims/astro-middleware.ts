// ? test-only shim for `astro:middleware` so source-shipped runtime files
// ? that import it can be loaded under vitest. Mirrors the surface used
// ? by clay-cms (only `defineMiddleware` today).

export function defineMiddleware<T extends (...args: never[]) => unknown>(
	fn: T,
): T {
	return fn;
}
