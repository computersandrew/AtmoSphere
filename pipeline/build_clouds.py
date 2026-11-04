#!/usr/bin/env python3
"""
HRRR + METAR → 3D cloud volume for the Weather Globe.

For the newest complete HRRR cycle this script
  1. downloads only the needed GRIB2 messages (HGT, CLMR, CIMIXR, SNMR on pressure
     levels) from NOAA's AWS bucket using the .idx byte offsets (~40 MB per hour
     instead of the full ~400 MB file),
  2. regrids the 3 km Lambert grid to a regular lat/lon grid and interpolates the
     cloud condensate from pressure levels to fixed heights above sea level,
  3. corrects the analysis near the ground with METAR ceilometer cloud bases
     (influence fades with distance and forecast hour),
  4. writes one greyscale PNG "atlas" per forecast hour (one tile per height level),
     a coverage mask, a manifest, and the METAR stations for the 3D markers.

Usage:
  python pipeline/build_clouds.py --out public/data            # live data
  python pipeline/build_clouds.py --out public/data --fmax 6   # fewer forecast hours
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import sys
import tempfile
import time

import eccodes
import numpy as np
import requests
from PIL import Image
from scipy.spatial import cKDTree

# ----------------------------------------------------------------------------- config
HRRR_BASE = os.environ.get("HRRR_BASE", "https://noaa-hrrr-bdp-pds.s3.amazonaws.com")
METAR_URL = os.environ.get("METAR_URL", "https://aviationweather.gov/data/cache/metars.cache.csv.gz")
USER_AGENT = "weather-globe-pipeline/1.0 (+https://github.com)"

# Output heights (km above sea level). Must match src/clouds/levels.js.
LEVELS_KM = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0,
             5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0]

# Output lat/lon grid covering the HRRR CONUS domain. Row 0 = north.
LON0, LON1, LAT0, LAT1, RES = -134.5, -60.5, 21.0, 53.0, 0.1
ATLAS_COLS = 6

PRESSURES = list(range(100, 1001, 25))  # hPa
FIELDS = ["HGT", "CLMR", "CIMIXR", "SNMR"]

# METAR correction
METAR_RADIUS_KM = 40.0          # Gaussian length scale
METAR_CUTOFF = 3.0              # × radius
CEILOMETER_LIMIT_KM = 3.66      # automated stations report up to 12,000 ft
COVER_FRACTION = {"FEW": 0.2, "SCT": 0.45, "BKN": 0.75, "OVC": 1.0, "OVX": 1.0}
CLEAR_CODES = {"CLR", "SKC", "NSC", "NCD", "CAVOK"}

log = lambda *a: print(*a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- http
def session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def get(s, url, retries=4, **kw):
    for attempt in range(retries):
        try:
            r = s.get(url, timeout=60, **kw)
            if r.status_code in (200, 206):
                return r
            if r.status_code == 404:
                return None
            log(f"  HTTP {r.status_code} for {url}")
        except requests.RequestException as e:
            log(f"  {e.__class__.__name__} for {url}")
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}")


# ----------------------------------------------------------------------------- HRRR
def grib_url(cycle: dt.datetime, fh: int) -> str:
    return f"{HRRR_BASE}/hrrr.{cycle:%Y%m%d}/conus/hrrr.t{cycle:%H}z.wrfprsf{fh:02d}.grib2"


def parse_idx(text: str):
    """wgrib2 inventory → list of (start, end|None, var, level)."""
    rows = []
    for line in text.strip().splitlines():
        p = line.split(":")
        if len(p) < 6:
            continue
        rows.append([int(p[1]), None, p[3], p[4]])
    for i in range(len(rows) - 1):
        rows[i][1] = rows[i + 1][0] - 1
    return rows


def find_cycle(s, fmax: int, now: dt.datetime | None = None) -> dt.datetime:
    """Newest cycle whose last wanted forecast hour is already published."""
    now = now or dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    base = now.replace(minute=0, second=0, microsecond=0)
    for back in range(0, 8):
        cycle = base - dt.timedelta(hours=back)
        if get(s, grib_url(cycle, fmax) + ".idx", retries=2) is not None:
            return cycle
    raise RuntimeError("no complete HRRR cycle found in the last 8 hours")


def download_fields(s, cycle, fh, dest):
    """Byte-range download of the wanted messages. Returns [(var, hPa)] in file order."""
    idx = get(s, grib_url(cycle, fh) + ".idx")
    if idx is None:
        raise RuntimeError(f"missing idx for f{fh:02d}")
    wanted = []
    for start, end, var, level in parse_idx(idx.text):
        m = re.fullmatch(r"(\d+) mb", level)
        if var in FIELDS and m and int(m.group(1)) in PRESSURES:
            wanted.append((start, end, var, int(m.group(1))))
    # Merge adjacent ranges into fewer requests.
    ranges = []
    for start, end, *_ in wanted:
        if ranges and ranges[-1][1] is not None and ranges[-1][1] + 1 == start:
            ranges[-1][1] = end
        else:
            ranges.append([start, end])
    with open(dest, "wb") as f:
        for start, end in ranges:
            hdr = {"Range": f"bytes={start}-{'' if end is None else end}"}
            r = get(s, grib_url(cycle, fh), headers=hdr)
            f.write(r.content)
    return [(v, p) for *_, v, p in wanted]


def read_grib(path, order):
    """Read messages in file order; returns dict[(var, hPa)] -> 2D array, plus lat/lon."""
    out, lat, lon = {}, None, None
    with open(path, "rb") as f:
        for key in order:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                raise RuntimeError("GRIB file ended early")
            try:
                ni = eccodes.codes_get(gid, "Ni")
                nj = eccodes.codes_get(gid, "Nj")
                vals = eccodes.codes_get_values(gid).reshape(nj, ni)
                if lat is None:
                    lat = eccodes.codes_get_array(gid, "latitudes").reshape(nj, ni)
                    lon = eccodes.codes_get_array(gid, "longitudes").reshape(nj, ni)
                out[key] = vals.astype(np.float32)
            finally:
                eccodes.codes_release(gid)
    lon = np.where(lon > 180, lon - 360, lon)
    return out, lat, lon


# ----------------------------------------------------------------------------- regridding
def target_grid():
    nx = int(round((LON1 - LON0) / RES))
    ny = int(round((LAT1 - LAT0) / RES))
    lons = LON0 + (np.arange(nx) + 0.5) * RES
    lats = LAT1 - (np.arange(ny) + 0.5) * RES
    return nx, ny, *np.meshgrid(lons, lats)


def unit_xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


class Regridder:
    """Average of the k nearest source points (on the sphere) for every target cell."""

    def __init__(self, src_lat, src_lon, tgt_lat, tgt_lon, k=9):
        src = unit_xyz(src_lat.ravel(), src_lon.ravel())
        tgt = unit_xyz(tgt_lat.ravel(), tgt_lon.ravel())
        # Approximate source spacing (km) from neighbouring points.
        spacing = float(np.median(np.hypot(np.diff(src_lat[:, :2], axis=1), np.diff(src_lon[:, :2], axis=1)))) * 111.0
        tree = cKDTree(src)
        dist, self.idx = tree.query(tgt, k=k, workers=-1)
        dist_km = dist[:, 0] * 6371.0
        self.valid = (dist_km < max(spacing, RES * 111) * 1.5).reshape(tgt_lat.shape)
        self.shape = tgt_lat.shape

    def __call__(self, field):
        flat = field.ravel()[self.idx].mean(axis=1)
        return flat.reshape(self.shape)


# ----------------------------------------------------------------------------- physics
def condensate_to_fraction(q):
    """Cloud condensate mixing ratio (kg/kg) → 0..1 'cloudiness' (log ramp 3e-6 … 1e-4)."""
    return np.clip((np.log10(np.maximum(q, 1e-12)) + 5.5) / 1.5, 0.0, 1.0)


def to_height_levels(frac_p, z_p, levels_km):
    """frac_p, z_p: (P, ny, nx) ordered bottom→top. Linear interpolation in height."""
    P = frac_p.shape[0]
    out = np.zeros((len(levels_km), *frac_p.shape[1:]), np.float32)
    for li, L in enumerate(np.asarray(levels_km) * 1000.0):
        res = np.zeros(frac_p.shape[1:], np.float32)
        done = np.zeros(frac_p.shape[1:], bool)
        for i in range(P - 1):
            z0, z1 = z_p[i], z_p[i + 1]
            inside = (~done) & (z0 <= L) & (L < z1)
            t = np.where(inside, (L - z0) / np.maximum(z1 - z0, 1.0), 0)
            res = np.where(inside, frac_p[i] + t * (frac_p[i + 1] - frac_p[i]), res)
            done |= inside
        out[li] = res
    return out


# ----------------------------------------------------------------------------- METAR
def fetch_metars(s):
    r = get(s, METAR_URL)
    text = gzip.decompress(r.content).decode("utf-8", "replace")
    return parse_metar_csv(text)


def parse_metar_csv(text):
    rows = list(csv.reader(io.StringIO(text)))
    header_i = next(i for i, r in enumerate(rows) if r and r[0] == "raw_text")
    h = rows[header_i]
    col = {name: h.index(name) for name in h}
    sky = [i for i, n in enumerate(h) if n == "sky_cover"]
    base = [i for i, n in enumerate(h) if n == "cloud_base_ft_agl"]
    stations = {}
    for r in rows[header_i + 1:]:
        if len(r) < len(h):
            continue
        try:
            lat, lon = float(r[col["latitude"]]), float(r[col["longitude"]])
            elev = float(r[col["elevation_m"]] or "nan")
        except ValueError:
            continue
        if lat < -90 or abs(lon) > 180 or not math.isfinite(elev) or elev > 9000:
            continue
        layers, clear = [], False
        for si, bi in zip(sky, base):
            cover = r[si].strip()
            if cover in CLEAR_CODES:
                clear = True
            elif cover in COVER_FRACTION and r[bi].strip():
                layers.append([cover, round(float(r[bi]) * 0.3048)])  # m AGL
        vv = r[col["vert_vis_ft"]].strip() if "vert_vis_ft" in col else ""
        if vv:
            layers.append(["OVX", round(float(vv) * 0.3048)])
        if not layers and not clear:
            continue  # no sky info
        sid = r[col["station_id"]]
        obs = r[col["observation_time"]]
        # Keep the newest report per station.
        if sid in stations and stations[sid]["time"] >= obs:
            continue
        stations[sid] = {
            "id": sid, "lat": round(lat, 4), "lon": round(lon, 4), "elev": round(elev),
            "time": obs, "raw": r[col["raw_text"]],
            "layers": sorted(layers, key=lambda l: l[1]), "clear": clear and not layers,
        }
    return list(stations.values())


def observed_profile(st, levels_km):
    """Observed cloud fraction at each level + mask of levels the ceilometer can judge."""
    L = np.asarray(levels_km) * 1000.0 - st["elev"]  # m AGL
    obs = np.zeros(len(L), np.float32)
    valid = (L >= 0) & (L <= CEILOMETER_LIMIT_KM * 1000)
    blocked_above = None
    for cover, base in st["layers"]:
        frac = COVER_FRACTION[cover]
        thick = 600 if frac >= 0.75 else 400
        hit = (L >= base - 125) & (L <= base + thick)
        if not hit.any():  # thin layer between levels: mark the nearest one
            hit = np.abs(L - base) == np.abs(L - base).min()
        obs = np.where(hit, np.maximum(obs, frac), obs)
        if frac >= 0.75 and blocked_above is None:
            blocked_above = base + thick
    if blocked_above is not None:
        valid &= L <= blocked_above  # can't see above a broken/overcast deck
    return obs, valid


def metar_correction(stations, lat2d, lon2d, model, levels_km, record=False):
    """Successive-correction increments (levels, ny, nx) from station minus model."""
    nl, ny, nx = model.shape
    num = np.zeros_like(model)
    den = np.zeros_like(model)
    r = METAR_RADIUS_KM
    cut = METAR_CUTOFF * r
    used = 0
    for st in stations:
        if not (LAT0 <= st["lat"] <= LAT1 and LON0 <= st["lon"] <= LON1):
            continue
        j = int((LAT1 - st["lat"]) / RES)
        i = int((st["lon"] - LON0) / RES)
        if not (0 <= j < ny and 0 <= i < nx):
            continue
        obs, valid = observed_profile(st, levels_km)
        if not valid.any():
            continue
        inc = np.where(valid, obs - model[:, j, i], 0.0)
        if record:
            st["model_base_m"] = model_base(model[:, j, i], levels_km, st["elev"])
        dj = int(cut / 111.0 / RES) + 1
        di = int(cut / (111.0 * max(math.cos(math.radians(st["lat"])), 0.2)) / RES) + 1
        j0, j1, i0, i1 = max(0, j - dj), min(ny, j + dj + 1), max(0, i - di), min(nx, i + di + 1)
        dy = (lat2d[j0:j1, i0:i1] - st["lat"]) * 111.0
        dx = (lon2d[j0:j1, i0:i1] - st["lon"]) * 111.0 * math.cos(math.radians(st["lat"]))
        g = np.exp(-(dx * dx + dy * dy) / (r * r))
        g[np.hypot(dx, dy) > cut] = 0
        gv = g[None] * valid[:, None, None]
        num[:, j0:j1, i0:i1] += gv * inc[:, None, None]
        den[:, j0:j1, i0:i1] += gv
        used += 1
    weight = np.minimum(den, 1.0)
    corr = np.where(den > 0, num / np.maximum(den, 1e-6), 0) * weight
    return corr, used


def model_base(profile, levels_km, elev_m):
    for f, L in zip(profile, levels_km):
        if L * 1000 >= elev_m and f >= 0.5:
            return round(L * 1000 - elev_m)
    return None


# ----------------------------------------------------------------------------- output
def write_atlas(vol, path):
    nl, ny, nx = vol.shape
    rows = math.ceil(nl / ATLAS_COLS)
    atlas = np.zeros((rows * ny, ATLAS_COLS * nx), np.uint8)
    for k in range(nl):
        r, c = divmod(k, ATLAS_COLS)
        atlas[r * ny:(r + 1) * ny, c * nx:(c + 1) * nx] = np.round(np.clip(vol[k], 0, 1) * 255)
    Image.fromarray(atlas, "L").save(path, optimize=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--fmax", type=int, default=int(os.environ.get("HRRR_FMAX", 12)))
    ap.add_argument("--cycle", help="YYYYMMDDHH (default: newest complete)")
    ap.add_argument("--no-metar", action="store_true")
    args = ap.parse_args()

    s = session()
    hrrr_dir = os.path.join(args.out, "hrrr")
    os.makedirs(hrrr_dir, exist_ok=True)
    os.makedirs(os.path.join(args.out, "metar"), exist_ok=True)

    cycle = dt.datetime.strptime(args.cycle, "%Y%m%d%H") if args.cycle else find_cycle(s, args.fmax)
    log(f"HRRR cycle {cycle:%Y-%m-%d %HZ}, forecast hours 0–{args.fmax}")

    stations = []
    if not args.no_metar:
        try:
            stations = fetch_metars(s)
            # Only reports from around the analysis time.
            lo = (cycle - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M")
            stations = [st for st in stations if st["time"][:16] >= lo]
            log(f"METAR: {len(stations)} stations with sky reports")
        except Exception as e:  # METAR is an enhancement; never fail the run for it
            log(f"METAR unavailable: {e}")

    nx, ny, tlon, tlat = target_grid()
    regrid = None
    forecast = []
    with tempfile.TemporaryDirectory() as tmp:
        for fh in range(args.fmax + 1):
            t0 = time.time()
            path = os.path.join(tmp, f"f{fh:02d}.grib2")
            order = download_fields(s, cycle, fh, path)
            fields, lat, lon = read_grib(path, order)
            os.remove(path)
            if regrid is None:
                regrid = Regridder(lat, lon, tlat, tlon)
                mask = regrid.valid.astype(np.uint8) * 255
                Image.fromarray(mask, "L").save(os.path.join(hrrr_dir, "mask.png"), optimize=True)

            plevs = sorted({p for _, p in order}, reverse=True)  # bottom → top
            frac_p = np.stack([
                regrid(condensate_to_fraction(
                    fields[("CLMR", p)] + fields[("CIMIXR", p)] + 0.3 * fields.get(("SNMR", p), 0)))
                for p in plevs])
            z_p = np.stack([regrid(fields[("HGT", p)]) for p in plevs])
            vol = to_height_levels(frac_p, z_p, LEVELS_KM)

            if stations:
                corr, used = metar_correction(stations, tlat, tlon, vol, LEVELS_KM, record=fh == 0)
                w = math.exp(-fh / 3.0)  # observations matter less further into the forecast
                vol = np.clip(vol + w * corr, 0, 1)
                if fh == 0:
                    log(f"  METAR correction from {used} stations")

            vol *= regrid.valid[None]
            name = f"f{fh:02d}.png"
            write_atlas(vol, os.path.join(hrrr_dir, name))
            valid_time = cycle + dt.timedelta(hours=fh)
            forecast.append({"fh": fh, "valid": valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"), "file": name})
            log(f"  f{fh:02d} done in {time.time() - t0:.1f}s")

    manifest = {
        "model": "HRRR",
        "cycle": cycle.strftime("%Y-%m-%dT%H:00:00Z"),
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grid": {"lon0": LON0, "lon1": LON1, "lat0": LAT0, "lat1": LAT1, "nx": nx, "ny": ny},
        "levelsKm": LEVELS_KM,
        "atlas": {"cols": ATLAS_COLS, "rows": math.ceil(len(LEVELS_KM) / ATLAS_COLS)},
        "forecast": forecast,
        "metar": {"stations": len(stations), "radiusKm": METAR_RADIUS_KM},
    }
    with open(os.path.join(hrrr_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    with open(os.path.join(args.out, "metar", "stations.json"), "w") as f:
        json.dump({"generated": manifest["generated"], "stations": stations}, f, separators=(",", ":"))
    log("done")


if __name__ == "__main__":
    main()
