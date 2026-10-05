"""Independent reference values from astropy, used to test the TypeScript engine.

Kept in Python on purpose: the point is a second implementation that shares no
code with lib/, so a bug in one shows up as a disagreement with the other.
"""
import json, random, sys
import astropy.units as u
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, get_sun

random.seed(7)
E = json.load(open("data/exoclock_planets.json"))
names = sorted(E)
pick = random.sample(names, 50)
site = dict(lat=32.8801, lon=-117.2340, h=100.0)  # La Jolla
loc = EarthLocation(lat=site["lat"] * u.deg, lon=site["lon"] * u.deg, height=site["h"] * u.m)
out = {"site": site, "cases": []}
for i, n in enumerate(pick):
    v = E[n]
    c = SkyCoord(v["ra_j2000"], v["dec_j2000"], unit=(u.hourangle, u.deg))
    # a midtime between 2024 and 2028
    bjd = 2460310.5 + random.random() * 1461
    t = Time(bjd, format="jd", scale="tdb", location=loc)
    ltt = t.light_travel_time(c, kind="barycentric")
    utc = (t - ltt).utc
    # second pass: light time evaluated at arrival, matching the TS iteration
    ltt2 = (t - ltt).light_travel_time(c, kind="barycentric")
    utc = (t - ltt2).utc
    fr = AltAz(obstime=utc, location=loc)
    alt = c.transform_to(fr).alt.deg
    sun = get_sun(utc).transform_to(fr).alt.deg
    # HJD_UTC -> BJD_TDB reference: treat the same instant as HJD_UTC
    hjd_utc = Time(bjd, format="jd", scale="utc", location=loc)
    lt_h = hjd_utc.light_travel_time(c, kind="heliocentric")
    jd_geo_utc = hjd_utc - lt_h
    lt_b = jd_geo_utc.tdb.light_travel_time(c, kind="barycentric")
    bjd_from_hjd = (jd_geo_utc.tdb + lt_b).jd
    out["cases"].append({
        "name": n, "raDeg": c.ra.deg, "decDeg": c.dec.deg, "bjdTdb": bjd,
        "jdUtc": utc.jd, "lightTimeSec": ltt2.to(u.s).value,
        "altDeg": float(alt), "sunAltDeg": float(sun),
        "hjdUtcInput": bjd, "bjdTdbFromHjdUtc": bjd_from_hjd,
    })
json.dump(out, open("tests/fixtures/astropy-oracle.json", "w"), indent=1)
print(len(out["cases"]), "cases")
