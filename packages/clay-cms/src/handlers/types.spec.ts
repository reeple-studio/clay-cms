// ? Tests for the TypeGen output (handlers/types.ts).
// ? The generated `.d.ts` string is the user-facing DX contract — if any of these
// ? assertions break, every consumer's `cms.<slug>.find()` autocompletion regresses.

import { describe, expect, it } from "vitest";
import { resolveCollections } from "../collections/resolve.js";
import type { CollectionConfig } from "../collections/types.js";
import { buildTypesContent } from "./types.js";

function build(collections: CollectionConfig[]): string {
	return buildTypesContent(resolveCollections(collections));
}

describe("buildTypesContent — interface naming", () => {
	it("PascalCase singular: posts → Post", () => {
		const out = build([{ slug: "posts", fields: { title: { type: "text" } } }]);

		expect(out).toContain("export interface Post {");
		expect(out).toContain("export type PostCreateInput =");
		expect(out).toContain("export type PostUpdateInput =");
	});

	it("singularizes -ies → -y: categories → Category", () => {
		const out = build([
			{ slug: "categories", fields: { name: { type: "text" } } },
		]);

		expect(out).toContain("export interface Category {");
	});

	it("singularizes -ses → -s: addresses → Address", () => {
		const out = build([
			{ slug: "addresses", fields: { street: { type: "text" } } },
		]);

		expect(out).toContain("export interface Address {");
	});

	it("does not singularize -ss: glass → Glass", () => {
		const out = build([{ slug: "glass", fields: { color: { type: "text" } } }]);

		expect(out).toContain("export interface Glass {");
	});

	it("multi-word kebab slug: blog-posts → BlogPost", () => {
		const out = build([
			{ slug: "blog-posts", fields: { title: { type: "text" } } },
		]);

		expect(out).toContain("export interface BlogPost {");
		expect(out).toContain("blog-posts: CollectionAPI<BlogPost,");
	});
});

describe("buildTypesContent — field type mapping", () => {
	const out = build([
		{
			slug: "things",
			fields: {
				title: { type: "text", required: true },
				subtitle: { type: "text" },
				count: { type: "number", required: true },
				active: { type: "boolean" },
				status: {
					type: "select",
					required: true,
					options: ["draft", "published", "archived"],
				},
				tags: {
					type: "select",
					options: ["a", "b", "c"],
					multiple: true,
				},
				cover: { type: "upload", relationTo: "media" },
			},
		},
	]);

	it("text → string", () => {
		expect(out).toMatch(/title: string;/);
	});

	it("number → number", () => {
		expect(out).toMatch(/count: number;/);
	});

	it("boolean → boolean", () => {
		expect(out).toMatch(/active\?: boolean;/);
	});

	it("select → string-literal union", () => {
		expect(out).toMatch(/status: "draft" \| "published" \| "archived";/);
	});

	it("select multiple → Array<union>", () => {
		expect(out).toMatch(/tags\?: Array<"a" \| "b" \| "c">;/);
	});

	it("upload → string (id reference)", () => {
		expect(out).toMatch(/cover\?: string;/);
	});

	it("required fields are non-optional", () => {
		// ? anchor on whitespace so `title` doesn't match inside `subtitle`
		expect(out).toMatch(/\btitle: string;/);
		expect(out).not.toMatch(/\btitle\?: string;/);
	});

	it("non-required fields are optional", () => {
		expect(out).toMatch(/\bsubtitle\?: string;/);
	});
});

describe("buildTypesContent — system fields", () => {
	it("CreateInput omits id, createdAt, updatedAt", () => {
		const out = build([{ slug: "posts", fields: { title: { type: "text" } } }]);

		// ? all three system field names appear in the Omit<> tuple
		expect(out).toMatch(
			/PostCreateInput = Omit<Post, "id" \| "createdAt" \| "updatedAt">/,
		);
	});

	it("UpdateInput is Partial<CreateInput>", () => {
		const out = build([{ slug: "posts", fields: { title: { type: "text" } } }]);

		expect(out).toContain("PostUpdateInput = Partial<PostCreateInput>");
	});
});

describe("buildTypesContent — CMS interface", () => {
	it("maps each slug to a typed CollectionAPI", () => {
		const out = build([
			{ slug: "posts", fields: { title: { type: "text" } } },
			{ slug: "users", auth: true, fields: { name: { type: "text" } } },
		]);

		expect(out).toMatch(
			/posts: CollectionAPI<Post, PostCreateInput, PostUpdateInput>;/,
		);

		expect(out).toMatch(
			/users: CollectionAPI<User, UserCreateInput, UserUpdateInput>;/,
		);
	});

	it("includes the base virtual module declarations", () => {
		const out = build([{ slug: "posts", fields: { title: { type: "text" } } }]);

		expect(out).toContain('declare module "virtual:clay-cms/api"');
		expect(out).toContain('declare module "virtual:clay-cms/config"');
		expect(out).toContain('declare module "virtual:clay-cms/drizzle"');
		expect(out).toContain('declare module "virtual:clay-cms/init-sql"');
	});

	it("declares App.Locals with clay* namespace", () => {
		const out = build([{ slug: "posts", fields: { title: { type: "text" } } }]);

		expect(out).toContain("clayUser:");
		expect(out).toContain("claySession:");
		// ? clayCms wrapper was removed — consumers thread user explicitly
		expect(out).not.toContain("clayCms:");
	});
});

describe("buildTypesContent — auth collection types", () => {
	it("includes auto-merged email + hashedPassword fields on auth interfaces", () => {
		const out = build([
			{
				slug: "users",
				auth: true,
				fields: { name: { type: "text", required: true } },
			},
		]);

		// ? resolveCollections merges auth fields → they should appear in the User interface
		expect(out).toContain("export interface User {");
		expect(out).toMatch(/email: string;/);
		expect(out).toMatch(/hashedPassword: string;/);
		expect(out).toMatch(/name: string;/);
	});
});
