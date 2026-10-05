"""Question set and ground truth for the three-arm evaluation.

Ground truth is computed here, in Python with astropy, from the ExoClock
catalogue directly. It shares no code with lib/ (TypeScript), so the agent is
graded against an independent implementation, not against itself.

Truth for a midtime is ExoClock's current ephemeris propagated to the date.
That is a choice, stated in the post: ExoClock is the only source fitted to
transits observed this decade. Planets where our own selection rule would not
pick ExoClock, and TTV systems, are excluded from timing questions so the
truth is not contestable.

  python3 eval/build_questions.py   (needs astropy; writes eval/questions.json)
"""
import csv, json, random
from pathlib import Path
import numpy as np
import astropy.units as u
from astropy.time import Time
from astropy.coordinates import SkyCoord, EarthLocation, AltAz, get_sun

ROOT = Path(__file__).resolve().parent.parent
exo = json.load(open(ROOT / "data/exoclock_planets.json"))
cat = json.load(open(ROOT / "data/catalog.json"))
P = {p["name"]: p for p in cat["planets"] if p["exoclock"]}

def exo_trusted(p):
    exo_c = next(c for c in p["candidates"] if c["origin"] == "exoclock")
    return p["selection"]["chosenId"] == exo_c["id"] and not p["ttv"]

def default_offset(p):
    s = {a["candidateId"]: a for a in p["selection"]["assessments"]}
    d = next((c for c in p["candidates"] if c["isArchiveDefault"]), None)
    return None if d is None else s[d["id"]]["offsetMin"]

SITE = dict(name="La Jolla, California", lat=32.8801, lon=-117.2340, h=100.0)
loc = EarthLocation(lat=SITE["lat"] * u.deg, lon=SITE["lon"] * u.deg, height=SITE["h"] * u.m)

def coord(v):
    return SkyCoord(v["ra_j2000"], v["dec_j2000"], unit=(u.hourangle, u.deg))

def next_mid_utc(name, after_utc):
    v = exo[name]
    c = coord(v)
    t_after = Time(after_utc, scale="utc")
    T0, Pd = v["ephem_mid_time"], v["ephem_period"]
    # Search a few epochs around; convert each BJD_TDB to geocentric UTC.
    k0 = int(np.floor((t_after.tdb.jd - T0) / Pd)) - 1
    for k in range(k0, k0 + 6):
        t = Time(T0 + k * Pd, format="jd", scale="tdb", location=loc)
        utc = (t - t.light_travel_time(c, kind="barycentric")).utc
        if utc > t_after:
            sig = float(np.hypot(abs(v["ephem_mid_time_e1"]), k * abs(v["ephem_period_e1"])) * 1440)
            return utc, sig
    raise RuntimeError(name)

def full_transit_visible(name, mid_utc):
    v = exo[name]
    c = coord(v)
    half = v["duration_hours"] / 2 + 0.5  # 30 min baseline each side
    times = mid_utc + np.linspace(-half, half, 25) * u.hour
    fr = AltAz(obstime=times, location=loc)
    return bool(c.transform_to(fr).alt.deg.min() >= 30 and get_sun(times).transform_to(fr).alt.deg.max() <= -12)

random.seed(20261004)
eligible = sorted(n for n, p in P.items() if exo_trusted(p) and default_offset(p) is not None)
# Timing questions: half where the NASA default is badly off, half where it is fine,
# so a system that always distrusts the archive gains nothing.
bad = [n for n in eligible if abs(default_offset(P[n])) >= 10]
good = [n for n in eligible if abs(default_offset(P[n])) < 2]
must = [n for n in ["HAT-P-37b", "KELT-9b", "WASP-12b", "HD97658b", "KELT-18b", "GJ436b"] if n in eligible]
timing = must + random.sample([n for n in bad if n not in must], 14 - len(must)) + random.sample(good, 14)
random.shuffle(timing)

questions = []
after = "2026-10-06T00:00:00"
for i, n in enumerate(timing):
    mid, sig = next_mid_utc(n, after)
    questions.append({
        "id": f"T{i+1:02d}", "kind": "midtime", "planet": n,
        "question": f"When is the mid-transit time of {n} for the first transit after {after} UTC? Answer with the UTC time to the minute.",
        "truth": {"midUtc": mid.isot[:19] + "Z", "sigmaMin": round(sig, 2), "toleranceMin": min(5.0, max(2.0, round(3 * sig, 1)))},
        "defaultOffsetMin": round(default_offset(P[n]), 2),
    })

# Observability questions: the set of planets with a full transit visible from
# La Jolla on a given night, deeper than a threshold and bright enough.
def observable_set(night, depth, vmax):
    start = Time(f"{night}T01:00:00", scale="utc")  # 6 pm PDT
    end = Time(f"{night}T14:00:00", scale="utc")    # 7 am PDT next morning
    found = []
    for n in eligible:
        v = exo[n]
        if (v["depth_r_mmag"] or 0) < depth or (v["v_mag"] or 99) > vmax:
            continue
        mid, _ = next_mid_utc(n, start.isot)
        if mid <= end and full_transit_visible(n, mid):
            found.append(n)
    return sorted(found)

nights = ["2026-10-06", "2026-10-09", "2026-10-13", "2026-10-17", "2026-10-21", "2026-10-25"]
for j, night in enumerate(nights):
    # Pick the strictest thresholds that still leave 2 to 8 planets, so "none"
    # is never the answer and a list cannot be guessed.
    for depth, vmax in [(20, 11.5), (15, 11.5), (15, 12.5), (10, 12.5), (8, 13.0), (5, 13.0)]:
        found = observable_set(night, depth, vmax)
        if 2 <= len(found) <= 8:
            break
    questions.append({
        "id": f"O{j+1:02d}", "kind": "observable",
        "question": (
            f"Which planets have a complete transit (plus 30 minutes before and after) visible from {SITE['name']} "
            f"on the night starting {night} local time, with the planet above 30 degrees and the Sun below -12 degrees "
            f"the whole time, transit depth at least {depth} mmag and host star V magnitude {vmax} or brighter? "
            f"Only consider planets the ExoClock project monitors."
        ),
        "truth": {"planets": found},
        "params": {"night": night, "depthMmag": depth, "vmagMax": vmax, "site": SITE},
    })

# Source-trust questions: which solution to use, and how far off the NASA default is.
trust = must + random.sample([n for n in bad if n not in must], 2)
for k, n in enumerate(trust + ["XO-3b"] if "XO-3b" not in trust else trust):
    p = P.get(n)
    if not p:
        continue
    questions.append({
        "id": f"S{k+1:02d}", "kind": "trust", "planet": n,
        "question": (
            f"For {n}, which published timing solution should an observer use tonight, and by how many minutes "
            f"does the NASA Exoplanet Archive default solution disagree with it at the next transit?"
        ),
        "truth": {
            "chosenOrigin": next(c for c in p["candidates"] if c["id"] == p["selection"]["chosenId"])["origin"],
            "defaultOffsetMin": round(default_offset(p), 1),
            "toleranceMin": max(2.0, abs(default_offset(p)) * 0.1),
        },
    })

# Trend questions with documented answers.
questions += [
    {"id": "D01", "kind": "trend", "planet": "WASP-12b",
     "question": "Is the orbital period of WASP-12b changing, and if so, is it getting shorter or longer?",
     "truth": {"answer": "shorter", "source": "Yee et al. 2020; Turner et al. 2021"}},
    {"id": "D02", "kind": "trend", "planet": "WASP-4b",
     "question": "Do published timing studies agree on whether WASP-4b's transits drift from a constant period?",
     "truth": {"answer": "disputed", "source": "Baluev et al. 2020 vs later TESS analyses"}},
]

held_out = set(random.sample([q["id"] for q in questions], 10))
for q in questions:
    q["split"] = "held-out" if q["id"] in held_out else "dev"
json.dump({"site": SITE, "builtFrom": "ExoClock catalogue + astropy", "questions": questions},
          open(ROOT / "eval/questions.json", "w"), indent=1)
from collections import Counter
print(len(questions), Counter(q["kind"] for q in questions), Counter(q["split"] for q in questions))
for q in questions[:3] + [q for q in questions if q["kind"] == "observable"][:2]:
    print(q["id"], q.get("planet"), q["truth"])
