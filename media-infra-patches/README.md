# media-infra container patches

**PINNED AT `v9.9.0`, NOT `v9.11.0` — see "2026-08-19 regression and downgrade"
below before bumping this again.**

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
a permanent local patch rather than something upstream will ever absorb.

**Verified against `v9.11.0` (2026-08-11):** `persist.js` in that image is
byte-identical to `persist.js.patched` here — upstream's independently-written
`ephemeral=all` fix happens to compile to the exact same output as ours, so
`apply-patches.sh` logs `already patched, nothing to do` for it and leaves it alone.
It's now permanently redundant (upstream ships the fix on its own) but harmless to
leave in place — if a future version ever recompiles that line differently while
still fixing the bug, the wrapper's byte-comparison will fail loudly rather than
silently assume it's still fine, which is a useful tripwire to keep. `payload.js` at
`v9.11.0` is still byte-identical to `payload.js.orig` (unpatched, as expected — see
bug #2), so the hairpin patch applies exactly as before with no re-derivation needed.

**`v9.10.0` HLS/fMP4 change:** that release pins `hlsVariant: fmp4` in the bundled
`mediamtx.yml` (previously left at MediaMTX's default). We don't mount a custom
`mediamtx.yml` in `docker-compose.yml`, so this takes effect as-is. Checked for
breaking impact: our HLS player (`hls.js@^1.6.5` in `VideoPlayer.vue`) supports fMP4
natively — fMP4 is in fact the more broadly-compatible of the two variants (mpegts
only supports H264 video / MPEG-4 audio; fMP4 adds H265, Opus, etc per the v9.10.0
changelog entry). No breaking behavior found for our setup.

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

*Upstream: merged as-is in `v9.11.0`, and — verified by diffing the actual shipped
`v9.11.0` image — upstream's fix compiles byte-identical to `persist.js.patched`
here. So as of `v9.11.0` this half of the patch is redundant (upstream already ships
it) but not broken: `apply-patches.sh` sees the live file already matches `.patched`
and no-ops. Safe to leave in place; only worth pruning for tidiness, not correctness.*

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

## 2026-08-19 regression and downgrade

The bump to `v9.11.0` on 2026-08-11 (see git history) was live for about a
week. During that week, live video playback on at least one real EUD-backed
CoT ("Halton" - phone publishing H264 + mono 44.1kHz AAC over cellular)
degraded from working fine to persistent audio-track stuttering
(`bufferAppendNoProgress` in hls.js, browser MediaSource-level, not visible
in VLC or via ffprobe of the actual segments - both the raw RTSP source and
the muxed HLS segments have perfectly clean, gapless PTS). Extensive
same-night investigation (see [[project-cloudtak-video-open-issues]] for the
full trail) ruled out: the client hls.js config (unchanged for 3+ weeks),
CloudTAK's own error-recovery logic (reproduced identically with zero
CloudTAK code running, an isolated test page), the source itself, and the
muxer's segment-boundary timestamps. Two specific known-upstream-bug
candidates were checked and ruled inapplicable:

- A MediaMTX recorder drift-reset bug (bluenviron/mediamtx#5810, matches our
  exact audio profile and "phone over cellular" scenario) - but the affected
  code (`internal/recorder/format_fmp4_track.go` /
  `format_mpegts_track.go`) only runs when *recording* is enabled. Our
  leases have `recording: false`; this code path isn't reachable for us.
- MediaMTX v1.20.0's HLS changelog entry "recompute PTS of MPEG-TS AAC"
  (bluenviron/gohlslib#379) - also a strong-looking match (AAC-specific,
  landed in the exact version media-infra v9.11.0 pulled in), but the actual
  diff shows the new resync logic (`mpegtsAACPTS` et al) is explicitly
  MPEG-TS-only (`// mpegts only` in the source). We run `hlsVariant: fmp4`
  (media-infra's own v9.10.0 default), so this code path isn't reachable for
  us either. Switching `hlsVariant` to `mpegts` to test made things
  measurably worse ("way worse, stuck") - very plausibly because that
  exercises this brand-new, less battle-tested v1.20.0 code path instead of
  helping.

No single line has been conclusively identified as the cause. What *is*
conclusively established: **downgrading the whole image from `v9.11.0` back
to `v9.9.0` (MediaMTX v1.19.3, pre-dating the fMP4-pin and the AAC-PTS
change) resolved it** - confirmed by the user watching live playback both
before and after the downgrade, same stream, same session, no other
variables changed. This is an empirical result, not a root-caused fix -
treat it as such.

**Consequences of staying on `v9.9.0`:** we lose whatever `v9.10.0`/`v9.11.0`
actually fixed upstream for other cases - notably the `ephemeral=all` lease
sync fix (harmless to lose, our own `persist.js` patch below covers it
regardless) and misc RTSP/RTMP/WebRTC/SRT fixes unrelated to our setup (see
the v1.20.0 MediaMTX changelog for the full list, referenced in this
session's chat history). `*.orig`/`*.patched` here were already originally
derived against `v9.9.0`, so both patches apply exactly as before with no
changes needed - this downgrade required zero changes to this directory.

**Before ever bumping past `v9.9.0` again:** reproduce this exact scenario
(EUD/mobile source, mono low-bitrate AAC audio, real cellular network
jitter, several minutes of continuous playback, browser devtools console
open watching for `bufferAppendNoProgress`) against the new version *before*
rolling it out, not after. A quiet few-minute smoke test at deploy time
would not have caught this - it took a live camera under real network
conditions and sustained watching to surface.

## If this fails after a media-infra version bump

The container will refuse to start (by design — better a visible failure than a
silently wrong patch). To fix:

1. `docker run --rm --entrypoint cat ghcr.io/dfpc-coe/media-infra:<new-version> /dist/lib/persist.js` (and `payload.js`) to get the new version's actual content.
2. Diff it against `persist.js.orig` / `payload.js.orig` here to see what upstream changed.
3. For `persist.js`: if the new version is `v9.11.0` or later, upstream already
   includes the `ephemeral=all` fix. Check whether the live file still matches
   `persist.js.patched` (it did as of `v9.11.0`) — if so, no action needed, the
   wrapper no-ops on it. Only if a future version changes that file's compiled output
   again (and `apply-patches.sh` starts failing loudly on it) does it need attention:
   at that point just drop `persist.js.orig`/`persist.js.patched` and the `persist.js`
   line from `apply-patches.sh`, since upstream owns this fix now.
4. For `payload.js`: re-derive the patch by hand against the new content — re-apply
   the same intent (rewrite RTSP sources pointing at the public media hostname to the
   internal `mediamtx` alias) against whatever the new code actually looks like. This
   one won't ever land upstream (see bug #2 above) — treat it as permanent.
5. Update `*.orig` (new unpatched snapshot) and `*.patched` (new patched version) here
   together, so they stay a matched pair.
