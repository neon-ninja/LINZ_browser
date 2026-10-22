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
  can be queried like any other dataset.
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
- **Map extent filter**: limit results to the area visible on the map.
- Choose columns, sort order (or click a column header) and page size; page
  through results with total match counts.
- Results on an OpenStreetMap basemap: click a row to zoom to the feature, or
  click a feature to find its row.
- Download the current page as CSV or GeoJSON, or copy the WFS request URL to
  use in QGIS, curl, etc.

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

Both APIs allow cross-origin requests, so no proxy server is needed. The browser
sends the key in an `Authorization: key …` header rather than LINZ's
`/services;key=…/wfs` URL form, which keeps it out of request URLs (the *Copy
request URL* button still gives you the key-in-URL form so the link works on its
own).

Licensed datasets are hidden from anonymous catalogue requests, and reading
their details needs a key with the `layers:read` scope. Without that scope the
app reads their fields from WFS `DescribeFeatureType` instead, so they can still
be queried; only the description, extent and feature count are missing.

WFS has no "distinct values" request, so value suggestions are built by fetching
a field in small batches, each excluding the values already found, until a
batch comes back short (the list is then complete) or there are plenty of
suggestions.

### Code layout

```
index.html        page structure
css/styles.css    styles (light and dark themes)
js/app.js         UI: search, favourites, query builder, results, map
js/linz.js        LINZ catalogue and WFS client
js/cql.js         turns query-builder conditions into ECQL
js/storage.js     localStorage helpers (key, favourites, last queries)
tests/            unit tests for cql.js and linz.js
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
