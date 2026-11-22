# Cam Depot for CloudTAK

Public traffic cameras on the CloudTAK map. Find a camera in the side panel or on the map, then see its latest picture or play live video in CloudTAK's video pane.

> An independent CloudTAK plugin, inspired by takwerx's [Cam Depot](https://github.com/takwerx/cam-depot) for ATAK.
>
> **The camera list comes from TAKWERX.** Every camera, video link and picture link is read from the Cam Depot catalog that TAKWERX publishes, used with their permission. Some video goes through their relay.
>
> **The plugin itself is not made or supported by TAKWERX.** It shares no code with Cam Depot. Please report problems with this plugin here, not to TAKWERX.
>
> The cameras belong to the agencies shown on each camera.

## What it does

- **Side panel** (main menu → Cam Depot): pick one or more states and Canadian provinces, show or hide the cameras, search by name, "on screen only", and a picture or play button per camera with its provider.
- **Sync** (the button at the top of the panel): checks for a newer camera catalog and reloads the camera lists. See [The Sync button](#the-sync-button).
- **Filters** (map and list): show every camera, live video only, picture only, fire cameras or offline only; one provider; one or more counties.
- **Search** (3 or more letters) looks through the picked states in the browser and through every other state on the server (name, road, county or provider; first 50 shown). The server reads every state's files the first time anyone searches, 4 at a time, then only again after the catalog changes.
- **Big selections:** when more than 2,000 cameras match, only the 2,000 nearest the map view become markers, and they follow the map as it moves.
- **Favorites:** a star on each camera; "Favorites only" lists them across every state, picked or not. Saved in the browser.
- **Camera markers** on the map: real CoT markers of the camera type `b-m-p-s-p-loc` with CloudTAK's built-in camera icon (same as a TAK camera feed), coloured green = live video, blue = picture only, gray = offline (from the catalog's status feed). Click one for CloudTAK's radial menu; its play button opens the camera.
- **Pictures** open in CloudTAK's video pane (from the panel or the radial play button) and refresh every 15 seconds (the most some providers allow).
- **Live video** plays through a temporary CloudTAK video lease.
- The markers are local to each browser: added like CoT received from the server, never archived, so CloudTAK never sends them to TAK Server. They carry a 15-minute stale time and are refreshed every 5 minutes.

## The Sync button

You don't need Sync day to day: the server checks the catalog by itself once a day, whenever someone uses the plugin. Press Sync when the catalog was just republished (for example a provider's links were fixed) and you want the change now, or when the camera list or a camera's links look out of date.

What it does:

1. Asks CloudTAK's server to check the Cam Depot catalog for changes now. The check uses the catalog's ETag, so an unchanged catalog costs one small request.
2. Drops the camera lists the browser has loaded and fetches them again from the server, so markers, filters, counties and providers match the current catalog.
3. Shows a note under the filters:
   - **New camera catalog loaded**: the catalog had changed; state files are fetched fresh as they're picked.
   - **Camera catalog is up to date**: nothing changed since the last check.
   - **Checked recently - camera lists reloaded**: the server already checked in the last 10 minutes (one check per 10 minutes for the whole server, to respect TAKWERX's load rules), so only the browser's lists were reloaded.

While it runs, the button shows a spinner and can't be pressed again.

What it doesn't do: it keeps your favorites, filters and picked states (only a picked state that is no longer in the catalog is dropped), and it doesn't reload the plugin itself. After a CloudTAK or plugin update, close every CloudTAK tab and open a new one: an old tab keeps running the old plugin code, and Sync won't fix that. It has nothing to do with the Sync button in takwerx's Cam Depot for ATAK; pressing one doesn't update the other.

## Where the cameras come from

CloudTAK's own server fetches every list (`server/plugin-cam-depot.ts`, installed as `api/stateless/routes/plugin-cam-depot.ts`). The browser only talks to CloudTAK, so no Content-Security-Policy changes are needed.

Every state and province comes from the Cam Depot catalog by TAKWERX (`mapdepot.takwerx.org/camdepot/catalog.json`): 42 US states and 13 Canadian provinces and territories as of November 2026.

Catalog rules (TAKWERX's terms): the catalog is read at most once a day with its ETag, or on Sync (at most once per 10 minutes per server); each state's file is downloaded only when someone picks that state and kept until the catalog changes; every host and stream address comes from the catalog; if the catalog's format isn't one this plugin knows, the catalog is skipped quietly. Credit shown in the panel and on each camera: "Camera data: Cam Depot (TAKWERX)", the camera's provider, and the provider's attribution and license where the catalog gives one.

- **Video** uses the stream link the catalog gives (some go through TAKWERX's relay, which handles expiring tokens). A stream is opened only when someone picks a camera, and CloudTAK closes it when the video pane closes. MJPEG links can't be played by CloudTAK, so those cameras show as picture only.
- **Camera status** (online/offline): each state's status file from the catalog, with the catalog's live status feed on top. The server polls that feed every 15 seconds (only the changes come back), and only while some browser is showing cameras: it stops a minute after the last one stops asking. Browsers ask this server every 15 seconds, only while cameras are on the map and the tab is in view.
- **Pictures** without their own link (mostly ALERT West cameras) come from the catalog's live picture lookup through `/api/cam-depot/still/<camera>.jpg`, at most one fetch per camera per 15 seconds for the whole server. That route has no login (the video pane loads it as an image) and only answers for cameras in the catalog.

## Requirements

- **Pictures need a small CloudTAK change:** the video pane (`app/src/components/CloudTAK/util/FloatingVideo.vue`) showing image links as a refreshing picture through CloudTAK's image proxy. The installer applies it (`patches/floating-video-stills.patch`; already in the `dfndr13/CloudTAK` fork).
- CloudTAK with the image proxy (`/api/proxy/image`, upstream since October 2026). Tested on v13.121.1 and on a clean v13.124.0 with the installer.
- CloudTAK's server needs outbound HTTPS to the catalog and the picture hosts, and CloudTAK's media server needs outbound HTTPS to the stream hosts.

## Install

Clone this repository, run the installer against your CloudTAK checkout, and rebuild:

```sh
git clone https://github.com/dfndr13/cloudtak-plugin-cam-depot.git
bash cloudtak-plugin-cam-depot/install.sh /path/to/CloudTAK
cd /path/to/CloudTAK && docker compose up -d --build api
```

The installer only changes files, and each step is skipped if it's already done, so it's safe to run again (for example after a CloudTAK upgrade). It:

1. copies `plugin/` to `app/plugins/cam-depot`;
2. copies the server route (`server/plugin-cam-depot.ts`) to `api/stateless/routes/`;
3. applies the video pane change for pictures (`patches/floating-video-stills.patch`). If your CloudTAK version doesn't take the patch, it says so: video still works, pictures need the change applied by hand;
4. adds `!app/plugins/cam-depot` to `.dockerignore` (standard CloudTAK leaves plugin folders out of the image) and to `app/.gitignore` where needed;
5. adds the plugin's six routes to `api/test/fixtures/get_schema.json` (and removes the retired milestone 1 video relay route if an older install added it), so CloudTAK's API tests still pass.

Don't install or update it through the TAK Portal marketplace.

## Repository layout

| Path | Installed to |
|---|---|
| `plugin/` | `app/plugins/cam-depot/` (browser part) |
| `server/plugin-cam-depot.ts` | `api/stateless/routes/plugin-cam-depot.ts` |
| `patches/floating-video-stills.patch` | applied to `app/src/components/CloudTAK/util/FloatingVideo.vue` |
| `install.sh` | run once per CloudTAK checkout |

## Changes

The version shows at the bottom of the Cam Depot panel (`plugin/version.ts`).

### v1.1.0
- No state is picked for first-time users (was Kansas); the States button reads "Pick states" until one is chosen.
- A saved state that is no longer in the catalog is dropped instead of being swapped for the first state in the list.

### v1.0.0
- Every state and province from the Cam Depot catalog, status, filters, favorites, search across all states, Sync button.

## License

AGPL-3.0, like CloudTAK.
