/**
 * Plain object rather than `defineConfig` from 'vitest/config' on purpose.
 *
 * Importing vitest's types here drags this plugin's vitest version into any
 * TypeScript program that includes the file. If the plugin is present as a
 * real directory under api/web/plugins, that conflicts with CloudTAK's own
 * vitest version and breaks `vue-tsc` on api/web/vite.config.ts.
 *
 * `setupFiles` is the package path as a string so vue-tsc never has to
 * resolve `fake-indexeddb` (a plugin-only test dep, not in api/web).
 */
export default {
    test: {
        include: ["test/**/*.spec.ts"],
        environment: "node",
        setupFiles: ["fake-indexeddb/auto"],
    },
};
