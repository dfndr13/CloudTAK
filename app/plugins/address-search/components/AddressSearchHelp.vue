<template>
    <div class='address-search-help'>
        <h4>Searching</h4>
        <p>Type an address, city, or street name. Results update as you type. Click a result to fly the map to it.</p>

        <h4>Dropping a marker</h4>
        <p>
            Click the
            <IconMapPinPlus
                :size='16'
                stroke='2'
                class='address-search-help__inline-icon'
            /> icon on a result to open the drop prompt. Set a callsign and point type, then either
            <strong>Keep Local</strong> (never leaves this device, never shared) or
            <strong>Save &amp; Share…</strong> (also opens CloudTAK's share dialog).
        </p>

        <h4>Finding the address at a point</h4>
        <p>
            Click the
            <IconCrosshair
                :size='16'
                stroke='2'
                class='address-search-help__inline-icon'
            /> icon, then click anywhere on the map — the nearest loaded address comes back in the results list,
            same as a text search. Click the crosshair icon again to cancel without clicking the map.
        </p>

        <h4>Choosing which data is searched</h4>
        <p>
            Click the
            <IconDatabase
                :size='16'
                stroke='2'
                class='address-search-help__inline-icon'
            /> icon to see every loaded dataset and turn individual ones on or off. All enabled datasets are
            searched together.
        </p>

        <h4>Adding data</h4>
        <p>
            Click the
            <IconSettings
                :size='16'
                stroke='2'
                class='address-search-help__inline-icon'
            /> icon to see what's loaded on this device. Address data is downloaded and kept up to date
            automatically whenever the device is online, and search works offline once it's here. Loading other
            data by hand is limited to CloudTAK system admins.
        </p>
    </div>
</template>

<script setup lang='ts'>
import { IconCrosshair, IconDatabase, IconMapPinPlus, IconSettings } from '@tabler/icons-vue';
</script>

<style scoped>
.address-search-help {
    padding: 12px;
    overflow-y: auto;
    height: 100%;
}
.address-search-help h4 {
    margin: 12px 0 4px;
}
.address-search-help h4:first-child {
    margin-top: 0;
}
.address-search-help p {
    margin: 0 0 4px;
    opacity: 0.85;
}
.address-search-help__inline-icon {
    vertical-align: middle;
    margin: 0 2px;
}
</style>
