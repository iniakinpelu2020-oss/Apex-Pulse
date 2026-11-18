# Apex Pulse

A device pulse and a keep-alive watch list, on one page. Mounted by ApexOS at
`/apps/pulse/`. Everything is measured in the tab you are looking at and kept in
`localStorage` under `apex.pulse.v1` — no account, no key, no upload.

## What it shows

**Now** — eight readings, refreshed every two seconds:

| Tile | Source | Note |
| --- | --- | --- |
| Battery | `navigator.getBattery()` | level and whether it is charging; says `n/a` where the browser hides it |
| Network | `navigator.connection` | effective type, downlink, RTT, plus online/offline events |
| Storage | `navigator.storage.estimate()` | used against quota for this origin |
| Memory | `navigator.deviceMemory`, `performance.memory` | device RAM and the JS heap the page holds |
| Cores | `navigator.hardwareConcurrency` | hardware threads |
| Screen | `screen`, `devicePixelRatio` | pixels and device-pixel ratio |
| This session | `Date.now()` | time this tab has been open, and whether it is visible |
| Page load | `PerformanceNavigationTiming` | interactive and load timings for this page |

**Event loop** — a 250 ms timer is compared with its scheduled time every tick.
The delay is lag: a flat line means the tab is idle, spikes mean it is busy. The
last minute is drawn on a canvas, so a stutter leaves a mark instead of a number
that is already gone.

**Watch list** — add up to 24 URLs. Each one gets a manual **Check**, a status
pill, the round-trip time and the time of the last result. **Repeat** re-checks
the whole list every 30 s, 60 s or 5 min. **Keep screen awake** holds a Screen
Wake Lock while the tab runs, so a long-running watch does not sleep on a phone.

**Log** — the last 200 checks with time, result, latency and reason, exportable
as JSON and clearable.

## What it cannot do, and says so

- A browser reply to a cross-origin request arrives opaque, so Pulse reports
  *reached* or *unreachable* and the milliseconds, never the HTTP status code.
  A 500 answers the same as a 200.
- Repeat checks only run while this tab is open and awake. A closed tab cannot
  keep a server warm; that needs a scheduler somewhere else. This is the honest
  version of "keep-alive": a tab that keeps knocking.
- Background tabs have their timers throttled by the browser, so a repeat set to
  30 s may stretch to a minute while the tab is hidden.
- Battery, network and heap figures are all optional browser APIs. Where a
  browser does not expose one, the tile says `n/a` rather than inventing a value.

## Files

```
index.html          app shell
styles.css          dark panel theme
app.js              sampling, probing, log, wake lock, export
manifest.json       installable, standalone
sw.js               offline shell (apex-pulse-v1)
offline.html        fallback when the shell cannot be fetched
icons/              192, 512 and maskable 512 PNGs
tools/make-icons.py regenerates the icons with nothing but the stdlib
```

Regenerate the icons with `python3 tools/make-icons.py` from the repo root.

## Run it

Open `index.html` through a server (`python3 -m http.server`) so the service
worker and `localStorage` get a real origin, then visit `/index.html`. Part of
the Apex ecosystem; the Apex Store links here at `/apps/pulse/`.
