import type { StorageAdapter, StorageAdapterResult } from "clay-cms";

export interface R2AdapterConfig {
	binding: string;
}

export function r2(config: R2AdapterConfig): StorageAdapterResult {
	return {
		name: "r2",
		init: (): StorageAdapter => {
			let bucket: R2Bucket | undefined;

			async function getBinding(): Promise<R2Bucket> {
				if (bucket) return bucket;
				const { env } = await import("cloudflare:workers");

				bucket = (env as Record<string, unknown>)[config.binding] as R2Bucket;

				if (!bucket) {
					throw new Error(
						`[clay-cms/storage-r2] Binding "${config.binding}" not found. Check your wrangler.jsonc r2_buckets configuration.`,
					);
				}

				return bucket;
			}

			return {
				name: "r2",

				async handleUpload(path, data, contentType) {
					const binding = await getBinding();

					await binding.put(path, data, {
						httpMetadata: { contentType },
					});

					return { url: path };
				},
				async handleDelete(path) {
					const binding = await getBinding();

					await binding.delete(path);
				},
				async staticHandler(path) {
					const binding = await getBinding();

					const object = await binding.get(path);

					if (!object) {
						return new Response("Not Found", { status: 404 });
					}

					return new Response(object.body, {
						headers: {
							"Content-Type":
								object.httpMetadata?.contentType ?? "application/octet-stream",
						},
					});
				},
				generateUrl(path) {
					return `/${path}`;
				},
			};
		},
	};
}
