# OneMekong Hydropower — Operational Data

Auto-synced data for [hydropower.onemekong.org](https://hydropower.onemekong.org). **Do not edit by hand** — pushes from crons will overwrite changes.

## Layout

```
mrc_stations.json          — MRC water-level station snapshot (hourly)
mrc_timeseries/*.json      — Rolling 30-day per-station timeseries (hourly)
cascade.json               — Lao MEM dam-safety snapshot (daily, 4 PM Bangkok)
rainfall/
├── grid_YYYYMMDD_HH.json  — Open-Meteo 0.25° basin grid (every 6h)
├── provinces_*.json       — Province-mean rainfall (every 6h, 92 admin-1 polygons)
└── dams_*.json            — Per-dam catchment-mean rainfall (every 6h, 101 dams)
```

## Update cadence

| File | Cadence | Cron |
|---|---|---|
| `mrc_stations.json`, `mrc_timeseries/*` | hourly | `0 * * * *` UTC |
| `cascade.json` | daily | `0 9 * * *` UTC (4 PM Bangkok) |
| `rainfall/*` | every 6h | `5 */6 * * *` UTC |

## Access from the dashboard

Frontend fetches via the Vercel proxy:
```
https://hydropower.onemekong.org/data/<path>
```
This proxies to `raw.githubusercontent.com/s4santi/lao-hydropower-data/main/<path>` with a 5-minute edge cache. No direct GitHub URLs in the frontend code.

## Data sources

- **MRC water-level telemetry** — Mekong River Commission, [api.mrcmekong.org](https://api.mrcmekong.org)
- **Lao MEM dam-safety reports** — Lao Ministry of Energy & Mines, daily Google Sheets feeds
- **Rainfall forecast** — [Open-Meteo](https://open-meteo.com) (ECMWF/GFS ensemble), free non-commercial tier with attribution
- **HydroSHEDS catchments** — [hydrosheds.org](https://www.hydrosheds.org/), CC-BY 4.0

## Retention

- MRC timeseries: rolling 30 days, files overwritten each hour
- Rainfall: rolling 7 timestamps (~42 hours of history), older files pruned on each sync
- Cascade: daily snapshot, overwritten each day
