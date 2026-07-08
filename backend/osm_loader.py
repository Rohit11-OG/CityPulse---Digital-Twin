import requests
import json
import math
from pathlib import Path

from config import SCENE_PATH, CITY_LAT, CITY_LON, CITY_RADIUS_M

# Overpass API endpoints (primary + mirrors, tried in order)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

def latlon_to_meters(lat, lon, origin_lat, origin_lon):
    """
    Converts Latitude and Longitude to local Cartesian coordinates (X, Y) in meters,
    using an Equirectangular Local Tangent Plane approximation.
    
    X represents East/West (Easting)
    Y represents North/South (Northing)
    """
    # Convert latitude to radians for the cosine correction factor
    lat_rad = math.radians(origin_lat)
    
    # 1 degree of latitude is approx 111,320 meters
    meters_per_lat_deg = 111320.0
    # 1 degree of longitude shrinks as we move away from the equator
    meters_per_lon_deg = 111320.0 * math.cos(lat_rad)
    
    x = (lon - origin_lon) * meters_per_lon_deg
    y = (lat - origin_lat) * meters_per_lat_deg
    
    return round(x, 2), round(y, 2)


def fetch_osm_data(lat, lon, radius_meters=500):
    """
    Queries the Overpass API to fetch roads and buildings within a radius of coordinates.
    """
    print(f"Fetching OSM data around Lat: {lat}, Lon: {lon} (Radius: {radius_meters}m)...")
    
    # Overpass QL query:
    # 1. Get all road ways ('highway') in the radius
    # 2. Get all building ways ('building') in the radius
    # 3. Get green areas (parks, gardens, grass) for tree scattering
    # 4. Get individual tree nodes
    # 5. Recurse down ('>') to fetch coordinates of all nodes that construct these ways.
    query = f"""
    [out:json];
    (
      way["highway"](around:{radius_meters},{lat},{lon});
      way["building"](around:{radius_meters},{lat},{lon});
      way["leisure"~"park|garden|pitch|recreation_ground"](around:{radius_meters},{lat},{lon});
      way["landuse"~"grass|forest|recreation_ground|village_green"](around:{radius_meters},{lat},{lon});
      way["natural"~"wood|scrub|grassland"](around:{radius_meters},{lat},{lon});
      node["natural"="tree"](around:{radius_meters},{lat},{lon});
      node["name"]["amenity"~"hospital|marketplace|bus_station|place_of_worship|cinema|university|college"](around:{radius_meters},{lat},{lon});
      node["name"]["tourism"~"attraction|museum"](around:{radius_meters},{lat},{lon});
      node["name"]["historic"](around:{radius_meters},{lat},{lon});
      node["name"]["railway"="station"](around:{radius_meters},{lat},{lon});
      way["name"]["amenity"~"hospital|marketplace|bus_station|place_of_worship|cinema|university|college"](around:{radius_meters},{lat},{lon});
      way["name"]["tourism"~"attraction|museum"](around:{radius_meters},{lat},{lon});
      way["name"]["historic"](around:{radius_meters},{lat},{lon});
      way["name"]["railway"="station"](around:{radius_meters},{lat},{lon});
      way["name"]["leisure"="stadium"](around:{radius_meters},{lat},{lon});
    );
    out body;
    >;
    out skel qt;
    """
    
    headers = {
        "User-Agent": "CityPulse3D/1.0 (academic/learning project)",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    last_error = None
    for url in OVERPASS_URLS:
        try:
            print(f"Trying {url} ...")
            response = requests.post(url, data={"data": query}, headers=headers, timeout=180)
            if response.status_code == 200:
                return response.json()
            last_error = f"Status code {response.status_code}: {response.text[:300]}"
            print(f"  Failed ({response.status_code}), trying next mirror...")
        except requests.RequestException as e:
            last_error = str(e)
            print(f"  Error: {e}, trying next mirror...")

    raise Exception(f"All Overpass mirrors failed. Last error: {last_error}")


def parse_osm_data(raw_data, origin_lat, origin_lon):
    """
    Parses raw OSM JSON data into structured format suitable for Three.js.
    """
    # Dictionary to quickly look up node coordinates
    nodes = {}
    trees = []
    landmarks = []

    LANDMARK_KEYS = ("amenity", "tourism", "historic", "railway")

    def landmark_kind(tags):
        """Returns a label kind if the tags mark a named landmark, else None."""
        if not tags.get("name"):
            return None
        for key in LANDMARK_KEYS:
            if key in tags:
                return tags[key]
        if tags.get("leisure") == "stadium":
            return "stadium"
        return None

    # First pass: Index all node coordinates and project them to local meters
    for element in raw_data.get("elements", []):
        if element["type"] == "node":
            node_id = element["id"]
            lat = element["lat"]
            lon = element["lon"]
            x, y = latlon_to_meters(lat, lon, origin_lat, origin_lon)
            nodes[node_id] = {"x": x, "y": y, "lat": lat, "lon": lon}

            # Individual mapped trees
            tags = element.get("tags", {})
            if tags.get("natural") == "tree":
                trees.append({"x": x, "y": y})

            # Named POI nodes (hospitals, temples, stations, markets...)
            kind = landmark_kind(tags)
            if kind:
                landmarks.append({"name": tags["name"], "kind": kind, "x": x, "y": y})

    roads = []
    buildings = []
    greens = []
    
    # Second pass: Parse ways (roads and buildings)
    for element in raw_data.get("elements", []):
        if element["type"] == "way":
            tags = element.get("tags", {})
            way_nodes = element.get("nodes", [])
            
            # Map node IDs to their local projected coordinates
            coordinates = []
            for node_id in way_nodes:
                if node_id in nodes:
                    coordinates.append(nodes[node_id])
                    
            if not coordinates:
                continue

            # Named landmark ways (temples, hospitals, stations...) -> label at centroid
            kind = landmark_kind(tags)
            if kind:
                cx = sum(c["x"] for c in coordinates) / len(coordinates)
                cy = sum(c["y"] for c in coordinates) / len(coordinates)
                landmarks.append({"name": tags["name"], "kind": kind, "x": cx, "y": cy})

            # If way is a building
            if "building" in tags:
                # Get height (or estimate based on levels)
                levels = int(tags.get("building:levels", 1))
                height = float(tags.get("height", levels * 3.5)) # 3.5m per level standard
                
                buildings.append({
                    "id": element["id"],
                    "coordinates": coordinates,
                    "height": height,
                    "type": tags.get("building", "yes")
                })
                
            # If way is a green area (park, garden, grass, wood)
            elif ("leisure" in tags or "landuse" in tags or "natural" in tags):
                greens.append({
                    "id": element["id"],
                    "coordinates": coordinates,
                    "kind": tags.get("leisure") or tags.get("landuse") or tags.get("natural"),
                    "name": tags.get("name", "")
                })

            # If way is a road (highway)
            elif "highway" in tags:
                # Exclude pedestrian-only pathways for traffic simulation if desired,
                # but keep roads suitable for cars.
                highway_type = tags.get("highway")
                if highway_type not in ["footway", "cycleway", "steps", "bridleway", "path"]:
                    try:
                        layer = int(tags.get("layer", 0))
                    except ValueError:
                        layer = 0

                    # Many Indian roundabouts (e.g. Mumbai Naka Circle) are not
                    # tagged junction=roundabout in OSM. Infer it: a closed
                    # one-way loop of compact size can only be a circulating
                    # carriageway.
                    junction = tags.get("junction", "")
                    is_oneway = tags.get("oneway", "no") == "yes"
                    if not junction and is_oneway and len(coordinates) >= 8 \
                            and coordinates[0] == coordinates[-1]:
                        bx = [c["x"] for c in coordinates]
                        by = [c["y"] for c in coordinates]
                        if max(max(bx) - min(bx), max(by) - min(by)) < 150.0:
                            junction = "roundabout"

                    roads.append({
                        "id": element["id"],
                        "coordinates": coordinates,
                        "type": highway_type,
                        "name": tags.get("name", "Unnamed Road"),
                        # OSM roundabouts are implicitly one-way even when untagged
                        "oneway": is_oneway or junction in ("roundabout", "circular"),
                        "lanes": int(tags.get("lanes", 1 if highway_type in ["service", "residential"] else 2)),
                        # Roundabout carriageways get yield-on-entry logic in the sim
                        "junction": junction,
                        # Elevated ways (flyovers) — rendered raised, no ground interaction
                        "layer": layer,
                        "bridge": tags.get("bridge", "no") not in ("no", ""),
                    })
                    
    return {
        "origin": {"lat": origin_lat, "lon": origin_lon},
        "roads": roads,
        "buildings": buildings,
        "greens": greens,
        "trees": trees,
        "landmarks": landmarks
    }


def download_and_process_scene(lat, lon, radius=500, save_path=SCENE_PATH):
    """
    Main function to fetch, parse, and save map data to disk.
    Caches the raw Overpass response so the scene can be re-parsed
    (e.g. after parser changes) without re-downloading.
    """
    raw_path = Path(save_path).parent / "osm_raw.json"
    if raw_path.exists():
        print(f"Using cached raw OSM data from {raw_path} (delete it to force re-download).")
        with open(raw_path, "r") as f:
            raw_data = json.load(f)
    else:
        raw_data = fetch_osm_data(lat, lon, radius)
        Path(raw_path).parent.mkdir(parents=True, exist_ok=True)
        with open(raw_path, "w") as f:
            json.dump(raw_data, f)
    parsed_data = parse_osm_data(raw_data, lat, lon)
    
    # Ensure folder exists
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    
    with open(save_path, "w") as f:
        json.dump(parsed_data, f, indent=2)
        
    print(f"Successfully saved parsed map data to {save_path}")
    print(f"Loaded {len(parsed_data['roads'])} roads, {len(parsed_data['buildings'])} buildings, "
          f"{len(parsed_data['greens'])} green areas, {len(parsed_data['trees'])} trees, "
          f"{len(parsed_data['landmarks'])} landmarks.")
    return parsed_data


if __name__ == "__main__":
    # Location comes from config.py (CITY_LAT / CITY_LON / CITY_RADIUS_M,
    # overridable via .env). Default: Mumbai Naka Circle, Nashik.
    download_and_process_scene(CITY_LAT, CITY_LON, CITY_RADIUS_M)
