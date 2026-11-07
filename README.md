# Leiden Building Finder (prototype)

A map of every building in Leiden, built from open government data, to find
buildings that may be **vacant, old or underused**, filter them, and keep track
of which ones you've followed up.

Inspired by [Sloopkaart.nl](https://sloopkaart.nl/), which crowd-sources
demolitions. This prototype works the other way round: it starts from the
official registers and lets you filter them.

## What you can do

- **Quick views**: any signal, possibly vacant, demolition, old offices ≥ 500 m²,
  transformation candidates (office/industry/retail ≥ 1,000 m², built before 1980),
  monuments with a signal
- **Filter** on signals, main use, floor area, year built, rijksmonument and your
  own follow-up status; search on street, postcode or BAG id
- **Colour the map** by signals, main use or year built; switch to aerial photos
- **Click a building** for:
  - why it's flagged, in one line
  - its permits, sorted into real signals and minor notices (terraces, sheds, events)
  - every unit in the building, looked up live from the BAG
  - its cadastral parcel, looked up live, so you can order the owner's name at the Kadaster (paid)
  - buttons to walk around in Street View, zoom in on the aerial photo, or copy a
    summary to send to someone, plus links to the BAG viewer, monument register,
    energy label lookup and zoning rules
- **Track follow-up**: mark a status (interesting, check on site, owner contacted,
  in talks, not relevant) and add notes. These are stored in your browser only.
- **Export CSV** of the current selection, including your statuses and notes

## Data

| Source | What | How it's linked |
| --- | --- | --- |
| BAG (Kadaster, via PDOK WFS) | Every building and unit: year built, use, floor area, status | Units are summed per building; only buildings with at least one unit in Leiden |
| Rijksmonumentenregister (RCE, via PDOK WFS) | National monuments | Monument point inside the building outline |
| Officiële bekendmakingen (KOOP SRU API) | Gemeenteblad Leiden notices since 2023 mentioning demolition, vacancy or change of use | Notice location inside, or within 25 m of, the building |

All open data, no API keys. `scripts/fetch_leiden.py` downloads it (Python 3,
standard library only, a few minutes) and writes `data/leiden.json`. A GitHub
Action (`.github/workflows/refresh-data.yml`) re-runs it on the 1st of every
month and commits the new data.

### What the signals mean, and their limits

There is **no public register of vacant buildings** in the Netherlands. The
signals give a shortlist, not proof:

- **Out of use (BAG)** is rare: in practice the BAG uses it for buildings that are
  physically unusable, not simply empty. In Leiden only one unit has it.
- Permits are classified by their title (`notices.js`, tested in
  `test/notices.test.mjs`). **Demolition** only counts for whole buildings;
  **transformation** only for conversions to housing or shelter; **temporary use**
  excludes events. Sheds, walls, terraces, shops changing trade and splitting a
  home are shown but don't count. Refused or withdrawn permits never count. The
  rules are keyword-based, so the odd notice will land in the wrong bucket.

Always check on site or in Street View before contacting an owner. When the
owner is a private person, the AVG/GDPR applies: you may write to them about
their building, but don't keep their personal data longer than needed.

## Run it locally

```sh
python3 -m http.server 8080        # then open http://localhost:8080
python3 scripts/fetch_leiden.py    # refresh the data
npm test                           # notice classification tests
```

To use it for another municipality, change `WOONPLAATS`, `GEMEENTE` and `BBOX`
at the top of the script, and the map centre in `app.js`.

## Ideas for next steps

- Energy labels (EP-online, free API key): old buildings with label E–G
- More vacancy signals: long-running listings, municipal vacancy registers, Street View image checks
- Shared follow-up (several people, one list) instead of browser storage
- South Africa version: municipal valuation rolls and the Deeds Office instead of BAG and Kadaster
