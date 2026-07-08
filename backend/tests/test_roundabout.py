"""Tests for roundabout inference (osm_loader) and yield-on-entry (traffic_engine)."""
import json
import math

from osm_loader import parse_osm_data
from simulation.traffic_engine import TrafficSimulation


def make_circle_elements(radius=40.0, points=12, origin=(19.98708, 73.78399)):
    """Synthetic OSM payload: one closed one-way loop + one approach arm."""
    lat0, lon0 = origin
    m_lat = 1.0 / 111320.0
    m_lon = 1.0 / (111320.0 * math.cos(math.radians(lat0)))

    nodes, way_nodes = [], []
    for i in range(points):
        a = 2 * math.pi * i / points
        x, y = radius * math.cos(a), radius * math.sin(a)
        nid = 1000 + i
        nodes.append({"type": "node", "id": nid,
                      "lat": lat0 + y * m_lat, "lon": lon0 + x * m_lon})
        way_nodes.append(nid)
    way_nodes.append(way_nodes[0])  # close the loop

    # Arm from 120m east to the eastmost circle node
    arm_far = {"type": "node", "id": 2000, "lat": lat0, "lon": lon0 + 120 * m_lon}
    elements = nodes + [arm_far]
    elements.append({"type": "way", "id": 1, "nodes": way_nodes,
                     "tags": {"highway": "primary", "oneway": "yes", "name": "Test Circle"}})
    elements.append({"type": "way", "id": 2, "nodes": [2000, 1000],
                     "tags": {"highway": "primary", "name": "Test Arm"}})
    return {"elements": elements}, origin


class TestRoundaboutInference:
    def test_untagged_closed_oneway_loop_inferred(self):
        raw, (lat, lon) = make_circle_elements()
        scene = parse_osm_data(raw, lat, lon)
        circle = next(r for r in scene["roads"] if r["id"] == 1)
        assert circle["junction"] == "roundabout"
        assert circle["oneway"] is True

    def test_open_road_not_inferred(self):
        raw, (lat, lon) = make_circle_elements()
        scene = parse_osm_data(raw, lat, lon)
        arm = next(r for r in scene["roads"] if r["id"] == 2)
        assert arm["junction"] == ""

    def test_explicit_tag_respected(self):
        raw, (lat, lon) = make_circle_elements()
        for el in raw["elements"]:
            if el.get("id") == 1:
                el["tags"]["junction"] = "circular"
                del el["tags"]["oneway"]  # implicit oneway must kick in
        scene = parse_osm_data(raw, lat, lon)
        circle = next(r for r in scene["roads"] if r["id"] == 1)
        assert circle["junction"] == "circular"
        assert circle["oneway"] is True


class TestYieldOnEntry:
    def make_sim(self, tmp_path):
        raw, (lat, lon) = make_circle_elements()
        scene = parse_osm_data(raw, lat, lon)
        p = tmp_path / "scene.json"
        p.write_text(json.dumps(scene))
        return TrafficSimulation(scene_path=p)

    def test_circle_nodes_registered_and_unsignalised(self, tmp_path):
        sim = self.make_sim(tmp_path)
        assert len(sim.roundabout_nodes) == 12
        assert len(sim.roundabout_edges) == 12
        assert not (set(sim.traffic_lights) & sim.roundabout_nodes)

    def test_entry_blocked_by_circulating_vehicle(self, tmp_path):
        sim = self.make_sim(tmp_path)

        class FakeV:
            def __init__(self, x, y, angle):
                self.x, self.y, self.angle = x, y, angle

        entry = (0.0, 0.0)
        assert sim._roundabout_entry_blocked(entry, [FakeV(3, 0, 0)])       # occupied
        assert sim._roundabout_entry_blocked(entry, [FakeV(-15, 0, 0)])     # approaching
        assert not sim._roundabout_entry_blocked(entry, [FakeV(15, 0, 0)])  # departed
        assert not sim._roundabout_entry_blocked(entry, [FakeV(-50, 0, 0)]) # far away
        assert not sim._roundabout_entry_blocked(entry, [])                 # empty circle

    def test_construction_roads_excluded(self, tmp_path):
        raw, (lat, lon) = make_circle_elements()
        for el in raw["elements"]:
            if el.get("id") == 2:
                el["tags"]["highway"] = "construction"
        scene = parse_osm_data(raw, lat, lon)
        p = tmp_path / "scene.json"
        p.write_text(json.dumps(scene))
        sim = TrafficSimulation(scene_path=p)
        # Only circle edges in graph — the construction arm is not drivable
        assert len(sim.graph.edges()) == 12


class TestElevation:
    def test_flyover_nodes_and_vehicle_z(self, tmp_path):
        raw, (lat, lon) = make_circle_elements()
        # Turn the arm into an elevated bridge way
        for el in raw["elements"]:
            if el.get("id") == 2:
                el["tags"]["bridge"] = "yes"
                el["tags"]["layer"] = "1"
        scene = parse_osm_data(raw, lat, lon)
        p = tmp_path / "scene.json"
        p.write_text(json.dumps(scene))
        sim = TrafficSimulation(scene_path=p)

        deck_nodes = [n for n, h in sim.node_height.items() if h > 0]
        # Arm's far end is elevated-only; the end shared with the circle is a ramp at 0
        assert len(deck_nodes) == 1
        assert sim.node_height[deck_nodes[0]] == sim.DECK_HEIGHT

        class FakeV:
            current_edge = None
            x = y = 0.0
        v = FakeV()
        assert sim.elevation_of(v) == 0.0
        # Midway along an edge from ground (0) to deck (8) -> ~4
        ground = next(n for n, h in sim.node_height.items() if h == 0.0)
        deck = deck_nodes[0]
        v.current_edge = (ground, deck)
        v.x = (ground[0] + deck[0]) / 2
        v.y = (ground[1] + deck[1]) / 2
        assert abs(sim.elevation_of(v) - sim.DECK_HEIGHT / 2) < 0.5
