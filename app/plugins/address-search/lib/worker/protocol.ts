/**
 * Hand-rolled request/response RPC over `postMessage`, instead of Comlink. Investigation found
 * Vite's worker sub-build (in ~/CloudTAK/api/web/vite.config.ts) doesn't inherit the custom
 * plugin that lets a symlinked plugin bare-import things, so `import * as Comlink from 'comlink'`
 * inside the worker file would likely fail to resolve in the local dev loop — and decision #14
 * forbids fixing that by editing CloudTAK's vite config. This protocol has zero imports, so the
 * question never comes up.
 */

export interface WorkerRequest {
    id: number;
    method: string;
    args: unknown[];
}

export type WorkerResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string };
