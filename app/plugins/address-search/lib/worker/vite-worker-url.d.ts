/**
 * Ambient type for Vite's `?worker&url` import suffix (used by worker-client.ts), so this repo's
 * own tsconfig can typecheck that import without depending on the `vite` package just for its
 * client type declarations — matches the shape Vite's own `vite/client.d.ts` declares.
 */
declare module "*?worker&url" {
    const url: string;
    export default url;
}
