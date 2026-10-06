// Puts zod in its no-eval mode before any bundle loads. Content modules
// validate their tables while they load, and under the page's
// Content-Security-Policy (no 'unsafe-eval') zod's Function probe would be
// blocked and reported as a violation on every load. A classic script runs
// before the deferred module bundles, which an import cannot guarantee once
// the bundler hoists shared chunks.
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
