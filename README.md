<p align=center><img src='./app/public/CloudTAKLogo.svg' alt='CloudTAK Logo' width='128'/></p>

<h1 align=center>CloudTAK</h1>

<p align=center>Full Featured in-browser TAK Client</p>
<p align=center>&</p>
<p align=center>Facilitate ETL operations to bring non-TAK data sources into a TAK Server</p>

<p align='center'>
    <a href="https://codecov.io/gh/dfpc-coe/CloudTAK" >
        <img src="https://codecov.io/github/dfpc-coe/CloudTAK/graph/badge.svg?token=O9PK0XT9Z2"/>
    </a>
</p>

<img src='./docs/Screenshot.png' alt='Screenshot of CloudTAK'/>

## Documentation

Deployment, local development, and administration guidance now live in the CloudTAK documentation site so the repo root is not a second source of truth.

- Deployment: https://docs.cloudtak.io/deploy/
- Local development: https://docs.cloudtak.io/develop/
- Administration: https://docs.cloudtak.io/admin/

> [!NOTE]
> Local development and Docker Compose expose the core map experience, but a full AWS deployment is still required for the complete optional ETL infrastructure.

## Fork notes: offline address search

This fork builds the [location search plugin](https://github.com/dfndr13/cloudtak-plugin-location-search) into CloudTAK, so addresses and places can be searched with no network. To do the same on your own copy:

- **Plugin:** a tracked copy lives at `app/plugins/address-search`. It comes from the plugin fork, without `cli/`, `test/`, `bench/` or `node_modules/`. `app/.gitignore`, `app/eslint.config.js` and `app/tsconfig.json` each have an entry for it.
- **Data:** `docker-compose.yml` mounts `./data/address-packs` at `/home/etl/app/dist/address-packs` in the `api` service. Put the `.pack` files and `packs.json` there. Each browser then downloads them by itself, and new packs need no rebuild. The [plugin README](https://github.com/dfndr13/cloudtak-plugin-location-search#setup-step-by-step) explains how to build them.
- **Main search box:** `app/src/components/CloudTAK/util/SearchBox.vue` lists "Addresses & Places" from the packs through `window['addresssearch:api']`. This works offline, and a failing online provider doesn't hide the results. The change is only in this fork. On stock CloudTAK, results appear only in the plugin's own search bar.
- **Online search:** CloudTAK's server-side place search needs an ArcGIS or OpenStreetMap (Photon) provider in the server settings. Neither is on by default, and without one the packs are the only source of address results.
- **Docker build:** from v13.118, upstream's `.dockerignore` excludes `app/plugins/*`, so plugins kept in that folder silently disappear from the image, even though tests still pass. This fork removes those lines. Keep them removed when merging upstream, and before going live confirm the plugin is in the built image: `docker run --rm --entrypoint sh <image> -c 'grep -l "Search Addresses" /home/etl/app/dist/assets/*'`.
- **TAK Portal marketplace:** don't install or update this plugin from it, because that replaces the copy here with the original plugin.

CloudTAK and the plugin are both AGPL-3.0, so if you run a modified copy on a server other people use, you must offer them the source of your version. OpenStreetMap-based packs have their own credit and sharing terms, covered in the plugin README. This is general information, not legal advice.


