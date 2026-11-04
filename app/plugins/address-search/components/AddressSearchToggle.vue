<template>
    <!--
        Registered through api.bottomBar.add(). Teleported to <body> and anchored beneath core's
        left-margin control stack, the same spot measure's ruler button anchors to (there's no
        dedicated plugin hook for that stack) — see docs/PLAN.md §8.3.

        Deliberate deviation from measure's own pattern: this shell does NOT carry the
        `.cloudtak-ctrl-group` class. That class is the literal discriminator measure's own
        `coreControlStack()` query (`.cloudtak-ctrl-group:not(.measure-toggle-shell)`) uses to
        find core's real stack, and ~/dev/cloudtak-plugin-measure is reference-only — it can't be
        edited to recognize a new shared attribute. If this shell also carried that class,
        measure's query could pick up THIS button and mis-anchor itself to it. Visual parity with
        `.cloudtak-ctrl-group`'s look (see Map.vue's actual CSS) is replicated below under our own
        class instead. `.cloudtak-panel` (background/shadow) and `.cloudtak-ctrl-btn` (per-button
        styling) are NOT discriminators anywhere — those are reused normally, same as measure does.

        Other plugins (measure, somewear, ...) anchor their own floating buttons to this exact
        same core-stack rect, with no shared coordination between plugins — confirmed live via
        `document.elementFromPoint()` that somewear's icon was painted directly on top of ours at
        the identical fixed coordinates, since both are `position: fixed` and it comes later in
        the DOM. PLAN.md §10's real fix (a shared `data-cloudtak-plugin-btn` ordering attribute)
        needs every sibling plugin's code updated too, out of reach from this repo. Since we can't
        change any of them, `reposition()` below instead probes whatever is ACTUALLY rendered at
        our own candidate position and stacks below the bottom edge of any foreign fixed-position
        element found there — generic to any current or future colliding plugin, not just measure.
    -->
    <Teleport to='body'>
        <div
            v-if='anchor'
            ref='shellRef'
            class='address-search-shell cloudtak-panel'
            :class='{ "address-search-shell--expanded": expanded }'
            :style='{ top: `${anchor.top}px`, left: `${anchor.left}px` }'
        >
            <div
                v-if='!expanded'
                role='button'
                tabindex='0'
                class='cloudtak-ctrl-btn'
                title='Search Addresses'
                @click='open'
                @keyup.enter='open'
            >
                <IconMapPinSearch
                    :size='24'
                    stroke='2'
                />
            </div>
            <AddressSearchBar v-else />
        </div>
    </Teleport>
</template>

<script setup lang='ts'>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconMapPinSearch } from '@tabler/icons-vue';
import { expanded, open, close } from '../lib/state.ts';
import AddressSearchBar from './AddressSearchBar.vue';

const GAP = 8;
const MAX_STACK_PASSES = 8;

const anchor = ref<{ top: number; left: number } | null>(null);
const shellRef = ref<HTMLElement | null>(null);

let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let observed: Element | null = null;

/** Core's left-margin control stack — excludes measure's shell explicitly, since it also
 *  carries `.cloudtak-ctrl-group` for its own visual styling. Never matches our own shell,
 *  which never carries that class at all (see the template comment above). */
function coreControlStack(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.cloudtak-ctrl-group:not(.measure-toggle-shell)');
}

/** Walks up from a hit-tested node to find the nearest ancestor actually positioned `fixed` —
 *  a sibling plugin's floating button is usually a deeply nested icon/img, not the fixed shell
 *  itself, so measuring the hit node's own rect would be meaningless. */
function closestFixedAncestor(node: Element | null): HTMLElement | null {
    let cur: Element | null = node;
    while (cur && cur !== document.body) {
        if (cur instanceof HTMLElement && getComputedStyle(cur).position === 'fixed') return cur;
        cur = cur.parentElement;
    }
    return null;
}

function reposition(): void {
    const el = coreControlStack();
    if (!el) {
        anchor.value = null;
        return;
    }
    if (el !== observed) {
        if (resizeObserver && observed) resizeObserver.unobserve(observed);
        observed = el;
        if (resizeObserver) resizeObserver.observe(el);
    }
    const rect = el.getBoundingClientRect();
    let top = rect.bottom + GAP;
    const left = rect.left;

    // Probe whatever is actually rendered at our candidate spot. If a foreign fixed-position
    // element is already sitting there (another plugin using the same anchor convention), stack
    // below its real bottom edge and re-probe, since pushing down could reveal yet another one.
    for (let pass = 0; pass < MAX_STACK_PASSES; pass++) {
        const stack = document.elementsFromPoint(left + 4, top + 4);
        let pushedDown = false;
        for (const candidate of stack) {
            if (shellRef.value?.contains(candidate)) continue;
            const fixedAncestor = closestFixedAncestor(candidate);
            if (!fixedAncestor) continue;
            const fRect = fixedAncestor.getBoundingClientRect();
            if (fRect.width === 0 || fRect.height === 0) continue;
            if (fRect.bottom + GAP > top) {
                top = fRect.bottom + GAP;
                pushedDown = true;
            }
        }
        if (!pushedDown) break;
    }

    anchor.value = { top, left };
}

onMounted(() => {
    reposition();
    resizeObserver = new ResizeObserver(() => reposition());
    mutationObserver = new MutationObserver(() => reposition());
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', reposition);
});

onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    observed = null;
    window.removeEventListener('resize', reposition);
});

// If core hides the map controls (menu open, non-Default mode) while the bar is open, close it.
watch(anchor, (value) => {
    if (!value && expanded.value) close();
});
</script>

<style scoped>
.address-search-shell {
    position: fixed;
    z-index: 4; /* above the map, below core's top control bar (z-index 5) */
    display: flex;
    flex-direction: column;
    width: 40px;
    overflow: hidden;
    transition: width 0.15s ease;
}

.address-search-shell--expanded {
    width: 320px;
    overflow: visible;
}
</style>
