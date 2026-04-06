import type {
	BooleanField,
	NumberField,
	SelectField,
	TextField,
	UploadField,
} from "./types.js";

export const fields = {
	text: (opts?: Omit<TextField, "type">): TextField => ({
		type: "text",
		...opts,
	}),
	number: (opts?: Omit<NumberField, "type">): NumberField => ({
		type: "number",
		...opts,
	}),
	boolean: (opts?: Omit<BooleanField, "type">): BooleanField => ({
		type: "boolean",
		...opts,
	}),
	select: (opts: Omit<SelectField, "type">): SelectField => ({
		type: "select",
		...opts,
	}),
	upload: (opts: Omit<UploadField, "type">): UploadField => ({
		type: "upload",
		...opts,
	}),
};
