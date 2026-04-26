# Historical boundaries — globe

Small static page: drag to rotate the globe, scroll to zoom, scrub the timeline to jump between fixed historical snapshots. Regions are colored by the dataset’s `SUBJECTO` field (colonial / imperial “subject” power), with `NAME` in the tooltip.

## Run locally

GeoJSON is loaded from GitHub (`raw.githubusercontent.com`). Browsers often block `fetch` for subresources when you open `index.html` as a `file://` URL, so use a local HTTP server from this folder:

```bash
cd empires-map
python -m http.server 8080
```

Windows PowerShell (same folder in one line):

```powershell
Set-Location empires-map; python -m http.server 8080
```

Then open `http://localhost:8080`.

## Data

- Repository: [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps)
- License: **CC-BY** — keep the attribution visible when you share or adapt the visualization.

The curator notes that the maps are **work in progress** and not suitable as sole evidence for academic claims without cross-checking other sources.

## Files

- `index.html` — page shell
- `styles.css` — layout and theme
- `app.js` — D3 orthographic globe, timeline, cache + prefetch
- `data/index.json` — trimmed list of `{ year, filename }` snapshots (generated from upstream `index.json`)
