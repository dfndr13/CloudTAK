/**
 * Server-managed packs: the CloudTAK operator publishes a pack list (`packs.json`) next to the
 * `.pack` files, and every browser installs, updates and removes datasets to match it — no user
 * ever loads a pack by hand.
 *
 * Pure apart from `fetch` and this plugin's own IndexedDB (no CloudTAK core imports), so it runs
 * under vitest like the rest of lib/storage.
 *
 * Rules:
 * - A pack in the list that this browser doesn't have (or has at a different `version`) is
 *   downloaded. The new copy is written first and the old one removed only afterwards, so search
 *   never goes empty during an update.
 * - A managed dataset whose `id` is no longer in the list is removed.
 * - Datasets loaded by hand (no `managedPackId`) are never touched — except a hand-loaded copy
 *   whose `sourceUrl` is exactly a listed pack's URL (loaded before the list existed): once the
 *   managed copy is in place, that duplicate is removed.
 * - If the list can't be fetched or isn't valid, NOTHING is changed — a server hiccup or an
 *   offline device must never delete data.
 * - A user's on/off choice for a managed dataset is kept across updates.
 */
import { listDatasets, removeDataset } from "./storage/dataset-store.ts";
import { loadFromUrl, type UploadProgress } from "./storage/upload.ts";
import type { DatasetRecord } from "./storage/schema.ts";

export interface ManagedPack {
    /** Stable identifier — the same pack keeps the same id across rebuilds. */
    id: string;
    label: string;
    /** Absolute URL (relative entries in the list are resolved against the list's own URL). */
    url: string;
    /** Changes whenever the file changes (the CLI's `pack-list` command uses its SHA-256). */
    version: string;
    bytes?: number;
}

export interface SyncProgress extends UploadProgress {
    label: string;
    packIndex: number;
    packTotal: number;
}

export type SyncResult =
    | { status: "unavailable"; reason: string }
    | { status: "busy" }
    | { status: "ok"; installed: string[]; removed: string[]; failed: { id: string; error: string }[] };

export interface SyncOptions {
    listUrl: string;
    onProgress?: (progress: SyncProgress) => void;
}

/** Parses and validates a pack list. Throws on anything malformed — callers treat that as
 *  "list unavailable" and change nothing. */
export function parsePackList(raw: unknown, listUrl: string): ManagedPack[] {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { packs?: unknown }).packs)) {
        throw new Error("pack list has no `packs` array");
    }
    const seen = new Set<string>();
    return (raw as { packs: unknown[] }).packs.map((entry, i) => {
        const e = entry as Partial<Record<keyof ManagedPack, unknown>>;
        for (const key of ["id", "label", "url", "version"] as const) {
            if (typeof e[key] !== "string" || !(e[key] as string).trim()) {
                throw new Error(`pack list entry ${i} is missing \`${key}\``);
            }
        }
        const id = (e.id as string).trim();
        if (seen.has(id)) throw new Error(`pack list has duplicate id \`${id}\``);
        seen.add(id);
        return {
            id,
            label: (e.label as string).trim(),
            url: new URL(e.url as string, listUrl).toString(),
            version: (e.version as string).trim(),
            ...(typeof e.bytes === "number" ? { bytes: e.bytes } : {}),
        };
    });
}

/** What a sync would do, given the list and the datasets already in this browser. */
export function planSync(packs: ManagedPack[], datasets: DatasetRecord[]): {
    /** `replaces` = older managed copies (their on/off choice carries over); `adopts` = hand-loaded
     *  copies of the same URL (removed after the install, their on/off choice is not kept, since a
     *  hand-loaded second dataset starts off by default). */
    install: { pack: ManagedPack; replaces: DatasetRecord[]; adopts: DatasetRecord[] }[];
    remove: DatasetRecord[];
} {
    const managed = datasets.filter((d) => d.managedPackId !== undefined);
    const listed = new Set(packs.map((p) => p.id));
    const install: { pack: ManagedPack; replaces: DatasetRecord[]; adopts: DatasetRecord[] }[] = [];
    const remove: DatasetRecord[] = managed.filter((d) => !listed.has(d.managedPackId as string));
    for (const pack of packs) {
        const mine = managed.filter((d) => d.managedPackId === pack.id);
        const handLoaded = datasets.filter((d) => d.managedPackId === undefined && d.sourceUrl === pack.url);
        const keep = mine.find((d) => d.managedVersion === pack.version);
        if (keep) {
            // Already current. Any other copy (an older version, or a duplicate left by an
            // interrupted run) is tidied away.
            remove.push(...mine.filter((d) => d !== keep), ...handLoaded);
        } else {
            install.push({ pack, replaces: mine, adopts: handLoaded });
        }
    }
    return { install, remove };
}

async function fetchPackList(listUrl: string): Promise<ManagedPack[]> {
    const res = await fetch(listUrl, { cache: "no-cache", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // CloudTAK's nginx answers a missing file with the app page (200 text/html) — JSON.parse
    // rejects that, which lands in "unavailable" like any other bad list.
    const text = await res.text();
    return parsePackList(JSON.parse(text), listUrl);
}

async function runSync(opts: SyncOptions): Promise<SyncResult> {
    let packs: ManagedPack[];
    try {
        packs = await fetchPackList(opts.listUrl);
    } catch (err) {
        return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
    }

    const plan = planSync(packs, await listDatasets());
    const installed: string[] = [];
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (let i = 0; i < plan.install.length; i++) {
        const { pack, replaces, adopts } = plan.install[i]!;
        try {
            await loadFromUrl(pack.url, {
                label: pack.label,
                managed: { id: pack.id, version: pack.version },
                // Keep the user's on/off choice across an update; a brand-new pack starts on.
                enabled: replaces.length > 0 ? replaces.some((d) => d.enabled) : true,
                onProgress: (p) =>
                    opts.onProgress?.({ ...p, label: pack.label, packIndex: i + 1, packTotal: plan.install.length }),
            });
            installed.push(pack.id);
        } catch (err) {
            // The old copy (if any) stays in place and keeps working; retried on the next sync.
            failed.push({ id: pack.id, error: err instanceof Error ? err.message : String(err) });
            continue;
        }
        for (const old of [...replaces, ...adopts]) {
            await removeDataset(old.datasetId);
            removed.push(old.datasetId);
        }
    }

    for (const d of plan.remove) {
        await removeDataset(d.datasetId);
        removed.push(d.datasetId);
    }

    return { status: "ok", installed, removed, failed };
}

/**
 * Brings this browser's managed datasets in line with the pack list. Only one sync runs at a
 * time across all of this origin's tabs (Web Locks); a tab that finds one already running gets
 * `{ status: "busy" }` and does nothing.
 */
export async function syncManagedPacks(opts: SyncOptions): Promise<SyncResult> {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks?.request) return runSync(opts);
    return locks.request("addresssearch:managed-sync", { ifAvailable: true }, async (lock) => {
        if (!lock) return { status: "busy" } as const;
        return runSync(opts);
    });
}
