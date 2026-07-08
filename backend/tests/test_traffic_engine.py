"""Unit tests for the pure-logic parts of the traffic engine."""
import math

import pytest

from simulation.traffic_engine import TrafficLight, Vehicle, VEHICLE_TYPES


class TestTrafficLight:
    def test_starts_green(self):
        tl = TrafficLight((0, 0))
        assert tl.state == "green"
        assert not tl.is_red()

    def test_cycles_green_yellow_red(self):
        tl = TrafficLight((0, 0))
        tl.update(25.1)  # green expires
        assert tl.state == "yellow"
        tl.update(3.1)   # yellow expires
        assert tl.state == "red"
        assert tl.is_red()
        tl.update(25.1)  # red expires -> back to green
        assert tl.state == "green"

    def test_phase_offset_delays_transition(self):
        tl = TrafficLight((0, 0), phase_offset=10.0)
        tl.update(30.0)  # 25 + 10 = 35s total green
        assert tl.state == "green"
        tl.update(6.0)
        assert tl.state == "yellow"

    def test_to_dict(self):
        tl = TrafficLight((5.0, -3.0))
        assert tl.to_dict() == {"x": 5.0, "y": -3.0, "state": "green"}


class TestVehicle:
    def make_vehicle(self, route=None, vtype="car"):
        route = route or [(0.0, 0.0), (100.0, 0.0), (200.0, 0.0)]
        return Vehicle(1, route, vtype)

    def test_moves_along_route(self):
        v = self.make_vehicle()
        x0 = v.x
        v.update_position(1.0)
        assert v.x > x0
        assert v.y == 0.0

    def test_heading_angle(self):
        v = self.make_vehicle()
        v.update_position(0.1)
        assert math.isclose(v.angle, 0.0, abs_tol=1e-6)  # moving due east

    def test_finishes_route(self):
        v = self.make_vehicle(route=[(0.0, 0.0), (1.0, 0.0)])
        for _ in range(100):
            v.update_position(1.0)
        assert v.finished

    def test_red_light_stops_vehicle(self):
        v = self.make_vehicle()
        # Red light right in front — vehicle should brake to ~0 speed
        for _ in range(100):
            v.update_position(0.1, red_light_node=(v.x + 3.0, 0.0))
        assert v.speed < 0.5

    def test_lead_vehicle_prevents_collision(self):
        lead = self.make_vehicle()
        lead.speed = 0.0
        lead.x = 6.0
        follower = self.make_vehicle()
        for _ in range(200):
            follower.update_position(0.1, lead_vehicle=lead)
        assert follower.x < lead.x  # never overtakes through the leader

    @pytest.mark.parametrize("vtype", list(VEHICLE_TYPES))
    def test_all_types_construct(self, vtype):
        v = self.make_vehicle(vtype=vtype)
        assert v.length == VEHICLE_TYPES[vtype]["length"]
