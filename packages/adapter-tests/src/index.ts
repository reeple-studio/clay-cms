// ? @clay-cms/adapter-tests — reusable conformance suites every Clay adapter
// ? runs against a live instance, so "pick & choose adapters" is provably safe.
export {
	type DbConformanceHarness,
	runDbConformance,
} from "./db-conformance.js";
