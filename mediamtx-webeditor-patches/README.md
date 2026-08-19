# mediamtx-webeditor patches

`/opt/mediamtx-webeditor` is a self-updating third-party app (LDAP/Authentik
overlay build, GitHub-releases auto-update built into `mediamtx_config_editor.py`
itself - see `get_update_channel()` / `applyUpdate()`) with no local source
checkout in this repo. Two bugs found and hand-fixed on **2026-08-17** can't be
fixed "properly" in source, so `apply-patches.sh` re-patches the installed files
at every service start, before the app boots - the same pattern
`media-infra-patches/apply-patches.sh` uses for `cloudtak-media-1` (see that
directory's README for the original incident this pattern comes from: a manual
live patch to `persist.js`/`payload.js` got silently wiped by the next container
update, because it was never captured anywhere the entrypoint would reapply it).

The two files patched here were edited directly on disk tonight (as root, since
both are owned by `takwerx:takwerx` mode 644) and were **not** protected by
`start_webeditor.sh`'s existing sed-based patch block, which only touches
`mediamtx_config_editor.py` and only for a fixed set of env/port substitutions
unrelated to either fix below. Nothing previously reapplied either change, so
the web editor's built-in auto-updater would have silently overwritten both the
next time it pulled a new release.

**Wired in:** `start_webeditor.sh` calls `apply-patches.sh` after its own sed
block and before `apply_ldap_overlay` / launching `python3`.

## The two bugs

**1. `mediamtx_config_editor.py` - `is_hls_localhost_bound()` misreports under the LDAP overlay**

Under the LDAP/Authentik overlay, MediaMTX runs in a bridge-networked Docker
container: `hlsAddress` has to stay unbound (`:8888`) for Docker's own port
publishing to work at all, so the YAML can never literally say `127.0.0.1` the
way a bare-metal install would. `is_hls_localhost_bound()` checked the YAML
value directly, so under this overlay it always reported `False` - even though
port 8888 is still never reachable from outside the host (only the
docker-mapped internal port is, solely through `/hls-proxy/`). The practical
effect: HLS URLs were built without the `/hls-proxy/` prefix, i.e. as if port
8888 were directly reachable, which it isn't in this setup.

Fix: short-circuit to `True` whenever `LDAP_OVERLAY_ACTIVE`, since infra-TAK
mode is unconditionally localhost-bound in the sense this function means -
checking the YAML would just misreport it.

**2. `mediamtx_ldap_overlay.py` - injected `window.watchStream` clobbers the editor's own JS**

The LDAP overlay injects a block of JS into the served page. One injected line
redefined `window.watchStream` as a bare `window.open("/watch/"+id)` helper,
which collided with (overwrote) the config editor's own `watchStream` handler
already defined in the base page - breaking in-page stream watching under the
overlay.

Fix: drop the injected `window.watchStream` line entirely; the base page's own
handler is sufficient with the overlay active.

## How `apply-patches.sh` works

Called from `start_webeditor.sh` on every service start (`systemd` unit runs as
`root`, `Restart=always`, so this also covers crash restarts, not just deploys):

- If the live file already matches `*.patched` byte-for-byte -> already patched,
  no-op.
- If the live file still matches the known `*.orig` snapshot -> copy `*.patched`
  over it.
- If it matches neither -> **FAILS LOUDLY** (does not guess/force) - this means
  a web-editor auto-update shipped different code in that region and the patch
  needs to be re-derived by hand against the new version before it's safe to
  reapply automatically.

## If this fails after a web-editor version bump

1. Check what changed: `diff mediamtx_config_editor.py.orig
   /opt/mediamtx-webeditor/mediamtx_config_editor.py` (same for the overlay
   file) to see the new upstream code around the patched region.
2. Re-derive the fix against the new code by hand.
3. Replace this directory's `*.orig` with the new upstream file, and
   `*.patched` with the new upstream file plus the re-derived fix applied.
4. Restart the service to confirm `apply-patches.sh` now no-ops cleanly.

## Incident: this actually happened (2026-08-18)

The web editor self-updated (`CURRENT_VERSION` `v2.1.3` -> `v2.1.4`) sometime
between 2026-08-17 17:57 and 2026-08-18 20:25, which shipped different code
around `is_hls_localhost_bound()` - byte comparison against the old `*.orig`/
`*.patched` snapshots correctly stopped matching, and `apply-patches.sh`
FATAL'd exactly as designed, on every restart from 20:25 onward (4 restarts).

**But it kept running unpatched anyway.** `start_webeditor.sh` has no `set -e`
and never checks `apply-patches.sh`'s exit code (its final call, no `|| exit 1`
guard) - so the FATAL printed to the log, and the wrapper's very next line
unconditionally echoed `"Patches applied. Starting web editor..."` and
launched the app regardless. The safety net detected the problem correctly;
nothing was listening to it. Fixed by adding `set -e` to the top of
`start_webeditor.sh`.

Symptom this produced: the web editor's "Watch" button opened a popup that
spun forever with no error - `is_hls_localhost_bound()` had reverted to
checking the raw YAML `hlsAddress` value (`:8888`, not literally
`127.0.0.1`), so HLS URLs were built as direct `https://host:8888/...` links
instead of `/hls-proxy/...`, and that direct port isn't actually reachable in
this bridge-networked setup - exactly bug #1 above, recurring.

`*.orig`/`*.patched` in this directory were regenerated from the live
`v2.1.4` file on 2026-08-18 to restore a clean baseline that `apply-patches.sh`
can byte-match against going forward.
