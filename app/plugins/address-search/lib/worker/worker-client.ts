/**
 * Main-thread wrapper around the search Worker. UI components only ever talk to this class —
 * never to the Worker or to lib/search/lib/storage directly — so the Worker boundary stays in
 * one place.
 *
 * The worker URL is imported via Vite's `?worker&url` suffix (see ./vite-worker-url.d.ts for the
 * ambient type), matching CloudTAK core's own `atlas.ts` pattern exactly
 * (`import AtlasWorker from '../workers/atlas.ts?worker&url'`) — NOT a runtime
 * `new URL('./search-worker.ts', import.meta.url)`. That runtime form was tried first and broke
 * in the local symlinked-plugin dev loop: Vite's dev server only relaxes its filesystem-access
 * check for paths discovered through its own module-resolution pipeline (which is how every
 * other import in this plugin correctly reaches outside api/web/), and a URL computed at runtime
 * in the browser never goes through that pipeline — it hit Vite's raw `fs.allow` check directly
 * and was rejected as "outside of Vite serving allow list." The static `?worker&url` import
 * resolves at build/serve time through the normal pipeline instead, exactly like every other
 * file in this plugin already does.
 */
import SearchWorkerUrl from "./search-worker.ts?worker&url";
import type { GeoPoint, SearchOptions, SearchResult } from "../search/types.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

export class SearchWorkerClient {
    private readonly worker: Worker;
    private readonly pending = new Map<number, PendingRequest>();
    private nextId = 1;

    constructor() {
        this.worker = new Worker(SearchWorkerUrl, { type: "module" });
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
        // A bad worker URL, or a runtime error inside search-worker.ts, fails ASYNCHRONOUSLY here
        // — it does not throw from the constructor above, so without this handler it can fail
        // silently from the caller's point of view.
        this.worker.onerror = (event: ErrorEvent) => {
            console.error("[address-search] worker error", event.message, event.filename, event.lineno, event);
        };
    }

    private handleMessage(response: WorkerResponse): void {
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error));
    }

    private call(method: string, args: unknown[]): Promise<unknown> {
        const id = this.nextId++;
        const request: WorkerRequest = { id, method, args };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage(request);
        });
    }

    async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
        return (await this.call("search", [query, opts])) as SearchResult[];
    }

    /** PLAN.md §4.2 — the nearest address to a clicked map point, or `undefined` if nothing is
     *  within range across every enabled dataset. */
    async reverseLookup(point: GeoPoint): Promise<SearchResult | undefined> {
        return (await this.call("reverseLookup", [point])) as SearchResult | undefined;
    }

    /** Forces an immediate reload of enabled datasets, rather than waiting for the next search. */
    async refresh(): Promise<void> {
        await this.call("refresh", []);
    }

    terminate(): void {
        this.worker.terminate();
        for (const pending of this.pending.values()) {
            pending.reject(new Error("worker terminated"));
        }
        this.pending.clear();
    }
}
