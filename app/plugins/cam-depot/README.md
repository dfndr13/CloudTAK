# CloudTAK CAM Depot

Public traffic cameras on the CloudTAK map. Find a camera in the side panel or on the map, then see its latest picture or play live video in CloudTAK's video pane.

> An independent CloudTAK plugin inspired by takwerx's [Cam Depot](https://github.com/takwerx/cam-depot) for ATAK. **Not made or supported by takwerx.** It shares no code or data with Cam Depot.

## What it does

- **Side panel** (main menu → CAM Depot): show or hide the cameras, search by name, "on screen only", and a picture or play button per camera.
- **Camera markers** on the map: real CoT markers of the camera type `b-m-p-s-p-loc` with CloudTAK's built-in camera icon (same as a TAK camera feed), coloured green = live video, blue = picture only, gray = offline. Click one for CloudTAK's radial menu; its play button opens the camera.
- **Pictures** open in CloudTAK's video pane and refresh every 10 seconds.
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

- Built for the `dfndr13/CloudTAK` fork. Pictures use the fork's still-image mode of the video pane (`FloatingVideo.vue`, through CloudTAK's image proxy).
- CloudTAK's server needs outbound HTTPS to each agency.

## License

AGPL-3.0, like CloudTAK.
