"""
Parking Intelligence — API + web app.
    python pipeline.py        (once, builds ./data)
    uvicorn server:app --port 8000
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

DATA = Path(__file__).parent / "data"
WEB = Path(__file__).parent / "web"

df = pd.read_parquet(DATA / "records.parquet")
HOTSPOTS = json.loads((DATA / "hotspots.json").read_text())
FORECAST = json.loads((DATA / "forecast.json").read_text())
META = json.loads((DATA / "meta.json").read_text())
N_DAYS = META["dataset"]["days"]
HEAT_GRID = 0.001  # ~110 m bins for the heat layer

app = FastAPI(title="Parking Intelligence API")


@app.middleware("http")
async def no_stale_assets(request, call_next):
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-cache"  # revalidate so edits show up
    return resp


def split(v):
    return [s for s in (v or "").split("|") if s]


def apply_filters(stations, vgroups, offences, h0, h1, days):
    m = df["hour"].between(h0, h1)
    if stations:
        m &= df["police_station"].isin(stations)
    if vgroups:
        m &= df["vgroup"].isin(vgroups)
    if offences:
        m &= df["offence"].isin(offences)
    if days:
        m &= df["dow"].isin([int(d) for d in days])
    return df[m]


@app.get("/api/meta")
def meta():
    return META


@app.get("/api/overview")
def overview(stations: str = "", vgroups: str = "", offences: str = "",
             h0: int = Query(0, ge=0, le=23), h1: int = Query(23, ge=0, le=23),
             days: str = ""):
    f = apply_filters(split(stations), split(vgroups), split(offences),
                      h0, h1, split(days))
    n = len(f)
    if n == 0:
        return {"n": 0}

    # heat: aggregate to ~110 m bins so the browser gets thousands, not 250k
    by = np.round(f["latitude"] / HEAT_GRID).astype(int)
    bx = np.round(f["longitude"] / HEAT_GRID).astype(int)
    heat = (f.assign(by=by, bx=bx).groupby(["by", "bx"], observed=True)
             .agg(c=("impact", "size"), i=("impact", "sum")).reset_index())
    heat = [[round(r.by * HEAT_GRID, 4), round(r.bx * HEAT_GRID, 4), int(r.c),
             round(float(r.i), 2)] for r in heat.itertuples()]

    hourly = f.groupby("hour").agg(c=("impact", "size"), i=("impact", "sum")) \
              .reindex(range(24), fill_value=0)
    week = f.pivot_table(index="dow", columns="hour", values="impact",
                         aggfunc="size", fill_value=0) \
            .reindex(index=range(7), columns=range(24), fill_value=0)
    st = f.groupby("police_station", observed=True) \
          .agg(c=("impact", "size"), i=("impact", "sum"))
    st = st[st["c"] > 0]
    st["ipv"] = st["i"] / st["c"]
    top_st = st.sort_values("i", ascending=False).head(12)

    def mix(col):
        s = f.groupby(col, observed=True).agg(c=("impact", "size"),
                                              i=("impact", "sum"))
        s = s[s["c"] > 0].sort_values("i", ascending=False)
        return [{"k": k, "c": int(r.c), "i": round(float(r.i), 1)}
                for k, r in s.iterrows()]

    tier_i = f.groupby("tier", observed=True)["impact"].sum()
    return {
        "n": n,
        "impact": round(float(f["impact"].sum()), 1),
        "impact_per_day": round(float(f["impact"].sum()) / N_DAYS, 1),
        "blocked_km_day": round(float(f["blocked_m"].sum()) / N_DAYS / 1000, 2),
        "junction_share": round(float(f["at_junction"].mean()), 3),
        "stations": int(f["police_station"].nunique()),
        "peak_hour": int(hourly["i"].idxmax()),
        "top_station": top_st.index[0],
        "p1_share": round(float(tier_i.get("P1", 0) / f["impact"].sum()), 3),
        "heat": heat,
        "hourly": {"c": hourly["c"].astype(int).tolist(),
                   "i": hourly["i"].round(1).tolist()},
        "week": week.astype(int).values.tolist(),
        "top_stations": [{"k": k, "c": int(r.c), "i": round(float(r.i), 1),
                          "ipv": round(float(r.ipv), 3)}
                         for k, r in top_st.iterrows()],
        "scatter": [{"k": k, "c": int(r.c), "ipv": round(float(r.ipv), 3)}
                    for k, r in st.iterrows()],
        "vgroups": mix("vgroup"),
        "offences": mix("offence"),
    }


@app.get("/api/hotspots")
def hotspots(station: str = "", tier: str = "", limit: int = 1000):
    out = HOTSPOTS
    if station:
        out = [h for h in out if h["station"] == station]
    if tier:
        tiers = split(tier)
        out = [h for h in out if h["tier"] in tiers]
    return out[:limit]


@app.get("/api/forecast")
def forecast(date: str, station: str = ""):
    d = pd.Timestamp(date)
    dow = int(d.dayofweek)
    plan = []
    for s, v in FORECAST.items():
        cnt, imp = np.array(v["count"][dow]), np.array(v["impact"][dow])
        win = imp + np.roll(imp, -1) + np.roll(imp, -2)
        plan.append({"station": s, "count": round(float(cnt.sum()), 1),
                     "impact": round(float(imp.sum()), 1),
                     "window": int(win.argmax())})
    plan.sort(key=lambda r: r["impact"], reverse=True)
    for i, r in enumerate(plan):
        r["rank"] = i + 1
    res = {"date": str(d.date()), "dow": dow, "plan": plan}
    if station in FORECAST:
        res["station"] = {"name": station,
                          "count": FORECAST[station]["count"][dow],
                          "impact": FORECAST[station]["impact"][dow],
                          "hotspots": [h for h in HOTSPOTS
                                       if h["station"] == station][:8]}
    return res


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
