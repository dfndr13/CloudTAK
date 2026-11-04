# Hosting `.pack` files for the fetch-from-URL load path

> **This fork:** browsers load packs automatically from `packs.json` in the same folder (see the
> README's steps 4 and 5). Everything below still applies to serving the files. Run the CLI's
> `pack-list` command after every change to the folder. The paths below that use
> `/home/etl/api/web/dist` are for CloudTAK before v13.110; newer releases use `/home/etl/app/dist`.

**Required for any shared/production CloudTAK instance** — see the main
[README's setup walkthrough](../README.md#4-host-the-pack-file-required-for-more-than-one-user)
for why. Address data lives in each browser's own local IndexedDB, never on a server, so there is
no way for one person's file-picker upload to reach anyone else. The gear panel's "Load from URL"
field (`lib/storage/upload.ts`'s `loadFromUrl`) is the only path that lets everyone get the same
data without you handing each person the `.pack` file directly — and that only works once
something is actually serving it over HTTP.

## Recommended: serve it directly from your own CloudTAK deployment

If you run CloudTAK's own `docker-compose.yml` (most self-hosted/VPS setups do), the simplest and
most robust option is serving the `.pack` file from the **exact same origin as CloudTAK itself** —
no separate container, no CORS, no CSP change, no reverse-proxy route, and no rebuild needed for
future data updates.

This works because of two things confirmed directly in CloudTAK's own source:

- `api/nginx.conf.js`'s catch-all `location /` block (`alias /home/etl/api/web/dist/; try_files
  $uri ... /index.html;`) serves **any file physically present** in that directory straight off
  disk — nginx's static-file serving handles `Range` requests automatically, with no extra config.
- That directory (`/home/etl/api/web/dist/`) is a normal path inside the running `api` container,
  so a plain Docker bind-mount makes anything you drop on the host side show up there live.

Add a volume to the **existing `api` service** in your `docker-compose.yml` — no new service:

```yaml
services:
  api:
    volumes:
      - ./data/address-packs:/home/etl/api/web/dist/address-packs
```

Then, on the VPS:

```sh
mkdir -p ./data/address-packs   # create it yourself so it's owned by your user, not root
docker compose up -d api        # restart once, to pick up the new mount
scp az-statewide.pack youruser@your-vps:/path/to/compose/dir/data/address-packs/
```

The file is now reachable at `https://<your-cloudtak-domain>/address-packs/az-statewide.pack` —
same origin as CloudTAK, so `Access-Control-Allow-Origin`/CSP's `connect-src` (both already permit
`'self'`) need no changes, and there's no mixed-content risk. Adding or replacing a `.pack` later
is just another `scp` into that same host folder — no container restart, no rebuild, no redeploy.

Two things this rules out, for the record: `api/web/plugins/<name>/` can't serve raw files at all
(Vite bundles everything there as JS source). `api/web/public/` looks tempting since Vite copies it
verbatim into `dist/` — but that copy happens **once, at Docker build time**; a file dropped into
`public/` on an already-running container is never picked up, since nothing re-reads it after the
image is built. `dist/` (via the bind-mount above) is the directory actually served at runtime.

## Alternative: a separate static-file-server container

Useful if you don't control the CloudTAK deployment directly (e.g. someone else manages that
`docker-compose.yml`) and can't add a volume to its `api` service — host the `.pack` file anywhere
else reachable instead. This needs its own CORS setup, since it's now a different origin than
CloudTAK:

```yaml
# docker-compose.yml (illustrative — a separate stack, or your own compose file)
services:
  address-packs:
    image: halverneus/static-file-server:latest
    ports:
      - "8081:8080"   # HOST:CONTAINER — the left side is arbitrary, pick any free host port
    volumes:
      - ./data/address-packs:/web
    environment:
      CORS: "true"
```

Drop `az-statewide.pack` into `./data/address-packs/`, and it's reachable at
`http://<host>:<port>/az-statewide.pack`.

**The part that actually matters here: CORS.** The browser fetch in `loadFromUrl` runs from
CloudTAK's own origin, so this separate host **must** send `Access-Control-Allow-Origin` covering
that origin (or `*` — the files aren't sensitive, they're derived from public OpenAddresses data).
`halverneus/static-file-server`'s `CORS: "true"` sends a permissive `Access-Control-Allow-Origin:
*`. If you use plain nginx instead:

```nginx
location /address-packs/ {
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
    add_header Access-Control-Allow-Headers "Range";
}
```

`Range` matters specifically: `loadFromUrl` probes for `Range` support (HTTP 206) on the first
request so section reads stay small and constant-memory, per PLAN.md §3.5. Make sure CORS headers
don't strip the `Range` request header or the `Content-Range`/`Accept-Ranges` response headers,
which some default CORS configs do by only allowlisting a narrow header set.

**Also relevant if this separate host is on a different domain than CloudTAK**: CloudTAK's own
nginx config sets a Content-Security-Policy whose `connect-src` directive only permits `'self'`
plus a short hardcoded allowlist by default. A browser `fetch()` to a *different* origin can be
blocked by CSP even with CORS configured correctly. CloudTAK's `nginx.conf.js` supports appending
extra allowed origins via an `NGINX_CSP_CONNECT_SRC` environment variable (comma-separated) on the
`api` service — set that to your file host's origin if you go this route. (The recommended
same-origin approach above needs none of this, since `'self'` already covers it.)
