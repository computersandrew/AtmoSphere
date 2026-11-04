"""Build a fake HRRR-like dataset (coarse Lambert GRIB2 + .idx) and a METAR cache CSV
so the pipeline can be tested offline. Serves files with HTTP Range support."""
import gzip, os, sys, math, datetime as dt
import numpy as np, eccodes

OUT = sys.argv[1]
CYCLE = dt.datetime(2026, 11, 3, 1)
NX, NY, DX = 180, 106, 30000.0
PRESSURES = list(range(50, 1001, 25)) + [1013.2]

def lcc_latlon():
    # same projection as HRRR: LoV 262.5, Latin1=Latin2=38.5, first point 21.138N 237.28E
    import numpy as np
    R=6371229.0; phi1=math.radians(38.5); lon0=math.radians(262.5-360)
    n=math.sin(phi1); F=math.cos(phi1)*math.tan(math.pi/4+phi1/2)**n/n
    rho=lambda phi: R*F/math.tan(math.pi/4+phi/2)**n
    rho0=rho(phi1)
    la1,lo1=math.radians(21.138123),math.radians(237.280472-360)
    x0=rho(la1)*math.sin(n*(lo1-lon0)); y0=rho0-rho(la1)*math.cos(n*(lo1-lon0))
    X=x0+np.arange(NX)*DX; Y=y0+np.arange(NY)*DX
    X,Y=np.meshgrid(X,Y)
    r=np.sign(n)*np.hypot(X,rho0-Y); th=np.arctan2(X,rho0-Y)
    lat=2*np.arctan((R*F/r)**(1/n))-math.pi/2; lon=lon0+th/n
    return np.degrees(lat), np.degrees(lon)

def make_msg(field, plev, values):
    g = eccodes.codes_grib_new_from_samples("GRIB2")
    eccodes.codes_set(g, "gridType", "lambert")
    for k, v in [("Nx", NX), ("Ny", NY), ("latitudeOfFirstGridPointInDegrees", 21.138123),
                 ("longitudeOfFirstGridPointInDegrees", 237.280472), ("LaDInDegrees", 38.5),
                 ("LoVInDegrees", 262.5), ("Latin1InDegrees", 38.5), ("Latin2InDegrees", 38.5),
                 ("DxInMetres", DX), ("DyInMetres", DX), ("shapeOfTheEarth", 6)]:
        eccodes.codes_set(g, k, v)
    eccodes.codes_set(g, "typeOfLevel", "isobaricInhPa")
    eccodes.codes_set(g, "level", int(plev))
    eccodes.codes_set(g, "packingType", "grid_simple")
    eccodes.codes_set(g, "bitsPerValue", 24)
    eccodes.codes_set_values(g, values.ravel().astype(float))
    msg = eccodes.codes_get_message(g); eccodes.codes_release(g); return msg

lat, lon = lcc_latlon()
os.makedirs(f"{OUT}/hrrr.{CYCLE:%Y%m%d}/conus", exist_ok=True)
def std_height(p):  # m
    return 44330.8 * (1 - (p / 1013.25) ** 0.190263)
for fh in range(0, 4):
    data = bytearray(); idx = []; n = 1
    shift = fh * 2.0
    for p in PRESSURES:
        z = std_height(p) + 30 * np.sin(np.radians(lat * 3))
        # Cloud blobs: a low stratus deck over the Midwest (850-925 hPa), a deep storm over Texas,
        # cirrus over the Northwest (250-300 hPa)
        q = np.zeros_like(lat)
        def blob(clat, clon, r): return np.exp(-(((lat - clat) / r) ** 2 + ((lon - clon - shift) / (r * 1.3)) ** 2))
        if 850 <= p <= 925: q += 2e-4 * blob(41, -90, 3)
        if 200 <= p <= 900: q += 3e-4 * blob(31, -98, 1.5)
        if 250 <= p <= 300: q += 5e-5 * blob(46, -120, 4)
        for var, val in [("HGT", z), ("TMP", z * 0 + 250), ("CLMR", q * (p > 500)), ("CIMIXR", q * (p <= 500)), ("SNMR", q * 0.1)]:
            m = make_msg(var, p, val)
            lev = f"{p} mb" if p != 1013.2 else "1013.2 mb"
            idx.append(f"{n}:{len(data)}:d={CYCLE:%Y%m%d%H}:{var}:{lev}:{'anl' if fh == 0 else f'{fh} hour fcst'}:")
            data += m; n += 1
    base = f"{OUT}/hrrr.{CYCLE:%Y%m%d}/conus/hrrr.t{CYCLE:%H}z.wrfprsf{fh:02d}.grib2"
    open(base, "wb").write(data); open(base + ".idx", "w").write("\n".join(idx) + "\n")

hdr = ("raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,"
       "visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,corrected,auto,auto_station,maintenance_indicator_on,no_signal,"
       "lightning_sensor_off,freezing_rain_sensor_off,present_weather_sensor_off,wx_string,sky_cover,cloud_base_ft_agl,sky_cover,"
       "cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,flight_category,three_hr_pressure_tendency_mb,"
       "maxT_c,minT_c,maxT24hr_c,minT24hr_c,precip_in,pcp3hr_in,pcp6hr_in,pcp24hr_in,snow_in,vert_vis_ft,metar_type,elevation_m")
def row(sid, la, lo, elev, layers, vv=""):
    sky = []
    for c, b in (layers + [("", "")] * 4)[:4]: sky += [c, str(b)]
    raw = f'"METAR {sid} 030050Z AUTO {" ".join(c + str(b // 100).zfill(3) if b != "" else c for c, b in layers)}"'
    cols = [raw, sid, "2026-11-03T00:50:00.000Z", str(la), str(lo)] + [""] * 17 + sky + ["VFR"] + [""] * 10 + [vv, "METAR", str(elev)]
    return ",".join(cols)
rows = [hdr,
        row("KORD", 41.98, -87.9, 205, [("BKN", 2500), ("OVC", 4000)]),  # deck lower than model
        row("KMSP", 44.88, -93.2, 256, [("CLR", "")]),                    # clear where model has cloud
        row("KDFW", 32.9, -97.04, 185, [("SCT", 1500), ("BKN", 6000)]),
        row("KDEN", 39.86, -104.67, 1655, [("FEW", 9000)]),
        row("PTRO", 7.367, 134.544, 30, [("SCT", 1600), ("BKN", 13000)]),
        row("KXXX", -99.99, -99.99, 9999, [("BKN", 1000)])]
os.makedirs(f"{OUT}/metar", exist_ok=True)
open(f"{OUT}/metar/metars.cache.csv.gz", "wb").write(gzip.compress("\n".join(rows).encode()))
print("fixtures written")
