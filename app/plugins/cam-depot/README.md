# CloudTAK CAM Depot

Public traffic cameras on the CloudTAK map. Find a camera in the side panel or on the map, then see its latest picture or play live video in CloudTAK's video pane.

> An independent CloudTAK plugin inspired by takwerx's [Cam Depot](https://github.com/takwerx/cam-depot) for ATAK. **Not made or supported by takwerx.** It shares no code or data with Cam Depot.

## What it does

- **Side panel** (main menu → CAM Depot): show or hide the cameras, search by name, "on screen only", and a picture or play button per camera.
- **Camera markers** on the map: real CoT markers of the camera type `b-m-p-s-p-loc` with CloudTAK's built-in camera icon (same as a TAK camera feed), coloured green = live video, blue = picture only, gray = offline. Click one for CloudTAK's radial menu; its play button opens the camera.
- **Pictures** open in CloudTAK's video pane (from the panel or the radial play button) and refresh every 10 seconds.
- **Live video** plays through a temporary CloudTAK video lease.
- **Offline check:** the server checks every picture about every 10 minutes while the plugin is in use (one request at a time, size only). An error or the agency's own "camera offline" card marks the camera gray.
- The markers are local to each browser: added like CoT received from the server, never archived, so CloudTAK never sends them to TAK Server. They carry a 15-minute stale time and are refreshed every 5 minutes.

## Where the cameras come from

CloudTAK's own server reads each agency's public API: `api/stateless/routes/plugin-cam-depot.ts`, one source adapter per state. The browser only talks to CloudTAK, so no Content-Security-Policy changes are needed.

| State | Source |
|---|---|
| Kansas | Kansas Department of Transportation, KanDrive public API |

Lists are cached on the server and refreshed at most once a minute.

## Video links that expire

Some agencies sign each stream link with a token that expires a few minutes after it is issued, and playback stops when it does (KDOT: 5 minutes). The server route has an HLS relay for this: each camera gets a fixed URL, `/api/cam-depot/hls/<camera>/playlist.m3u8`. Every request fetches the agency's playlist with the newest token and returns it with absolute agency URLs, so the video itself still comes straight from the agency.

CloudTAK's media server fetches that URL without a user login, so the relay answers only for known camera ids and only contacts each adapter's allowlisted stream hosts. The camera list itself needs a logged-in user.

## Requirements

- **Pictures need a small CloudTAK change:** the video pane (`app/src/components/CloudTAK/util/FloatingVideo.vue`) showing image links as a refreshing picture through CloudTAK's image proxy. It's in the `dfndr13/CloudTAK` fork (commit `0aba7015f`). Without it, live video works but picture-only cameras won't open.
- CloudTAK with the image proxy (`/api/proxy/image`, upstream since October 2026). Tested on v13.121.1.
- CloudTAK's server needs outbound HTTPS to each agency, and CloudTAK's media server must be able to reach CloudTAK's own public URL (it fetches the HLS relay from there).

## Install

The plugin has two parts, the browser plugin and one server route. From the root of your CloudTAK checkout:

```sh
cp -r <this folder> app/plugins/cam-depot
cp <path>/plugin-cam-depot.ts api/stateless/routes/plugin-cam-depot.ts
docker compose up -d --build api
```

Standard CloudTAK's `.dockerignore` leaves plugin folders out of the image (`app/plugins/*`), so also add this line to `.dockerignore`, or the plugin silently won't be in the build:

```
!app/plugins/cam-depot
```

`app/plugins/*` is also git-ignored in CloudTAK; add `!plugins/cam-depot/` to `app/.gitignore` if you track it. CloudTAK's API test compares the route list with `api/test/fixtures/get_schema.json`, so add the three `GET /cam-depot/...` routes there too if you run the tests. Don't install it through the TAK Portal marketplace.

## License

AGPL-3.0, like CloudTAK.
