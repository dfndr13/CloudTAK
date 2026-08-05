#!/bin/sh
#
# media-infra-patches/apply-patches.sh
#
# ghcr.io/dfpc-coe/media-infra is a third-party image (no local source checkout in
# this repo) with two known bugs affecting CloudTAK video playback. See README.md in
# this directory for the full explanation of both bugs; short version:
#
#   1. persist.js  - the 10s path-reconciliation sync queries CloudTAK's lease list
#      with `ephemeral=false`, so it never sees (and therefore deletes the MediaMTX
#      path of) every ephemeral lease - i.e. every CoT-video playback attempt, within
#      ~10s of it being created. Fix: query `ephemeral=all`.
#
#   2. payload.js  - registers a MediaMTX path's pull `source` using the *public*
#      hostname verbatim, which is correct for the EUD publishing to it (off-host) but
#      wrong for cloudtak-media-1 pulling it as a relay (same-host hairpin-NAT hang).
#      Fix: rewrite the hostname to the internal docker alias for same-host sources.
#
# This runs as the container's entrypoint wrapper (see docker-compose.yml `media`
# service), before the image's real entrypoint (/start), so both fixes are reapplied
# on every container start - surviving recreation / image re-pull, which a one-off
# manual patch of a running container does not.
#
# IDEMPOTENT: safe to run on every start. Does nothing if already patched.
#
# SAFETY: each target's live content is compared byte-for-byte against a known
# ORIGINAL snapshot (*.orig) before patching. If it matches neither the known
# original nor the already-patched version (*.patched) - i.e. media-infra shipped
# different code in that file - this FAILS LOUDLY and refuses to touch it, rather
# than guessing. See README.md "If this fails after a media-infra version bump" for
# how to re-derive the patch against the new code.
#
set -eu

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

apply_one() {
    name="$1"
    target="$2"
    orig="$PATCH_DIR/$name.orig"
    patched="$PATCH_DIR/$name.patched"

    if [ ! -f "$target" ]; then
        echo "FATAL - $target does not exist - media-infra image layout changed?" >&2
        exit 1
    fi

    if cmp -s "$target" "$patched"; then
        echo "ok - $name already patched, nothing to do"
        return 0
    fi

    if cmp -s "$target" "$orig"; then
        cp "$patched" "$target"
        echo "ok - $name patched"
        return 0
    fi

    echo "FATAL - $target matches neither the known original nor the patched version." >&2
    echo "        media-infra likely shipped different code in $name - the patch" >&2
    echo "        needs review before it can be safely applied. See README.md." >&2
    exit 1
}

apply_one persist.js /dist/lib/persist.js
apply_one payload.js /dist/lib/payload.js

echo "ok - media-infra patches verified/applied"

exec "$@"
