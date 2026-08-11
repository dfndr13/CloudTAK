# media-infra container patches

`cloudtak-media-1` runs `ghcr.io/dfpc-coe/media-infra:v9.9.0` — a third-party image.
There's no local source checkout for it in this repo, so two bugs found and fixed
here on 2026-08-05 can't be fixed "properly" in source. Instead, `apply-patches.sh`
patches the compiled files inside the container at every startup, before the app
boots, so the fixes survive a container recreation or image re-pull instead of
silently disappearing (which is what happened the first time — they were hand-patched
live into the running container and vanished on the next `docker compose up`).

**Upstream status (2026-08-11):** both fixes were submitted as
[dfpc-coe/media-infra#57](https://github.com/dfpc-coe/media-infra/pull/57). Only the
ephemeral-lease fix was accepted — it's merged to media-infra `main` as of `v9.11.0`.
The hairpin-NAT fix was rejected by the maintainer; see bug #2 below for why it stays
a permanent local patch rather than something upstream will ever absorb. Pinned
`v9.9.0` predates both, so both patches here still apply and are both still needed.

## The two bugs

**1. `persist.js` — ephemeral leases get their MediaMTX path deleted ~10s after creation**

`persist.js`'s `syncPaths()` runs on a 10-second cron and deletes any MediaMTX path
that isn't in CloudTAK's current lease list. It built that list by querying
`GET /api/video/lease` with `ephemeral=false` — so every ephemeral lease (which is
exactly what gets created every time a user opens a CoT-carried video, see
`VideoPlayer.vue`'s `requestUrlStream`) was invisible to the sync and got deleted
within one cron tick of being created. The video would buffer forever because the
path it needed no longer existed by the time anyone tried to read it.

Fix: query `ephemeral=all` instead of `ephemeral=false`, so ephemeral leases are
included/excluded from the list by their own expiration, same as every other lease.

*Upstream: merged as-is in `v9.11.0`. Once the pinned image here is bumped to
`v9.11.0` or later, this half of the patch becomes unnecessary — `apply-patches.sh`
will fail loudly (by design, see below) because the live `persist.js` will already
match `ephemeral=all` and won't byte-match `persist.js.orig`. That failure means
"drop this file from the pair," not "re-derive it."*

**2. `payload.js` — RTSP proxy source uses the public hostname, hairpin-NAT hangs the pull**

When registering a MediaMTX path config, `createPayload()` set `source: path.proxy`
verbatim. For EUD/ATAK-plugin video, `path.proxy` is the *public* ingest hostname
(e.g. `rtsp://video.ksutak.org:8554/...`) — correct for the EUD, since it's off-host
and has to reach the ingest server publicly. But `cloudtak-media-1` pulling that same
URL as its *own* relay source means the container is trying to reach its own host's
public IP — a hairpin-NAT path this environment's networking doesn't support. The pull
just hangs forever (no error, no timeout at the MediaMTX layer), which surfaces in the
browser as an HLS `manifestLoadTimeOut`.

Fix: rewrite the hostname to the docker-internal ingest alias (`mediamtx`) for
same-host RTSP sources before handing the URL to MediaMTX as `source`. Added as a new
`ingestSource()` helper in `payload.js`.

*Upstream: rejected in PR review. `createPayload()` is only ever called from
`syncPaths()`'s 10-second cron, which (a) never runs before CloudTAK's own direct
`POST /path` call at lease-creation time, and (b) even on a later tick, only
diffs/updates a path's `record`/`runOnInit`, never `source` — so this fix could never
correct the real flow inside media-infra. The maintainer's point was that this class
of fix belongs at CloudTAK's actual lease-creation call site instead, which is exactly
where it already lives: `api/stateless/lib/control/video-service.ts`'s own
`ingestSource()`, applied at both `generate()` and `commit()` before CloudTAK's direct
POST/PATCH to MediaMTX.*

*That CloudTAK-side fix does not make this patch redundant, though. It only fires when
CloudTAK itself creates or updates a lease. If `cloudtak-media-1` restarts (container
recreation, image re-pull, MediaMTX crash), MediaMTX's in-memory path config is wiped
and `syncPaths()` is the only code that recreates those paths — straight from
`createPayload()`, straight from `path.proxy` verbatim, unpatched. That reintroduces
the hairpin hang on every restart unless this patch is applied. Upstream declined to
fix `syncPaths()`'s recreate path, so this half of the patch is permanent — it will
never be resolved by an upstream version bump the way the ephemeral fix will.*

Both bugs and the investigation that found them are covered in detail in the chat
history that produced this patch — the summary above is the load-bearing part.

## How `apply-patches.sh` works

Wired in as the `media` service's `entrypoint` in `docker-compose.yml`, with this
directory bind-mounted read-only at `/patches`. On every container start, before
`/start` (the image's real entrypoint) runs:

- If the live file already matches `*.patched` byte-for-byte → already patched,
  no-op. Safe to run on every restart.
- Else if the live file matches `*.orig` byte-for-byte → known original, copy
  `*.patched` over it.
- Else → **fails loudly and refuses to touch the file.** This means the image was
  updated and shipped different code in that file — the patch can no longer be
  trusted to apply correctly and needs human review, not a blind overwrite.

## If this fails after a media-infra version bump

The container will refuse to start (by design — better a visible failure than a
silently wrong patch). To fix:

1. `docker run --rm --entrypoint cat ghcr.io/dfpc-coe/media-infra:<new-version> /dist/lib/persist.js` (and `payload.js`) to get the new version's actual content.
2. Diff it against `persist.js.orig` / `payload.js.orig` here to see what upstream changed.
3. For `persist.js`: if the new version is `v9.11.0` or later, upstream already
   includes the `ephemeral=all` fix — drop `persist.js.orig`/`persist.js.patched` and
   the `persist.js` line from `apply-patches.sh` entirely rather than re-deriving it.
4. For `payload.js`: re-derive the patch by hand against the new content — re-apply
   the same intent (rewrite RTSP sources pointing at the public media hostname to the
   internal `mediamtx` alias) against whatever the new code actually looks like. This
   one won't ever land upstream (see bug #2 above) — treat it as permanent.
5. Update `*.orig` (new unpatched snapshot) and `*.patched` (new patched version) here
   together, so they stay a matched pair.
