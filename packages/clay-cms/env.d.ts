/// <reference types="astro/client" />

declare module "virtual:clay-cms/api" {
	interface AccessOpts {
		user?: Record<string, unknown> | null;
		overrideAccess?: boolean;
	}
	interface CollectionAPI<
		TDoc = Record<string, unknown>,
		TCreate = Record<string, unknown>,
		TUpdate = Record<string, unknown>,
	> {
		find(
			opts?: {
				where?: Record<string, unknown>;
				locale?: string;
				showHiddenFields?: boolean;
			} & AccessOpts,
		): Promise<TDoc[]>;
		findOne(
			opts: {
				id: string;
				locale?: string;
				showHiddenFields?: boolean;
			} & AccessOpts,
		): Promise<TDoc | null>;
		create(
			opts: { data: TCreate; locale?: string } & AccessOpts,
		): Promise<TDoc>;
		update(
			opts: { id: string; data: TUpdate; locale?: string } & AccessOpts,
		): Promise<TDoc>;
		delete(opts: { id: string } & AccessOpts): Promise<void>;
		can(
			op: "read" | "create" | "update" | "delete" | "admin",
			opts?: {
				id?: string;
				doc?: TDoc | null;
				data?: Partial<TCreate>;
			} & AccessOpts,
		): Promise<boolean>;
	}
	export type CMS = Record<string, CollectionAPI> & {
		__tables: () => Record<string, unknown>;
		__db: () => Promise<unknown>;
	};
	const cms: CMS;
	export default cms;
}

declare module "virtual:clay-cms/config" {
	import type {
		AdminConfig,
		LocalizationConfig,
		ResolvedCollectionConfig,
	} from "clay-cms";
	const config: {
		collections: ResolvedCollectionConfig[];
		localization: LocalizationConfig | null;
		admin: AdminConfig;
		initSqlStatements: string[];
	};
	export default config;
}

declare namespace App {
	interface Locals {
		clayUser: Record<string, unknown> | null;
		claySession: import("clay-cms").AuthSession | null;
	}
}
