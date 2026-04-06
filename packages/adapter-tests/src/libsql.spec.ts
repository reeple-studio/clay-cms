// ? Runs the shared DB conformance suite against a LIVE in-memory libSQL instance
// ? (the real @libsql/client driver, in-process). libSQL supports interactive
// ? transactions, so the transaction section runs in full.

import { libsql } from "@clay-cms/db-libsql";

import { runDbConformance } from "./db-conformance.js";

runDbConformance({
	name: "libsql",
	supportsTransactions: true,
	makeAdapter: () => libsql({ url: ":memory:" }),
});
