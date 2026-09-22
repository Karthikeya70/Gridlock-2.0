"""
Parking Intelligence pipeline — Flipkart GRiDLOCK 2.0, PS1
"How can AI-driven parking intelligence detect illegal parking hotspots and
 quantify their impact on traffic flow to enable targeted enforcement?"

Run once:  python pipeline.py
Produces everything the dashboard needs in ./data/ :
    records.parquet   cleaned, feature-engineered violations (for live filtering)
    hotspots.json     ~220 m grid cells, Gi* significance, Enforcement Priority Index
    forecast.json     station x weekday x hour forecast of violations + impact
    meta.json         model metrics, dataset facts, filter options, findings
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

SRC = Path("PS1_Dataset.csv")
OUT = Path("data")
OUT.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# 1. Traffic-impact model assumptions (all transparent, all tunable)
# ---------------------------------------------------------------------------

# Passenger Car Units, IRC:106-1990 (urban roads) + typical parked length (m).
# A bus parked on the carriageway takes 2.2x the road space of a car.
VEHICLE = {
    # type:               (group,         PCU, length_m)
    "SCOOTER":             ("Two-wheeler", 0.5, 2.0),
    "MOTOR CYCLE":         ("Two-wheeler", 0.5, 2.0),
    "MOPED":               ("Two-wheeler", 0.5, 2.0),
    "CAR":                 ("Car / Cab",   1.0, 4.5),
    "JEEP":                ("Car / Cab",   1.0, 4.5),
    "MAXI-CAB":            ("Car / Cab",   1.0, 5.0),
    "VAN":                 ("Car / Cab",   1.0, 5.0),
    "OTHERS":              ("Car / Cab",   1.0, 4.5),
    "PASSENGER AUTO":      ("Auto",        1.2, 3.0),
    "GOODS AUTO":          ("Auto",        1.2, 3.0),
    "LGV":                 ("Light goods", 1.4, 6.0),
    "TEMPO":               ("Light goods", 1.4, 6.0),
    "MINI LORRY":          ("Light goods", 1.4, 6.5),
    "SCHOOL VEHICLE":      ("Light goods", 1.4, 7.0),
    "PRIVATE BUS":         ("Bus / Truck", 2.2, 12.0),
    "BUS (BMTC/KSRTC)":    ("Bus / Truck", 2.2, 12.0),
    "TOURIST BUS":         ("Bus / Truck", 2.2, 12.0),
    "FACTORY BUS":         ("Bus / Truck", 2.2, 12.0),
    "LORRY/GOODS VEHICLE": ("Bus / Truck", 2.2, 10.0),
    "HGV":                 ("Bus / Truck", 2.2, 12.0),
    "TANKER":              ("Bus / Truck", 2.2, 10.0),
    "TRACTOR":             ("Bus / Truck", 4.0, 8.0),
}

# How much of the moving carriageway a violation of this kind takes away.
# 1.0 = kerbside illegal parking (baseline). Non-parking offences score 0.
OBSTRUCTION = {
    "DOUBLE PARKING": 3.0,                              # removes a full lane
    "PARKING OPPOSITE TO ANOTHER PARKED VEHICLE": 2.5,  # squeezes both sides
    "PARKING IN A MAIN ROAD": 2.0,                      # arterial capacity
    "PARKING NEAR ROAD CROSSING": 2.0,                  # intersection throat
    "PARKING NEAR TRAFFIC LIGHT OR ZEBRA CROSS": 2.0,   # stop-line queue
    "PARKING NEAR BUSTOP/SCHOOL/HOSPITAL ETC": 1.8,     # buses stop in lane
    "PARKING OTHER THAN BUS STOP": 1.5,
    "PARKING ON FOOTPATH": 1.3,                         # pedestrians spill to road
    "WRONG PARKING": 1.0,
    "NO PARKING": 1.0,
}
JUNCTION_FACTOR = 1.5  # record tagged to a BTP junction: bottleneck multiplier

# Relative urban traffic demand by hour (Bengaluru-style twin peaks).
# A violation during a peak costs more flow than the same one at 3 AM.
DEMAND = np.array([0.15, 0.10, 0.10, 0.10, 0.15, 0.30, 0.50, 0.75,
                   0.95, 1.00, 1.00, 0.85, 0.75, 0.75, 0.75, 0.80,
                   0.90, 1.00, 1.00, 1.00, 0.85, 0.60, 0.40, 0.25])

GRID = 0.002  # degrees; ~222 m N-S, ~217 m E-W at 13° N
MIN_CELL = 20  # cells with fewer records are not ranked


def parse_list(s):
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return []


# ---------------------------------------------------------------------------
# 2. Load + clean
# ---------------------------------------------------------------------------
print("Loading ...")
raw = pd.read_csv(SRC, low_memory=False)
n_raw = len(raw)

status = raw["validation_status"].fillna("pending")
dropped = status.isin(["rejected", "duplicate"])
df = raw[~dropped].copy()
print(f"  {n_raw:,} raw  ->  {len(df):,} after dropping rejected/duplicate "
      f"({dropped.sum():,})")

# Validators corrected the vehicle type on some records — trust the correction.
df["vtype"] = df["updated_vehicle_type"].fillna(df["vehicle_type"])
df["vtype"] = df["vtype"].where(df["vtype"].isin(VEHICLE), "OTHERS")

# Timestamps carry a double IST offset. Converting "+00" to IST alone puts 51% of
# human validator desk activity at 00:00-06:00; a further +5.5 h puts 64% of it in
# office hours (10-18, peak 10:00) and tickets in an 08:00-20:00 enforcement day.
EXTRA_OFFSET = pd.Timedelta(hours=5.5)
ts = pd.to_datetime(df["created_datetime"], format="mixed", utc=True)
ts = ts.dt.tz_convert("Asia/Kolkata") + EXTRA_OFFSET
df["hour"] = ts.dt.hour
df["dow"] = ts.dt.dayofweek
df["date"] = ts.dt.tz_localize(None).dt.normalize()

df["police_station"] = df["police_station"].fillna("No Police Station")
df["junction"] = df["junction_name"].fillna("No Junction")
df["at_junction"] = df["junction"].ne("No Junction")

# ---------------------------------------------------------------------------
# 3. Congestion Impact Score per violation
# ---------------------------------------------------------------------------
vt = df["violation_type"].map(parse_list)
df["obstruction"] = vt.map(lambda L: max([OBSTRUCTION.get(x, 0.0) for x in L],
                                         default=0.0))
# Primary label = the most obstructive parking offence on the ticket
df["offence"] = vt.map(lambda L: max(L, key=lambda x: OBSTRUCTION.get(x, 0.0))
                       if L else "UNKNOWN")
df = df[df["obstruction"] > 0].copy()  # non-parking offences only

veh = df["vtype"].map(VEHICLE)
df["vgroup"] = veh.str[0]
df["pcu"] = veh.str[1]
df["length_m"] = veh.str[2]

df["impact"] = (df["pcu"] * df["obstruction"]
                * np.where(df["at_junction"], JUNCTION_FACTOR, 1.0)
                * DEMAND[df["hour"].to_numpy()])
# carriageway physically blocked (only obstructive offences take moving lane)
df["blocked_m"] = df["length_m"] * np.minimum(df["obstruction"], 2.0) / 2.0

# Road name = first address token that looks like a road
def road_name(loc):
    if not isinstance(loc, str):
        return None
    parts = [p.strip() for p in loc.split(",")]
    for p in parts[:3]:
        if any(k in p.lower() for k in ("road", "street", "main", "cross",
                                        "circle", "marg", "layout", "bazaar")):
            return p
    return parts[0] if parts else None

df["road"] = df["location"].map(road_name)

# Grid cell
df["gy"] = np.floor(df["latitude"] / GRID).astype(int)
df["gx"] = np.floor(df["longitude"] / GRID).astype(int)

n_days = (df["date"].max() - df["date"].min()).days + 1
print(f"  {len(df):,} parking violations over {n_days} days")

# ---------------------------------------------------------------------------
# 4. Hotspots: grid aggregation + Getis-Ord Gi* significance + priority index
# ---------------------------------------------------------------------------
print("Hotspots ...")
g = df.groupby(["gy", "gx"])
cells = g.agg(
    n=("impact", "size"),
    impact=("impact", "sum"),
    blocked_m=("blocked_m", "sum"),
    days=("date", "nunique"),
    junction_share=("at_junction", "mean"),
    heavy_share=("pcu", lambda s: (s >= 1.4).mean()),
    station=("police_station", lambda s: s.mode().iat[0]),
    lat=("latitude", "mean"),
    lon=("longitude", "mean"),
).reset_index()

def top(col):
    return g[col].agg(lambda s: s.dropna().mode().iat[0]
                      if s.notna().any() else None).rename(col)

cells = cells.merge(top("road").reset_index(), on=["gy", "gx"])
cells = cells.merge(g["junction"].agg(
    lambda s: s[s != "No Junction"].mode().iat[0]
    if (s != "No Junction").any() else None).reset_index(), on=["gy", "gx"])
cells = cells.merge(top("vgroup").reset_index(), on=["gy", "gx"])
cells = cells.merge(top("offence").reset_index(), on=["gy", "gx"])

# peak 3-hour enforcement window by impact
hp = df.pivot_table(index=["gy", "gx"], columns="hour", values="impact",
                    aggfunc="sum", fill_value=0).reindex(columns=range(24),
                                                         fill_value=0)
roll = hp.to_numpy() + np.roll(hp.to_numpy(), -1, 1) + np.roll(hp.to_numpy(), -2, 1)
peak = pd.Series(roll.argmax(1), index=hp.index, name="peak_start").reset_index()
cells = cells.merge(peak, on=["gy", "gx"])

# Getis-Ord Gi* on impact over a dense raster (3x3 queen neighbourhood incl. self)
y0, x0 = cells["gy"].min(), cells["gx"].min()
H, W = cells["gy"].max() - y0 + 1, cells["gx"].max() - x0 + 1
R = np.zeros((H, W))
R[cells["gy"] - y0, cells["gx"] - x0] = cells["impact"]
P = np.pad(R, 1)
S = sum(P[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
        for dy in (-1, 0, 1) for dx in (-1, 0, 1))
Wn = np.pad(np.ones_like(R), 1)
Wsum = sum(Wn[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
           for dy in (-1, 0, 1) for dx in (-1, 0, 1))
N = R.size
xbar, sd = R.mean(), R.std()
gi = (S - xbar * Wsum) / (sd * np.sqrt((N * Wsum - Wsum ** 2) / (N - 1)))
cells["gi_z"] = gi[cells["gy"] - y0, cells["gx"] - x0]

cells["persistence"] = cells["days"] / n_days
cells["impact_per_day"] = cells["impact"] / n_days
cells["blocked_m_day"] = cells["blocked_m"] / n_days

ranked = cells[cells["n"] >= MIN_CELL].copy()
pr = lambda c: ranked[c].rank(pct=True)
# Enforcement Priority Index: how much flow is lost, how chronic, how critical
ranked["epi"] = (100 * (0.55 * pr("impact") + 0.25 * pr("persistence")
                        + 0.10 * pr("junction_share") + 0.10 * pr("gi_z"))).round(1)
ranked = ranked.sort_values("epi", ascending=False).reset_index(drop=True)
ranked["rank"] = ranked.index + 1
ranked["significant"] = ranked["gi_z"] > 2.58  # 99% confidence
ranked["tier"] = np.select(
    [ranked["rank"] <= 25, ranked["rank"] <= 100, ranked["significant"]],
    ["P1", "P2", "P3"], "Watch")
print(f"  {len(ranked):,} ranked cells, {ranked['significant'].sum():,} "
      f"significant (Gi* z>2.58)")

cells = cells.merge(ranked[["gy", "gx", "epi", "rank", "tier"]],
                    on=["gy", "gx"], how="left")
df = df.merge(cells[["gy", "gx", "tier"]], on=["gy", "gx"], how="left")

hot_cols = ["rank", "tier", "epi", "lat", "lon", "station", "road", "junction",
            "n", "impact", "impact_per_day", "blocked_m_day", "days",
            "persistence", "junction_share", "heavy_share", "gi_z",
            "vgroup", "offence", "peak_start"]
hot = ranked[hot_cols].copy()
for c in ["lat", "lon"]:
    hot[c] = hot[c].round(5)
for c in ["impact", "impact_per_day", "blocked_m_day", "persistence",
          "junction_share", "heavy_share", "gi_z"]:
    hot[c] = hot[c].round(3)
hot = hot.replace({np.nan: None})
(OUT / "hotspots.json").write_text(json.dumps(hot.to_dict("records")))

# ---------------------------------------------------------------------------
# 5. Forecast: station x day x hour violations (proactive deployment)
# ---------------------------------------------------------------------------
print("Forecast ...")
stations = sorted(df["police_station"].unique())
dates = pd.date_range(df["date"].min(), df["date"].max())
grid = pd.MultiIndex.from_product([stations, dates, range(24)],
                                  names=["police_station", "date", "hour"])
counts = (df.groupby(["police_station", "date", "hour"]).size()
            .reindex(grid, fill_value=0).rename("y").reset_index())
counts["dow"] = counts["date"].dt.dayofweek
counts["is_weekend"] = (counts["dow"] >= 5).astype(int)
counts["stn"] = counts["police_station"].map({s: i for i, s in enumerate(stations)})

cutoff = counts["date"].max() - pd.Timedelta(days=21)
train, test = counts[counts["date"] <= cutoff], counts[counts["date"] > cutoff]

def profile_features(frame, source):
    """Historical station profiles — computed from `source` only (no leakage)."""
    sh = source.groupby(["stn", "hour"])["y"].mean().rename("stn_hour")
    sd = source.groupby(["stn", "dow"])["y"].mean().rename("stn_dow")
    sa = source.groupby("stn")["y"].mean().rename("stn_avg")
    rec = (source[source["date"] > source["date"].max() - pd.Timedelta(days=28)]
           .groupby("stn")["y"].mean().rename("stn_recent"))
    out = frame.join(sh, on=["stn", "hour"]).join(sd, on=["stn", "dow"])
    return out.join(sa, on="stn").join(rec, on="stn").fillna(0)

FEATS = ["stn", "hour", "dow", "is_weekend", "stn_hour", "stn_dow",
         "stn_avg", "stn_recent"]
Xtr, Xte = profile_features(train, train), profile_features(test, train)

model = HistGradientBoostingRegressor(loss="poisson", max_iter=400,
                                      learning_rate=0.05, max_leaf_nodes=63,
                                      categorical_features=[0], random_state=42)
model.fit(Xtr[FEATS], Xtr["y"])
pred = model.predict(Xte[FEATS])

sdh = train.groupby(["stn", "dow", "hour"])["y"].mean().rename("b")
b_sdh = test.join(sdh, on=["stn", "dow", "hour"])["b"].fillna(0)
metrics = {
    "model": "HistGradientBoosting (Poisson)",
    "test_window": f"{(cutoff + pd.Timedelta(days=1)).date()} to {counts['date'].max().date()}",
    "mae_model": mean_absolute_error(test["y"], pred),
    "mae_global_mean": mean_absolute_error(test["y"],
                                           np.full(len(test), train["y"].mean())),
    "mae_station_hour": mean_absolute_error(test["y"], Xte["stn_hour"]),
    "mae_station_dow_hour": mean_absolute_error(test["y"], b_sdh),
}
tot = test["y"].sum()
metrics["wape_model"] = np.abs(test["y"] - pred).sum() / tot
metrics["wape_station_hour"] = np.abs(test["y"] - Xte["stn_hour"]).sum() / tot
# does the model find tomorrow's top-10 station-days?
def hit_rate(p):
    t = test.assign(p=np.asarray(p)).groupby(["date", "stn"])[["y", "p"]].sum()
    return float(np.mean([len(set(d.nlargest(10, "y").index)
                              & set(d.nlargest(10, "p").index)) / 10
                          for _, d in t.groupby(level=0)]))
metrics["top10_station_hit_rate"] = hit_rate(pred)
metrics["top10_hit_rate_station_hour"] = hit_rate(Xte["stn_hour"])
metrics = {k: (round(float(v), 3) if not isinstance(v, str) else v)
           for k, v in metrics.items()}
print("  ", metrics)

# Refit on everything, then emit a station x dow x hour table
full = profile_features(counts, counts)
model.fit(full[FEATS], full["y"])
fut = pd.MultiIndex.from_product([range(len(stations)), range(7), range(24)],
                                 names=["stn", "dow", "hour"]).to_frame(index=False)
fut["is_weekend"] = (fut["dow"] >= 5).astype(int)
fut = profile_features(fut, counts)
fut["pred"] = model.predict(fut[FEATS]).clip(0)

# expected impact = forecast count x the station-hour's typical impact per ticket
ipv = df.groupby(["police_station", "hour"])["impact"].mean()
city_ipv = df.groupby("hour")["impact"].mean()
fc = {}
for i, s in enumerate(stations):
    sub = fut[fut["stn"] == i]
    per = np.array([ipv.get((s, h), city_ipv[h]) for h in range(24)])
    fc[s] = {
        "count": sub["pred"].to_numpy().reshape(7, 24).round(2).tolist(),
        "impact": (sub["pred"].to_numpy().reshape(7, 24) * per).round(2).tolist(),
    }
(OUT / "forecast.json").write_text(json.dumps(fc))

# ---------------------------------------------------------------------------
# 6. Records for the live dashboard + metadata / findings
# ---------------------------------------------------------------------------
keep = df[["latitude", "longitude", "police_station", "vgroup", "offence",
           "hour", "dow", "date", "at_junction", "impact", "blocked_m",
           "tier"]].copy()
keep["tier"] = keep["tier"].fillna("—")
for c in ["police_station", "vgroup", "offence", "tier"]:
    keep[c] = keep[c].astype("category")
keep.to_parquet(OUT / "records.parquet", index=False)

hour_n = df.groupby("hour").size().reindex(range(24), fill_value=0)
evening = hour_n.loc[17:21].sum() / hour_n.sum()
p1 = ranked[ranked["tier"] == "P1"]
share_p1 = p1["impact"].sum() / df["impact"].sum()
area_p1 = len(p1) * 0.222 * 0.217

meta = {
    "dataset": {
        "raw_records": int(n_raw),
        "dropped_invalid": int(dropped.sum()),
        "parking_violations": int(len(df)),
        "days": int(n_days),
        "start": str(df["date"].min().date()),
        "end": str(df["date"].max().date()),
        "stations": len(stations),
    },
    "metrics": metrics,
    "options": {
        "stations": stations,
        "vgroups": sorted(df["vgroup"].unique()),
        "offences": df["offence"].value_counts().index.tolist(),
    },
    "findings": {
        "p1_cells": int(len(p1)),
        "p1_area_km2": round(area_p1, 2),
        "p1_impact_share": round(float(share_p1), 3),
        "junction_record_share": round(float(df["at_junction"].mean()), 3),
        "junction_impact_share": round(float(df.loc[df["at_junction"], "impact"].sum()
                                             / df["impact"].sum()), 3),
        "evening_peak_share": round(float(evening), 4),
        "significant_cells": int(ranked["significant"].sum()),
        "ranked_cells": int(len(ranked)),
    },
    "assumptions": {
        "vehicle_pcu": {k: v[1] for k, v in VEHICLE.items()},
        "obstruction": OBSTRUCTION,
        "junction_factor": JUNCTION_FACTOR,
        "demand_profile": DEMAND.tolist(),
        "grid_m": 220,
    },
}
(OUT / "meta.json").write_text(json.dumps(meta, indent=1))
print("  findings:", meta["findings"])
print("Done ->", OUT.resolve())
