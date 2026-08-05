# media-infra container patches

`cloudtak-media-1` runs `ghcr.io/dfpc-coe/media-infra:v9.8.0` — a third-party image.
There's no local source checkout for it in this repo, so two bugs found and fixed
here on 2026-08-05 can't be fixed "properly" in source. Instead, `apply-patches.sh`
patches the compiled files inside the container at every startup, before the app
boots, so the fixes survive a container recreation or image re-pull instead of
silently disappearing (which is what happened the first time — they were hand-patched
live into the running container and vanished on the next `docker compose up`).

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
3. Re-derive the patch by hand against the new content — re-apply the same intent
   (query `ephemeral=all`; rewrite RTSP sources pointing at the public media hostname
   to the internal `mediamtx` alias) against whatever the new code actually looks like.
4. Update both `*.orig` (new unpatched snapshot) and `*.patched` (new patched version)
   here together, so they stay a matched pair.
5. Better yet: open a PR against `dfpc-coe/media-infra` with these two fixes, so this
   whole directory can eventually be deleted.
