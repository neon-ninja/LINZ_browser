# LINZ Data Browser

A small web app for browsing and querying data from the
[LINZ Data Service](https://data.linz.govt.nz) (LDS): search the catalogue,
open a vector layer or table, build a filter from dropdowns, and see the results
as a table and on a map.

It's a static site (plain HTML, CSS and JavaScript modules, no build step) that
talks to the LINZ APIs directly from your browser.

## Features

- **Search the catalogue** for vector layers and tables, filtered by LINZ
  category (e.g. *Property Ownership & Boundaries → Titles & Owners*) and sorted
  by relevance, popularity, recent updates or name.
- **Licensed datasets.** With your key saved, search also finds datasets LINZ
  has licensed to you, such as *NZ Property Titles Including Owners*. These
  are marked with a lock icon and can be queried like any other dataset.
- **API key remembered in your browser.** Paste your LDS key once; it's kept in
  `localStorage` and only ever sent to `data.linz.govt.nz`. A *Test* button
  checks it with LINZ.
- **Favourites.** Star datasets to keep them in the Favourites tab. The last
  query you ran on each dataset is remembered too.
- **Query builder that knows the fields.** Fields and their types come from the
  LINZ catalogue, so you pick them from a dropdown. The comparisons offered
  depend on the type (text: is / contains / starts with / is one of…, numbers:
  `<`, `≥`, between…, dates: before / on / after / between, yes/no fields: is
  true / is false), and the value box gets the right input (date picker, number…).
- **Value suggestions.** Text fields suggest values that actually occur in the
  data as you type (e.g. all 12 land districts), fetched from LINZ on demand.
- **Arbitrary queries.** The generated
  [ECQL](https://docs.geoserver.org/stable/en/user/filter/ecql_reference.html)
  filter is shown as you build it; tick *Edit by hand* to write any filter
  yourself (spatial predicates, functions, …).
- **Location filter**: limit results to the area visible on the map, to
  features at the marked location (e.g. the title or parcel under an address),
  or to features within a chosen number of metres of it.
- **Find an address (geocoding).** The search box on the map looks up NZ
  Addresses as you type ("12 queen st auckland", "2/12a …", "lake tce taupo";
  macrons optional), then zooms to the address and marks it.
- **What's here? (reverse geocoding).** Right-click the map (long-press on a
  touch screen), or switch on *What's here?* and click, to see the nearest
  addresses, the parcel and the title at that spot. *Open* loads that parcel
  or title as a filtered query, *Copy* copies a title number (e.g. to filter a
  title table), and *Filter … to here* restricts the open dataset to the spot.
- **Addresses for features.** *Find address* in a feature's popup, or *Find
  addresses* for the whole page, adds the address of each parcel, title,
  building, etc. (every address inside a polygon, otherwise the nearest within
  100 m) as an extra column, included in CSV and GeoJSON downloads.
- Choose columns, sort order (or click a column header) and page size; page
  through results with total match counts.
- Results on an OpenStreetMap basemap: click a row to zoom to the feature, or
  click a feature to find its row.
- Download the current page as CSV or GeoJSON, or copy the WFS request URL to
  use in QGIS, curl, etc.
- **Copy or share a row.** The ⋯ button on each row (or tapping a row on a
  phone) opens its details: every field with its own copy button, plus
  *Share* (the phone's share sheet), *Copy details* (all fields as text),
  *Copy link*, *Copy JSON*, *Show on map* and *Find address*. Row links look
  like `…/#/layer/50804?id=961395` and open the app filtered to that row; any
  `field=value` pairs work, e.g. `#/layer/50804?title_no=CB22A%2F485`.
- **Works on phones.** On narrow screens the dataset list collapses once a
  dataset is open, fields use 16px text so iOS doesn't zoom in, tap targets
  are larger and the details open as a bottom sheet.

## Getting an API key

Querying features needs a free LDS API key. Sign in at
[data.linz.govt.nz](https://data.linz.govt.nz), then go to
[*My API keys*](https://data.linz.govt.nz/my/api/) and create one that is
allowed to use the web services (WFS). Searching the catalogue works without a
key.

## Running it

Any static file server will do. ES modules don't load from `file://` URLs, so
serve the folder over HTTP:

```sh
python3 -m http.server 8000      # or: npm start
# then open http://localhost:8000
```

### GitHub Pages

The app is published at **https://neon-ninja.github.io/LINZ_browser/** by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml), which runs the
tests and deploys `index.html`, `css/` and `js/` on every push to the default
branch. One-time setup: in the repository's **Settings → Pages**, set
**Source** to **GitHub Actions**, then re-run the workflow (Actions → Deploy to
GitHub Pages → Run workflow).

## How it works

| What | LINZ API |
| --- | --- |
| Search datasets | Catalogue API: `GET /services/api/v1.x/data/?q=…&kind=vector&kind=table&category=…`, with your key if LINZ accepts it there, so licensed datasets are included |
| Categories | Catalogue API: `GET /services/api/v1.x/categories/` |
| Fields, types, geometry, extent | Catalogue API: `GET /services/api/v1.x/layers/{id}/` or `/tables/{id}/` |
| Fields of licensed datasets | WFS `DescribeFeatureType` (used when the catalogue won't describe a dataset to your key) |
| Query features | WFS 2.0 `GetFeature` with `cql_filter`, `propertyName`, `sortBy`, `count`, `startIndex`, `outputFormat=application/json`, `srsName=EPSG:4326` |
| Total matches | WFS `GetFeature` with `resultType=hits` |
| Check a key | WFS `GetCapabilities` (401 for an unknown key) |
| Find an address | WFS `GetFeature` on NZ Addresses (layer 123113) with `ILIKE` filters on `full_address_ascii` |
| What's here? | Vector Query API: `GET /services/query/v1/vector.json?layer=123113&layer=50772&layer=50804&x=…&y=…&radius=100` (NZ Addresses, NZ Primary Parcels, NZ Property Titles) |
| Address for a polygon | WFS `GetFeature` on NZ Addresses with a `BBOX` filter, then a point-in-polygon test in the browser; the Query API for the nearest address otherwise |
| At / near the marked location | `cql_filter` with `INTERSECTS(shape, SRID=4326;POINT(lon lat))` or `DWITHIN(…, metres, meters)` |

Both APIs allow cross-origin requests, so no proxy server is needed. The browser
sends the key in an `Authorization: key …` header rather than LINZ's
`/services;key=…/wfs` URL form, which keeps it out of request URLs (the *Copy
request URL* button still gives you the key-in-URL form so the link works on its
own).

Licensed datasets are hidden from anonymous catalogue requests, which is also
how the app spots them for the lock icon: after a keyed search it asks the
catalogue anonymously for the same IDs (`/data/?id=…&id=…`), and any it can't
see are licensed. Reading their details needs a key with the `layers:read`
scope. Without that scope the app reads their fields from WFS
`DescribeFeatureType` instead, so they can still be queried; only the
description, extent and feature count are missing.

The `SRID=4326;` prefix on points matters: without it LINZ reads the point in
the layer's own coordinate system, which for NZGD2000 layers swaps the axes.

WFS has no "distinct values" request, so value suggestions are built by fetching
a field in small batches, each excluding the values already found, until a
batch comes back short (the list is then complete) or there are plenty of
suggestions.

### Code layout

```
index.html        page structure
css/styles.css    styles (light and dark themes)
js/app.js         UI: search, favourites, query builder, results, map
js/lookup.js      map address search, What's here?, the marked location
js/linz.js        LINZ catalogue, WFS and Query API client (incl. geocoding)
js/cql.js         turns query-builder conditions into ECQL
js/geo.js         geometry helpers (bounds, point in polygon, point on surface)
js/share.js       row links, shared-link routes and copy text
js/icons.js       Octicons icon paths
js/dom.js         tiny DOM helpers (elements, icons, copy, toast)
js/storage.js     localStorage helpers (key, favourites, last queries)
tests/            unit tests for cql.js, geo.js, linz.js and share.js
```

[Leaflet](https://leafletjs.com) (from cdnjs) draws the map.

## Tests

```sh
npm test   # runs node --test; needs Node 18+ and no dependencies
```

## Data licensing

Most LDS data is published under Creative Commons Attribution 4.0; each
dataset's licence is shown on its page in the app. Basemap © OpenStreetMap
contributors.
