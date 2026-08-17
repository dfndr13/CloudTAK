#!/bin/sh
#
# mediamtx-webeditor-patches/apply-patches.sh
#
# /opt/mediamtx-webeditor is a self-updating third-party app (GitHub releases -
# see get_update_channel()/applyUpdate() in mediamtx_config_editor.py) with no
# local source checkout in this repo. Two bugs hand-patched live on 2026-08-17
# can't be fixed "properly" in source, so this re-patches the installed files on
# every service start, before the app boots - mirroring the pattern
# media-infra-patches/apply-patches.sh uses for cloudtak-media-1 (see that
# directory's README). Without this, the web editor's own auto-update feature
# would silently overwrite both fixes the next time it downloads a new release,
# exactly like the persist.js/payload.js loss that motivated the media-infra
# version of this script.
#
# IDEMPOTENT: safe to run on every start. Does nothing if already patched.
#
# SAFETY: each target's live content is compared byte-for-byte against a known
# ORIGINAL snapshot (*.orig) before patching. If it matches neither the known
# original nor the already-patched version (*.patched) - i.e. an auto-update
# shipped different code in that region - this FAILS LOUDLY and refuses to touch
# it, rather than guessing.
#
# Called from start_webeditor.sh AFTER that script's own sed-based env/port
# patches (CONFIG_FILE, BACKUP_DIR, PORT, MEDIAMTX_BINARY, etc) have run - the
# *.orig snapshots here were taken from a file that had already been through
# that sed block, so this must run in the same position every time or the byte
# comparison will spuriously fail. Sourced, not exec'd: control returns to
# start_webeditor.sh afterward so it can launch python3 itself.
#
set -eu

PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"

apply_one() {
    name="$1"
    target="$2"
    orig="$PATCH_DIR/$name.orig"
    patched="$PATCH_DIR/$name.patched"

    if [ ! -f "$target" ]; then
        echo "FATAL - $target does not exist - mediamtx-webeditor layout changed?" >&2
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
    echo "        mediamtx-webeditor likely shipped different code in $name (auto-" >&2
    echo "        update?) - the patch needs review before it can be safely applied." >&2
    echo "        See README.md." >&2
    exit 1
}

apply_one mediamtx_config_editor.py /opt/mediamtx-webeditor/mediamtx_config_editor.py
apply_one mediamtx_ldap_overlay.py /opt/mediamtx-webeditor/mediamtx_ldap_overlay.py

echo "ok - mediamtx-webeditor-patches verified/applied"
