# Weather Globe

A 3D globe built with three.js that streams satellite or OpenStreetMap tiles. This is the base for a 3D weather visualizer: cloud decks by altitude, convection towers, wind particles and NOAA forecasts drawn above the surface.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Pushing to `main` deploys to GitHub Pages using `.github/workflows/deploy.yml`. To turn this on, go to **Settings → Pages → Source** and choose **GitHub Actions**.

## Base layers

| Layer | Source | Max zoom | Notes |
|---|---|---|---|
| NASA Blue Marble | NASA GIBS | 8 | Cloud-free composite |
| NASA VIIRS True Color | NASA GIBS (NOAA-20) | 9 | One image per day, with real clouds; pick the date in the panel |
| Esri World Imagery | Esri | 18 | High resolution, zooms to street level |
| OpenStreetMap | OSM | 19 | Follow the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); switch to a paid OSM tile host if traffic grows |

On satellite layers you can also turn on an optional borders-and-places overlay (Esri Reference).

## Current clouds

Turn on **Weather layers → Current clouds** to show live clouds in 3D above the globe.

- **Data:** infrared (~10.8 µm) images from geostationary weather satellites.
  - GOES-East, GOES-West and Himawari come from NASA GIBS. They update every 10 minutes and are calibrated to °C using the GIBS colormap.
  - Europe, Africa and the Indian Ocean (Meteosat) are filled in from EUMETSAT's 3-hourly multi-satellite IR ring. Its grey levels aren't calibrated, so the app works out a grey→°C mapping on each load from the areas where both sources overlap.
- **Height:** cloud-top height is estimated from how much colder the cloud top is than the expected surface temperature, using a standard lapse rate of 6.5 °C/km. Cold, high tops become tall towers and warm, low cloud stays thin. Very low cloud and cold winter ground are the weak spots of this method.
- **Rendering:** 16 transparent shells between 0.3 and 16 km. Each one draws only where the cloud column reaches it. Use the slider to set the height exaggeration (default 20×). The cloud layer refreshes every 10 minutes.

## US clouds: HRRR + METAR

Over the contiguous US the clouds come from a weather model, not an estimate. That gives them real tops, bases and stacked layers.

- **HRRR** is NOAA's 3 km model and runs every hour. Each run, `pipeline/build_clouds.py` downloads only the cloud water, cloud ice, snow and geopotential height fields on 37 pressure levels from NOAA's AWS bucket, using the `.idx` byte ranges (~40 MB per hour of forecast instead of ~400 MB). It then:
  1. regrids them to a 0.1° lat/lon grid,
  2. converts condensate to cloudiness and interpolates to 23 fixed heights (0.25–16 km above sea level),
  3. writes one PNG atlas per forecast hour (0–12 h).
- **METAR** cloud bases (ceilometer reports from aviationweather.gov) correct the model near the ground. At each station, the difference between the observed and modelled cloud profile below 12,000 ft (or below the first broken/overcast deck) is spread to the area around it with a 40 km Gaussian. The correction fades with forecast hour.
- **Satellite check:** at the current hour, where the satellite sees warm, clear-looking sky, high model cloud is damped. You can turn this off.
- **Station markers:** each station shows its reported layers at their real heights (green = clear, light blue = few, blue = scattered, amber = broken, red = overcast). Hover over one to see its METAR and the HRRR cloud base at that point.

The forecast slider steps through the HRRR hours. Outside the US the satellite clouds stay at the current time.

### Where the data comes from

The GitHub workflow runs the pipeline every hour (`17 * * * *`) and deploys the result with the site under `data/`. If the data step fails on a scheduled run, the previous deployment is kept. Each run takes about 5 minutes, which is free for **public** repos. A private repo would use roughly 3,600 of its 2,000 free Actions minutes a month, so for a private repo change the cron to every 2–3 hours or lower `HRRR_FMAX`.

To run the pipeline locally (Python 3.10+):

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_clouds.py --out public/data --fmax 3
npm run dev
```

You can also point a local dev server at your deployed data: `http://localhost:5173/?data=https://<user>.github.io/<repo>/data/`.

## Units

The **Controls & debug** section has a Metric / Imperial toggle. It changes the altitude readout and the cloud-top height and temperature shown under the cursor. The default follows your browser's language setting, and your choice is saved in the URL.

## Controls

Drag to pan. Scroll or pinch to zoom toward the cursor. Right-drag or Shift-drag to rotate and tilt. Double-click to fly in. The compass button resets north and tilt.

The current view is saved in the URL hash, so you can share links to specific views.

## How it works

```
src/
  main.js                 renderer, UI, URL state, render loop
  globe/
    geo.js                lon/lat ↔ xyz, Web Mercator tile math (units: km)
    TileGlobe.js          quadtree LOD tile streaming
    GlobeControls.js      map-style camera (target, distance, heading, tilt)
    sky.js                atmosphere limb glow, star field
    sources.js            imagery providers
  clouds/
    cloudData.js          satellite IR → global cloud cover / top-height grid
    irColormap.js         GIBS Band 13 colour → brightness temperature
    CloudLayer.js         stacked-shell 3D cloud renderer (HRRR in the US, IR elsewhere)
    levels.js             shell heights (shared with the pipeline)
    modelData.js          loads the HRRR atlas + METAR stations
    StationLayer.js       METAR 3D markers
pipeline/
  build_clouds.py         HRRR + METAR → cloud volume (runs hourly in GitHub Actions)
  tests/make_fixtures.py  fake HRRR GRIB + METAR files for offline testing
  units.js                metric / imperial formatting
```

- **Units and frame:** 1 unit = 1 km. Earth's radius is 6371 and it sits at the origin, with +Y pointing to the north pole. Weather layers can use `lonLatToVec3(lon, lat, EARTH_RADIUS + altitudeKm × exaggeration)`.
- **Tiles:** each frame the code walks the Web Mercator quadtree from zoom 0. It skips tiles behind the horizon or outside the view, and splits a tile when its 256 px image would cover more than about 384 px on screen. While a tile is still loading, the loaded parent or children are drawn in its place. Zoom levels 0–2 always stay loaded as a fallback.
- **Precision:** tile vertices are stored relative to each tile's center, so the globe doesn't jitter at street level when using float32.
- **Poles:** Web Mercator stops at ±85.05°. The area beyond that is covered with a cap in a color that matches the layer.

## Roadmap

1. GFS data pipeline: a GitHub Action every 6 h downloads selected fields from NOAA GFS (AWS Open Data) using `herbie`, saves them as compact PNG/binary grids and publishes them with the site.
2. Surface temperature and precipitation heatmap, plus a forecast-hour slider.
3. Wind particles at 10 m, 850 hPa and 250 hPa.
4. ~~3D clouds~~ (done: satellite IR worldwide, HRRR + METAR over the US); next, GFS for global forecast clouds.
5. Convection towers scaled by CAPE (HRRR is already downloaded, so this just needs a few more fields).
6. Click anywhere in the US for the NWS point forecast (api.weather.gov).
