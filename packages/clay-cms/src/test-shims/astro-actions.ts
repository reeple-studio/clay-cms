// ? test-only shim for `astro:actions` so source-shipped runtime files that
// ? import it can be loaded under vitest. Mirrors the surface used by clay-cms:
// ? defineAction (returns a thin wrapper that exposes the handler) and ActionError.

export class ActionError extends Error {
	code: string;

	constructor(input: { code: string; message?: string }) {
		super(input.message ?? input.code);
		this.name = "ActionError";
		this.code = input.code;
	}
}

export function defineAction<TInput, TOutput>(config: {
	accept?: string;
	// biome-ignore lint/suspicious/noExplicitAny: zod schema is dialect-agnostic here
	input?: any;
	handler: (input: TInput, context: unknown) => Promise<TOutput> | TOutput;
}) {
	return {
		...config,
		handler: config.handler,
	};
}
