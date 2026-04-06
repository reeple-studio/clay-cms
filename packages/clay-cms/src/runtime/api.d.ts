// ? `clay-cms/api` is a thin source-shipped runtime file (api.ts is @ts-nocheck
// ? because it imports virtual modules that only resolve inside the consumer's
// ? Astro/Vite pipeline). This sibling .d.ts is what TS uses for the public
// ? `import cms from "clay-cms/api"` entry — it forwards to the per-project
// ? typed proxy declared by injectTypes (`virtual:clay-cms/api`), so consumers
// ? get full collection autocomplete without ever having to write `virtual:` in
// ? their own code.
import cms from "virtual:clay-cms/api";

export default cms;
