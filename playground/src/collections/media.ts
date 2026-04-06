import { type CollectionConfig, fields } from "clay-cms/config";

export const media: CollectionConfig = {
	slug: "media",
	upload: true,
	fields: {
		alt: fields.text({ localized: true }),
	},
};
