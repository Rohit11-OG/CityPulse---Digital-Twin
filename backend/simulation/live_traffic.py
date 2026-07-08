import os
import json
import math
import time
import threading

import requests

from config import SCENE_PATH

# TomTom Flow Segment Data API — returns real current speed vs free-flow speed
# for the road segment nearest to a lat/lon point.
# https://developer.tomtom.com/traffic-api/documentation/traffic-flow/flow-segment-data
TOMTOM_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"

# Free tier is 2,500 requests/day. 12 sample points refreshed every 10 minutes
# = ~1,730 requests/day, safely under the cap.
SAMPLE_POINTS = 12
REFRESH_SECONDS = 600


class LiveTrafficManager:
    """
    Samples real-time traffic speeds from TomTom at fixed points across the map
    (midpoints of the longest major roads) and exposes per-point congestion
    ratios the simulation uses to throttle road speeds and scale density.

    ratio = current_speed / free_flow_speed  (1.0 free flowing, ~0.2 jammed)
    """

    def __init__(self, scene_path=SCENE_PATH):
        self.api_key = os.environ.get("TOMTOM_API_KEY")
        self.active = False           # true once at least one fetch succeeded
        self.samples = []             # [{x, y, lat, lon, ratio, current_kmh, freeflow_kmh}]
        self.congestion = 0.0         # network average (0 free flow .. 1 jammed)
        self.lock = threading.Lock()
        self._stop = False
        # Immutable snapshot of (x, y, ratio) rebuilt after each refresh; the
        # sim thread reads this reference atomically instead of touching
        # self.samples while the fetch thread mutates it.
        self._ratio_points = ()

        if not self.api_key:
            print("LiveTraffic: No TOMTOM_API_KEY found. Simulated congestion only.")
            return

        self._build_sample_points(scene_path)
        if not self.samples:
            print("LiveTraffic: no sample points could be derived from scene.")
            return

        thread = threading.Thread(target=self._fetch_loop, daemon=True)
        thread.start()
        print(f"LiveTraffic: TomTom key found. Sampling {len(self.samples)} points every {REFRESH_SECONDS}s.")

    def _build_sample_points(self, scene_path):
        if not os.path.exists(scene_path):
            return
        with open(scene_path, "r") as f:
            scene = json.load(f)

        origin = scene.get("origin", {})
        lat0, lon0 = origin.get("lat"), origin.get("lon")
        if lat0 is None:
            return

        # Longest major roads, deduped by name
        majors = [r for r in scene.get("roads", [])
                  if r.get("type") in ("trunk", "primary", "secondary") and len(r.get("coordinates", [])) >= 2]
        majors.sort(key=lambda r: len(r["coordinates"]), reverse=True)

        seen_names = set()
        for road in majors:
            if len(self.samples) >= SAMPLE_POINTS:
                break
            name = road.get("name") or f"road-{road['id']}"
            if name in seen_names:
                continue
            seen_names.add(name)
            mid = road["coordinates"][len(road["coordinates"]) // 2]
            # Inverse of the equirectangular projection used in osm_loader
            lat = lat0 + (mid["y"] / 111320.0)
            lon = lon0 + (mid["x"] / (111320.0 * math.cos(math.radians(lat0))))
            self.samples.append({
                "x": mid["x"], "y": mid["y"], "lat": lat, "lon": lon,
                "ratio": 1.0, "current_kmh": 0.0, "freeflow_kmh": 0.0, "name": name,
            })

    def _fetch_loop(self):
        while not self._stop:
            ok = 0
            for s in self.samples:
                try:
                    resp = requests.get(TOMTOM_URL, params={
                        "point": f"{s['lat']:.6f},{s['lon']:.6f}",
                        "unit": "KMPH",
                        "key": self.api_key,
                    }, timeout=8)
                    if resp.status_code == 200:
                        seg = resp.json().get("flowSegmentData", {})
                        cur = float(seg.get("currentSpeed", 0.0))
                        free = float(seg.get("freeFlowSpeed", 0.0))
                        if free > 0:
                            with self.lock:
                                s["current_kmh"] = cur
                                s["freeflow_kmh"] = free
                                s["ratio"] = max(0.15, min(1.0, cur / free))
                            ok += 1
                    else:
                        print(f"LiveTraffic: TomTom status {resp.status_code} for {s['name']}")
                except requests.RequestException as e:
                    print(f"LiveTraffic: fetch error for {s['name']}: {e}")
                time.sleep(0.4)  # gentle pacing between calls

            if ok:
                with self.lock:
                    ratios = [s["ratio"] for s in self.samples if s["freeflow_kmh"] > 0]
                    self.congestion = 1.0 - (sum(ratios) / len(ratios)) if ratios else 0.0
                    self.active = True
                    self._ratio_points = tuple(
                        (s["x"], s["y"], s["ratio"]) for s in self.samples
                    )
                print(f"LiveTraffic: refreshed {ok}/{len(self.samples)} points. "
                      f"Network congestion: {self.congestion * 100:.0f}%")
            time.sleep(REFRESH_SECONDS)

    def ratio_at(self, x, y):
        """Congestion ratio of the nearest sample point (1.0 when inactive)."""
        points = self._ratio_points  # atomic read of immutable snapshot
        if not self.active or not points:
            return 1.0
        best, best_d = 1.0, float("inf")
        for px, py, ratio in points:
            d = (px - x) ** 2 + (py - y) ** 2
            if d < best_d:
                best_d = d
                best = ratio
        return best

    def snapshot(self):
        """Thread-safe copy of current live state for broadcasting."""
        with self.lock:
            return {
                "active": self.active,
                "congestion": round(self.congestion, 3),
                "samples": [
                    {"x": s["x"], "y": s["y"], "ratio": round(s["ratio"], 3),
                     "current_kmh": round(s["current_kmh"], 1),
                     "freeflow_kmh": round(s["freeflow_kmh"], 1),
                     "name": s["name"]}
                    for s in self.samples if s["freeflow_kmh"] > 0
                ],
            }
