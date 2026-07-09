import json
import math
import heapq
import random
import time
import asyncio
from pathlib import Path
import networkx as nx
from config import SCENE_PATH, CITY_RADIUS_M
from simulation.weather import WeatherManager

# Vehicle configurations by type
# co2_rate: g CO2/km while moving | idle_co2: kg CO2/h while idling | idle_fuel: litres fuel/h while idling
# stop_gap: bumper gap when queued (m) | follow_dist: distance where following starts (m)
# Two-wheelers and autos squeeze into far smaller gaps than cars — that's what
# makes Indian junction queues pack the way they do.
VEHICLE_TYPES = {
    "car": {"length": 4.5, "max_speed": 13.8, "co2_rate": 120.0, "idle_co2": 1.4, "idle_fuel": 0.6, "stop_gap": 4.0, "follow_dist": 15.0},
    "bus": {"length": 12.0, "max_speed": 10.0, "co2_rate": 800.0, "idle_co2": 4.5, "idle_fuel": 2.0, "stop_gap": 6.0, "follow_dist": 20.0},
    "auto": {"length": 3.0, "max_speed": 8.3, "co2_rate": 80.0, "idle_co2": 0.9, "idle_fuel": 0.4, "stop_gap": 2.0, "follow_dist": 8.0},
    "bike": {"length": 1.8, "max_speed": 11.1, "co2_rate": 0.0, "idle_co2": 0.0, "idle_fuel": 0.0, "stop_gap": 1.2, "follow_dist": 6.0},
    "truck": {"length": 8.0, "max_speed": 9.0, "co2_rate": 600.0, "idle_co2": 3.8, "idle_fuel": 1.7, "stop_gap": 6.0, "follow_dist": 20.0}
}

# Traffic composition at a typical Nashik arterial junction (field-estimate;
# refine with an actual classified count at Mumbai Naka).
VEHICLE_MIX = {"bike": 0.45, "car": 0.25, "auto": 0.15, "truck": 0.08, "bus": 0.07}

# Calibration: one simulated vehicle represents 2.5 real vehicles
SIM_VEHICLE_FACTOR = 2.5


# ═══════════════════════════════════════════════════════════════════
# TRAFFIC LIGHT — Finite State Machine
# ═══════════════════════════════════════════════════════════════════
# States cycle:  GREEN (25s) → YELLOW (3s) → RED (25s) → GREEN ...
# Each junction light is offset by a random phase so they don't all
# switch simultaneously, creating realistic wave patterns.
# ═══════════════════════════════════════════════════════════════════

class TrafficLight:
    STATES = ["green", "yellow", "red"]
    DURATIONS = {"green": 25.0, "yellow": 3.0, "red": 25.0}

    def __init__(self, node, phase_offset=0.0):
        self.node = node  # (x, y) tuple — the junction coordinate
        self.state_index = 0  # Start at green
        self.state = self.STATES[self.state_index]
        self.timer = self.DURATIONS[self.state] + phase_offset

    def update(self, dt):
        """Decrement timer and transition to next state when expired."""
        self.timer -= dt
        if self.timer <= 0:
            self.state_index = (self.state_index + 1) % len(self.STATES)
            self.state = self.STATES[self.state_index]
            self.timer = self.DURATIONS[self.state]

    def is_red(self):
        return self.state == "red"

    def is_yellow(self):
        return self.state == "yellow"

    def to_dict(self):
        """Serialise for WebSocket broadcast."""
        return {
            "x": self.node[0],
            "y": self.node[1],
            "state": self.state,
        }


class Vehicle:
    def __init__(self, vehicle_id, route, vehicle_type):
        self.id = vehicle_id
        self.route = route  # List of (x, y) nodes
        self.route_index = 0
        self.type = vehicle_type
        
        # Physics state
        self.x = route[0][0]
        self.y = route[0][1]
        self.target_speed = VEHICLE_TYPES[vehicle_type]["max_speed"]
        self.speed = self.target_speed
        self.length = VEHICLE_TYPES[vehicle_type]["length"]
        self.co2_rate = VEHICLE_TYPES[vehicle_type]["co2_rate"]
        self.stop_gap = VEHICLE_TYPES[vehicle_type]["stop_gap"]
        self.follow_dist = VEHICLE_TYPES[vehicle_type]["follow_dist"]
        # Driver personality: some run above the local pace, some below —
        # prevents robotically uniform speeds
        self.speed_pref = random.uniform(0.85, 1.15)
        
        # Tracking variables
        self.angle = 0.0
        self.finished = False
        self.current_edge = (route[0], route[1]) if len(route) > 1 else None

    def update_position(self, dt, lead_vehicle=None, red_light_node=None, gap_scale=1.0):
        """
        Updates position along the route segments with collision avoidance.
        If red_light_node is provided, the vehicle treats it as a wall.
        """
        if self.finished or not self.current_edge:
            return
            
        start_node, end_node = self.current_edge
        
        # Calculate distance and direction to next node
        dx = end_node[0] - self.x
        dy = end_node[1] - self.y
        dist_to_next = math.sqrt(dx*dx + dy*dy)
        
        # Calculate heading angle in radians
        self.angle = math.atan2(dy, dx)
        
        # Simple Collision Avoidance System (Intelligent Driver Model approximation)
        target_vel = self.target_speed

        # ── Red-light braking ──
        # If the next node in our route is a red-light junction, create a
        # virtual stationary obstacle at that node so the IDM math naturally
        # decelerates us to a full stop before the intersection.
        if red_light_node is not None:
            rlx, rly = red_light_node
            dist_to_light = math.sqrt((rlx - self.x)**2 + (rly - self.y)**2) - self.length
            if dist_to_light < self.stop_gap:
                target_vel = 0.0
            elif dist_to_light < 20.0:
                target_vel = min(target_vel, self.target_speed * (dist_to_light / 20.0))

        # ── Lead-vehicle following (gap sizes depend on vehicle type: bikes
        # and autos squeeze in much closer than cars, buses hang back) ──
        if lead_vehicle:
            # Calculate distance between centers minus vehicle lengths
            dx_lead = lead_vehicle.x - self.x
            dy_lead = lead_vehicle.y - self.y
            dist_to_lead = math.sqrt(dx_lead*dx_lead + dy_lead*dy_lead) - (self.length/2 + lead_vehicle.length/2)

            if dist_to_lead < self.stop_gap * gap_scale:
                # Dangerously close: Stop completely
                target_vel = 0.0
            elif dist_to_lead < self.follow_dist * gap_scale:
                # Approaching: Slow down to match leader speed
                target_vel = min(target_vel, lead_vehicle.speed * 0.8)
        
        # Smoothly interpolate current speed towards target velocity (inertia)
        self.speed += (target_vel - self.speed) * 4.0 * dt
        self.speed = max(0.0, self.speed) # Cannot go backwards
        
        # Calculate step distance
        step = self.speed * dt
        
        if step >= dist_to_next:
            # We reached the target node! Transition to next edge in route.
            self.route_index += 1
            if self.route_index >= len(self.route) - 1:
                # Route completed
                self.finished = True
                return
                
            # Set next segment
            self.x = end_node[0]
            self.y = end_node[1]
            self.current_edge = (self.route[self.route_index], self.route[self.route_index + 1])
        else:
            # Move along current segment direction
            ux = dx / max(dist_to_next, 0.001)
            uy = dy / max(dist_to_next, 0.001)
            self.x += ux * step
            self.y += uy * step


class TrafficSimulation:
    def __init__(self, scene_path=SCENE_PATH):
        self.scene_path = scene_path
        self.graph = nx.DiGraph()
        self.vehicles = {}
        self.vehicle_id_counter = 0
        self.road_nodes = []

        # Traffic light management
        self.traffic_lights = {}  # node -> TrafficLight
        self.junction_set = set()  # set of junction node tuples for fast lookup

        # Roundabout support (e.g. Mumbai Naka Circle): circulating traffic has
        # priority, entering vehicles yield at the entry node.
        self.roundabout_nodes = set()   # nodes lying on a circulating carriageway
        self.roundabout_edges = set()   # directed edges that are part of the circle

        # Elevation: flyover deck height per node. Nodes used only by elevated
        # ways (layer>0 / bridge) sit at DECK_HEIGHT; nodes shared with ground
        # roads are ramp ends at 0. Vehicle z interpolates along each edge.
        self.DECK_HEIGHT = 8.0
        self.node_height = {}           # node -> metres above ground

        # Incident injection: roads can be closed at runtime (accident, works).
        self.road_edges = {}            # road_id -> [(a, b), ...] directed edges
        self.closed_roads = {}          # road_id -> [(a, b, attrs), ...] removed edges

        # Weather coupling: rain slows traffic and stretches following gaps.
        # Set from the WeatherManager each broadcast cycle.
        self.rain_factor = 1.0          # target-speed multiplier (0.7 in rain)
        self.gap_scale = 1.0            # follow-distance multiplier (1.4 in rain)

        # Simulation control + metrics state
        self.speed_mult = 1              # 1x or 10x time scale
        self.sim_time = 0.0              # accumulated simulated seconds
        self.junction_crossings = []     # sim-timestamps of junction crossings (rolling window)
        self.target_density = 300        # active vehicles to maintain

        self.load_graph_from_scene()
        self.weather_manager = WeatherManager()  # loads .env (also provides TOMTOM_API_KEY)

        from simulation.live_traffic import LiveTrafficManager
        self.live_traffic = LiveTrafficManager()

    def load_graph_from_scene(self):
        """
        Builds a NetworkX directed graph from parsed OSM data.
        """
        p = Path(self.scene_path)
        if not p.exists():
            raise FileNotFoundError(
                f"Scene data not found at {p}. Run osm_loader.py (or restart the "
                f"server, which downloads it automatically) before starting the simulation."
            )

        with open(p, "r") as f:
            data = json.load(f)
            
        print(f"Simulation loading network graph from {p}...")
        
        # Add edges and nodes to Directed Graph
        for road in data["roads"]:
            coords = road["coordinates"]
            if len(coords) < 2:
                continue

            # Roads under construction are closed to traffic — keep them out of
            # the drivable graph (they remain in the scene for rendering).
            if road["type"] == "construction":
                continue

            is_roundabout = road.get("junction") in ("roundabout", "circular")
            is_elevated = road.get("layer", 0) > 0 or road.get("bridge", False)

            # Connect consecutive nodes in road coordinates
            for i in range(len(coords) - 1):
                pt_a = (coords[i]["x"], coords[i]["y"])
                pt_b = (coords[i+1]["x"], coords[i+1]["y"])
                
                # Calculate distance between nodes in meters
                dist = math.sqrt((pt_a[0] - pt_b[0])**2 + (pt_a[1] - pt_b[1])**2)
                
                # Add node coordinate attributes
                self.graph.add_node(pt_a, x=pt_a[0], y=pt_a[1])
                self.graph.add_node(pt_b, x=pt_b[0], y=pt_b[1])
                
                # Edge cost is travel time (distance / class speed), so A*
                # prefers the highway/flyover over parallel slow roads
                cost = dist / self.SPEED_FACTOR.get(road["type"], 1.0)

                # Add directed edge (A to B)
                self.graph.add_edge(pt_a, pt_b, weight=cost, length=dist,
                                    name=road["name"], oneway=road["oneway"],
                                    rtype=road["type"])
                self.road_edges.setdefault(road["id"], []).append((pt_a, pt_b))

                # If not a oneway street, add reverse edge (B to A)
                if not road["oneway"]:
                    self.graph.add_edge(pt_b, pt_a, weight=cost, length=dist,
                                        name=road["name"], oneway=road["oneway"],
                                        rtype=road["type"])
                    self.road_edges[road["id"]].append((pt_b, pt_a))

                if is_roundabout:
                    self.roundabout_nodes.add(pt_a)
                    self.roundabout_nodes.add(pt_b)
                    self.roundabout_edges.add((pt_a, pt_b))

                for pt in (pt_a, pt_b):
                    if is_elevated:
                        # Ground roads win: a node shared with a ground road is
                        # a ramp end and stays at 0
                        if self.node_height.get(pt) != 0.0:
                            self.node_height[pt] = self.DECK_HEIGHT
                    else:
                        self.node_height[pt] = 0.0
                    
        self.road_nodes = list(self.graph.nodes())
        print(f"Graph initialized: {len(self.graph.nodes())} intersection nodes, {len(self.graph.edges())} lane segments.")

        self._detect_boundary_gates()

        # ── Detect junctions and place traffic lights ──
        # A "junction" is any node where 3 or more edges meet (high graph degree).
        # This mirrors how real traffic engineers decide where to put signals.
        junction_count = 0
        for node in self.graph.nodes():
            # Roundabout nodes are yield-controlled, never signalised —
            # Mumbai Naka Circle has no traffic lights in reality.
            if node in self.roundabout_nodes:
                continue
            degree = self.graph.degree(node)  # in-degree + out-degree
            if degree >= 8:  # 4+ roads meeting (each road = 2 directed edges)
                phase = random.uniform(0, 25)  # Random offset so lights aren't synchronised
                self.traffic_lights[node] = TrafficLight(node, phase_offset=phase)
                self.junction_set.add(node)
                junction_count += 1
        print(f"Traffic lights placed at {junction_count} junctions. "
              f"Roundabout: {len(self.roundabout_nodes)} yield-controlled nodes.")

    # Share of trips that enter/exit the map at boundary gates (through-traffic).
    # The rest are local trips between random points.
    THROUGH_TRAFFIC_SHARE = 0.7

    # Bigger roads carry more entering traffic
    ROAD_CLASS_WEIGHT = {
        "motorway": 6.0, "trunk": 6.0, "primary": 4.0,
        "secondary": 3.0, "tertiary": 2.0,
    }

    # Relative free-flow speed per road class. A* edge cost is
    # distance / factor, so routes prefer faster road classes — this is what
    # sends through-traffic over the elevated corridor instead of the
    # parallel ground road of equal length.
    SPEED_FACTOR = {
        "motorway": 2.5, "trunk": 2.2, "primary": 1.6, "secondary": 1.3,
        "tertiary": 1.0, "residential": 0.8, "service": 0.6,
    }
    MAX_SPEED_FACTOR = 2.5  # keep the A* heuristic admissible

    def _detect_boundary_gates(self):
        """
        Finds "gates": stub nodes where a road is clipped at the edge of the
        downloaded area. Real traffic mostly enters/exits there (through
        traffic on the highway network), not at random interior points.
        A gate is a low-degree node in the outer 20% of the map radius,
        weighted by the class of its road.
        """
        self.entry_gates = []   # (node, weight) — can start a trip (has out-edges)
        self.exit_gates = []    # (node, weight) — can end a trip (has in-edges)

        if not self.road_nodes:
            return
        # Ways clipped by the Overpass radius end well outside CITY_RADIUS_M;
        # anything past ~70% of the radius counts as the edge of the map.
        threshold = CITY_RADIUS_M * 0.7

        for node in self.road_nodes:
            if math.hypot(node[0], node[1]) < threshold:
                continue
            # A stub is a polyline END: a pure source/sink (one-way road cut
            # off at the boundary) or a node whose edges all lead to a single
            # neighbour (two-way dead end). Interior nodes of a one-way road
            # also have degree 2, so a plain degree check does not work.
            neighbours = set(self.graph.predecessors(node)) | set(self.graph.successors(node))
            if not (self.graph.in_degree(node) == 0
                    or self.graph.out_degree(node) == 0
                    or len(neighbours) == 1):
                continue
            rtypes = [d.get("rtype", "") for _, _, d in self.graph.in_edges(node, data=True)]
            rtypes += [d.get("rtype", "") for _, _, d in self.graph.out_edges(node, data=True)]
            weight = max((self.ROAD_CLASS_WEIGHT.get(t, 1.0) for t in rtypes), default=1.0)
            if self.graph.out_degree(node) > 0:
                self.entry_gates.append((node, weight))
            if self.graph.in_degree(node) > 0:
                self.exit_gates.append((node, weight))

        print(f"Boundary gates: {len(self.entry_gates)} entries, {len(self.exit_gates)} exits "
              f"({self.THROUGH_TRAFFIC_SHARE:.0%} of trips are through-traffic).")

    def elevation_of(self, v):
        """Vehicle height above ground, ramp-interpolated along its edge."""
        if not v.current_edge:
            return 0.0
        a, b = v.current_edge
        ha = self.node_height.get(a, 0.0)
        hb = self.node_height.get(b, 0.0)
        if ha == 0.0 and hb == 0.0:
            return 0.0
        edge_len = math.hypot(b[0] - a[0], b[1] - a[1])
        if edge_len < 0.001:
            return hb
        t = min(1.0, math.hypot(v.x - a[0], v.y - a[1]) / edge_len)
        return ha + (hb - ha) * t

    def _roundabout_entry_blocked(self, entry_node, circulating_vehicles):
        """
        Yield-on-entry rule: a vehicle may join the circle only when no
        circulating vehicle is inside the entry zone or closing in on it.
        Circulating traffic always has priority (standard roundabout rule).
        """
        ex, ey = entry_node
        for v in circulating_vehicles:
            dx = ex - v.x
            dy = ey - v.y
            d = math.sqrt(dx * dx + dy * dy)
            if d < 8.0:
                return True  # entry point occupied
            if d < 22.0 and (math.cos(v.angle) * dx + math.sin(v.angle) * dy) > 0:
                return True  # circulating vehicle bearing down on the entry
        return False

    def get_distance_heuristic(self, node_a, node_b):
        """
        A* heuristic: straight-line distance at the fastest road class.
        Divided by MAX_SPEED_FACTOR so it never overestimates the
        time-based edge costs (stays admissible).
        """
        d = math.sqrt((node_a[0] - node_b[0])**2 + (node_a[1] - node_b[1])**2)
        return d / self.MAX_SPEED_FACTOR

    def find_route(self, start_node, goal_node):
        """
        A* pathfinding wrapper to calculate the shortest path.
        """
        try:
            path = nx.astar_path(
                self.graph, 
                start_node, 
                goal_node, 
                heuristic=self.get_distance_heuristic, 
                weight="weight"
            )
            return path
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return None

    def spawn_vehicle(self):
        """
        Spawns a new vehicle with a random start and end node.
        """
        if len(self.road_nodes) < 2:
            return
            
        # Origin/destination choice: most trips are through-traffic entering and
        # leaving at boundary gates (highway stubs at the map edge); the rest
        # are local trips between random interior points. A* itself tells us
        # whether a pair connects, so no separate has_path pre-check.
        through = (self.entry_gates and self.exit_gates
                   and random.random() < self.THROUGH_TRAFFIC_SHARE)
        if through:
            e_nodes, e_weights = zip(*self.entry_gates)
            x_nodes, x_weights = zip(*self.exit_gates)
            start = random.choices(e_nodes, weights=e_weights)[0]
        else:
            start = random.choice(self.road_nodes)

        route = None
        for _ in range(10):
            if through:
                goal = random.choices(x_nodes, weights=x_weights)[0]
            else:
                goal = random.choice(self.road_nodes)
            if goal == start:
                continue
            route = self.find_route(start, goal)
            if route and len(route) >= 2:
                break
        if not route or len(route) < 2:
            return  # Couldn't find a path this tick
            
        # Vehicle type follows the observed local traffic composition
        v_type = random.choices(
            list(VEHICLE_MIX.keys()), weights=list(VEHICLE_MIX.values())
        )[0]
        
        self.vehicle_id_counter += 1
        v_id = self.vehicle_id_counter
        
        self.vehicles[v_id] = Vehicle(v_id, route, v_type)

    def step(self, dt):
        """
        Performs one simulation step: traffic lights, physics, collisions, spawning, emissions.
        """
        # 0. Update all traffic lights
        for tl in self.traffic_lights.values():
            tl.update(dt)

        # 1. Manage active vehicles
        finished_ids = []
        vehicles_by_edge = {}
        
        # Group vehicles by road edge to detect line-following ordering
        for v in self.vehicles.values():
            if v.finished or not v.current_edge:
                continue
            # Key edge by coordinates
            edge_key = v.current_edge
            if edge_key not in vehicles_by_edge:
                vehicles_by_edge[edge_key] = []
            vehicles_by_edge[edge_key].append(v)
            
        # Circulating roundabout vehicles (priority traffic), collected once per step
        circulating = [
            v for ek, vs in vehicles_by_edge.items()
            if ek in self.roundabout_edges for v in vs
        ]

        # 2. Update physics with collision check + red-light/yield check
        for edge_key, vehicles_on_edge in vehicles_by_edge.items():
            # Sort vehicles along the edge based on progress (distance to start node)
            start_node = edge_key[0]
            end_node_of_edge = edge_key[1]
            vehicles_on_edge.sort(
                key=lambda v: (v.x - start_node[0])**2 + (v.y - start_node[1])**2, 
                reverse=True
            )

            # Check if the END node of this edge is a red-light junction,
            # or a roundabout entry we must yield at
            red_node = None
            if end_node_of_edge in self.junction_set:
                tl = self.traffic_lights[end_node_of_edge]
                if tl.is_red() or tl.is_yellow():
                    red_node = end_node_of_edge
            elif (end_node_of_edge in self.roundabout_nodes
                  and edge_key not in self.roundabout_edges
                  and self._roundabout_entry_blocked(end_node_of_edge, circulating)):
                # Arm feeding the circle: treat the entry point as a virtual
                # red light while circulating traffic occupies or approaches it
                red_node = end_node_of_edge
            
            # Update each vehicle
            for i, v in enumerate(vehicles_on_edge):
                lead = None
                if i > 0:
                    lead = vehicles_on_edge[i-1]
                # Calibrate to reality: TomTom gives the actual measured speed
                # on the nearest sampled road — cap vehicles at it directly
                # (20% headroom: the measured mean includes queued vehicles).
                # Falls back to free-flow x ratio when live data is off.
                max_v = VEHICLE_TYPES[v.type]["max_speed"]
                real_kmh = self.live_traffic.speed_at(v.x, v.y)
                if real_kmh:
                    v.target_speed = min(max_v, (real_kmh / 3.6) * 1.2) * v.speed_pref
                else:
                    v.target_speed = max_v * self.live_traffic.ratio_at(v.x, v.y) * v.speed_pref
                # Rain slows everyone down and stretches following distances
                v.target_speed *= self.rain_factor
                prev_index = v.route_index
                v.update_position(dt, lead, red_light_node=red_node, gap_scale=self.gap_scale)

                # Track junction crossings for flow metric
                if v.route_index > prev_index and end_node_of_edge in self.junction_set:
                    self.junction_crossings.append(self.sim_time)

                if v.finished:
                    finished_ids.append(v.id)

        # Remove finished vehicles
        for v_id in finished_ids:
            del self.vehicles[v_id]

        # 3. Dynamic Spawning: Maintain a target density.
        # Scales with time-of-day (rush hours) and, when live data is
        # available, with real network congestion.
        density = int(self.target_density * self.time_of_day_factor())
        if self.live_traffic.active:
            density = int(density * (0.7 + 0.6 * self.live_traffic.congestion))
        if len(self.vehicles) < density:
            # Spawn in bursts so density ramps up quickly
            for _ in range(min(4, density - len(self.vehicles))):
                self.spawn_vehicle()

        # 4. Total carbon emitted this step, in grams:
        # co2_rate [g/km] x distance travelled [km] = speed*dt/1000
        total_co2 = 0.0
        for v in self.vehicles.values():
            total_co2 += v.co2_rate * (v.speed * dt / 1000.0)

        # 5. Calculate road density (vehicles per edge) for heatmap
        road_density = {}
        for edge_key, vehicles_on_edge in vehicles_by_edge.items():
            # Key: "startX,startY|endX,endY" string for JSON serialisation
            key_str = f"{edge_key[0][0]:.1f},{edge_key[0][1]:.1f}|{edge_key[1][0]:.1f},{edge_key[1][1]:.1f}"
            road_density[key_str] = len(vehicles_on_edge)

        # 6. Advance simulated clock + compute live metrics
        self.sim_time += dt
        metrics = self.compute_metrics(total_co2, road_density)
        return metrics

    def compute_metrics(self, total_co2, road_density):
        """
        Computes dashboard telemetry from current vehicle states.
        All public-facing numbers are scaled by SIM_VEHICLE_FACTOR (1 sim veh = 2.5 veh).
        """
        queued_m = 0.0        # metres of stationary queue
        idle_co2 = 0.0        # kg CO2/h from idling vehicles
        idle_fuel = 0.0       # litres/h from idling vehicles
        delay_ratio_sum = 0.0 # sum of (1 - speed/max_speed)

        for v in self.vehicles.values():
            cfg = VEHICLE_TYPES[v.type]
            if v.speed < 1.5:
                queued_m += v.length + 2.0  # vehicle + typical gap
            # Idling waste includes stop-and-go crawl: quadratic weight below free flow
            slow = max(0.0, 1.0 - (v.speed / cfg["max_speed"]))
            idle_co2 += cfg["idle_co2"] * slow * slow * 2.0
            idle_fuel += cfg["idle_fuel"] * slow * slow * 2.0
            delay_ratio_sum += slow

        n = max(1, len(self.vehicles))
        # Average delay per vehicle over a 2-minute window (seconds lost to congestion)
        avg_delay_s = (delay_ratio_sum / n) * 120.0

        # Junction flow: network-wide junction crossings in the last 120 simulated
        # seconds, extrapolated to veh/h.
        window = 120.0
        cutoff = self.sim_time - window
        self.junction_crossings = [t for t in self.junction_crossings if t >= cutoff]
        elapsed = min(window, max(self.sim_time, 1.0))
        junction_flow = len(self.junction_crossings) * (3600.0 / elapsed) * SIM_VEHICLE_FACTOR

        # Network health: share of free-flow speed retained (0-100)
        health = max(0.0, 100.0 * (1.0 - (delay_ratio_sum / n)))

        return {
            "step_co2": total_co2,
            "road_density": road_density,
            "queued_m": queued_m * SIM_VEHICLE_FACTOR,
            "avg_delay_s": avg_delay_s,
            "junction_flow": junction_flow,
            "idle_co2_kg_h": idle_co2 * SIM_VEHICLE_FACTOR,
            "idle_fuel_l_h": idle_fuel * SIM_VEHICLE_FACTOR,
            "health": health,
        }

    # Traffic volume relative to peak, by local hour. Indian arterial pattern:
    # morning peak 8-11, evening peak 17-21, quiet nights.
    HOURLY_DENSITY = [
        0.30, 0.25, 0.22, 0.22, 0.28, 0.40,  # 00-05
        0.55, 0.75, 0.95, 1.00, 1.00, 0.90,  # 06-11
        0.80, 0.80, 0.75, 0.75, 0.85, 1.00,  # 12-17
        1.00, 1.00, 0.95, 0.80, 0.60, 0.40,  # 18-23
    ]

    def time_of_day_factor(self):
        """Density multiplier for the current local (IST) hour."""
        return self.HOURLY_DENSITY[time.localtime().tm_hour]

    def toggle_road(self, road_id):
        """
        Closes an open road (accident / roadworks scenario) or reopens a
        closed one. Returns True when the road is now closed.
        Closing removes its edges from the routing graph and reroutes every
        vehicle whose remaining route used them.
        """
        if road_id in self.closed_roads:
            for a, b, attrs in self.closed_roads.pop(road_id):
                self.graph.add_edge(a, b, **attrs)
            print(f"Road {road_id} reopened.")
            return False

        edges = self.road_edges.get(road_id)
        if not edges:
            return False
        removed = []
        for a, b in edges:
            if self.graph.has_edge(a, b):
                removed.append((a, b, dict(self.graph.edges[a, b])))
                self.graph.remove_edge(a, b)
        self.closed_roads[road_id] = removed

        closed_set = set(edges)
        rerouted = despawned = 0
        for v in list(self.vehicles.values()):
            if v.finished or not v.current_edge:
                continue
            remaining = [
                (v.route[i], v.route[i + 1])
                for i in range(v.route_index, len(v.route) - 1)
            ]
            if not any(e in closed_set for e in remaining):
                continue
            # Reroute from the end of the vehicle's current edge to its goal.
            # A vehicle already on the closed stretch simply rolls to the end
            # of its current segment and diverts there (physics doesn't
            # consult the graph mid-edge).
            resume, goal = v.current_edge[1], v.route[-1]
            new_route = self.find_route(resume, goal) if resume != goal else None
            if not new_route or len(new_route) < 2:
                # Original destination unreachable — divert to another exit
                # gate like a real driver would, instead of vanishing
                for _ in range(5):
                    if not self.exit_gates:
                        break
                    alt = random.choices(*zip(*[(n, w) for n, w in self.exit_gates]))[0]
                    if alt == resume:
                        continue
                    new_route = self.find_route(resume, alt)
                    if new_route and len(new_route) >= 2:
                        break
            if new_route and len(new_route) >= 2:
                v.route = [v.current_edge[0]] + new_route
                v.route_index = 0
                rerouted += 1
            else:
                v.finished = True  # trapped: no path remains anywhere
                despawned += 1
        print(f"Road {road_id} closed: {len(removed)} edges removed, "
              f"{rerouted} vehicles rerouted, {despawned} despawned.")
        return True

    def calibration_deviation(self):
        """
        Twin accuracy: mean |sim - real| / real speed across TomTom sample
        points that have >= 3 sim vehicles nearby. Percent, or None without
        live data. 0% = simulated speeds match measured reality exactly.
        """
        points = self.live_traffic.speed_points()
        if not points:
            return None
        devs = []
        R2 = 60.0 ** 2  # vehicles within 60 m of the sample point
        for px, py, _ratio, cur_kmh in points:
            if cur_kmh <= 0:
                continue
            speeds = [v.speed for v in self.vehicles.values()
                      if (v.x - px) ** 2 + (v.y - py) ** 2 < R2]
            if len(speeds) < 3:
                continue
            sim_kmh = (sum(speeds) / len(speeds)) * 3.6
            devs.append(abs(sim_kmh - cur_kmh) / cur_kmh)
        if not devs:
            return None
        return round(100.0 * sum(devs) / len(devs))


# Async runner for FastAPI integration
async def run_simulation_loop(sim, sio_server, run_event):
    """
    Simulation loop that runs in the background and broadcasts positions to WebSockets.
    """
    dt = 0.1  # Update physics at 10 Hz (updates every 100ms)
    print("Simulation background worker thread started.")
    
    total_co2_emitted = 0.0

    while True:
        if run_event.is_set():
            # Step the simulation physics (multiple sub-steps when time-scaled)
            metrics = None
            step_co2 = 0.0
            for _ in range(max(1, sim.speed_mult)):
                metrics = sim.step(dt)
                step_co2 += metrics["step_co2"]
            total_co2_emitted += step_co2

            # Format vehicle updates for frontend WebGL rendering
            vehicles_data = []
            for v in sim.vehicles.values():
                vehicles_data.append({
                    "id": v.id,
                    "x": round(v.x, 2),
                    "y": round(v.y, 2),
                    "z": round(sim.elevation_of(v), 2),  # flyover deck height
                    "angle": round(v.angle, 3),
                    "type": v.type,
                    "speed": round(v.speed * 3.6, 1) # Convert m/s to km/h for HUD display
                })

            # Serialise traffic light states
            lights_data = [tl.to_dict() for tl in sim.traffic_lights.values()]

            # get_weather may hit the OpenWeatherMap API with blocking I/O —
            # run it in a worker thread so the event loop (and websockets) never stall
            weather_data = await asyncio.to_thread(sim.weather_manager.get_weather)

            # Couple weather into the physics: rain = slower, bigger gaps
            raining = bool(weather_data.get("raining"))
            sim.rain_factor = 0.7 if raining else 1.0
            sim.gap_scale = 1.4 if raining else 1.0

            # Broadcast vehicle positions + traffic lights + telemetry
            await sio_server.emit("traffic_update", {
                "vehicles": vehicles_data,
                "co2_delta": round(step_co2, 2),
                "co2_total": round(total_co2_emitted, 1),
                "active_vehicles": len(sim.vehicles),
                "elapsed_time": int(sim.sim_time),  # simulated seconds — freezes when paused
                "weather": weather_data,
                "traffic_lights": lights_data,
                "road_density": metrics["road_density"],
                "speed_mult": sim.speed_mult,
                "live_traffic": sim.live_traffic.snapshot(),
                "closed_roads": list(sim.closed_roads.keys()),
                "metrics": {
                    "health": round(metrics["health"], 1),
                    "avg_delay_s": round(metrics["avg_delay_s"]),
                    "junction_flow": round(metrics["junction_flow"]),
                    "queued_m": round(metrics["queued_m"]),
                    "idle_co2_kg_h": round(metrics["idle_co2_kg_h"]),
                    "idle_fuel_l_h": round(metrics["idle_fuel_l_h"]),
                    "calibration_dev_pct": sim.calibration_deviation(),
                },
            })

        await asyncio.sleep(dt)
