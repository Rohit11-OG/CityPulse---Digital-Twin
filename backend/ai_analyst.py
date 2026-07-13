"""
AI city analyst: natural-language Q&A over the live twin, with tool use —
the model can close/reopen roads and fast-forward the simulation to run
what-if experiments, then report measured impact.

Uses NVIDIA NIM (OpenAI-compatible chat completions with tools).
Set NVIDIA_API_KEY in backend/.env. Model override: NIM_MODEL.
"""
import os
import json
import asyncio

import requests

NIM_URL = os.environ.get(
    "NIM_BASE_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
NIM_MODEL = os.environ.get("NIM_MODEL", "meta/llama-3.3-70b-instruct")

MAX_TOOL_ROUNDS = 6
FAST_FORWARD_CAP_S = 120

TOOLS = [
    {"type": "function", "function": {
        "name": "toggle_road",
        "description": "Close an open road (traffic reroutes automatically) or reopen "
                       "a closed one. Returns the new state. Use for what-if experiments; "
                       "always reopen roads you closed unless the user asked to keep them closed.",
        "parameters": {"type": "object", "properties": {
            "road_id": {"type": "integer", "description": "OSM way id from the road list"},
        }, "required": ["road_id"]},
    }},
    {"type": "function", "function": {
        "name": "get_state",
        "description": "Current simulation metrics: health, delay, flow, queues, "
                       "emissions, vehicle count, closed roads, weather, congestion.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "fast_forward",
        "description": f"Advance the simulation by N simulated seconds (max {FAST_FORWARD_CAP_S}) "
                       "so effects of a change settle before measuring. Use ~60s after closing a road.",
        "parameters": {"type": "object", "properties": {
            "seconds": {"type": "integer"},
        }, "required": ["seconds"]},
    }},
]


def _snapshot(sim):
    m = sim.compute_metrics(0.0, 0)
    closed = []
    for rid in sim.closed_roads:
        edges = sim.road_edges.get(rid, [])
        name = ""
        if edges and sim.graph is not None:
            # name lives on the removed-edge attrs; use stored ones
            name = sim.closed_roads[rid][0][2].get("name", "") if sim.closed_roads[rid] else ""
        closed.append({"road_id": rid, "name": name})
    return {
        "network_health_pct": round(m["health"]),
        "avg_delay_s_per_veh_2min": round(m["avg_delay_s"]),
        "junction_flow_veh_h": round(m["junction_flow"]),
        "queued_m": round(m["queued_m"]),
        "idle_co2_kg_h": round(m["idle_co2_kg_h"]),
        "active_vehicles": len(sim.vehicles),
        "closed_roads": closed,
        "live_congestion_pct": round(sim.live_traffic.congestion * 100)
                               if sim.live_traffic.active else None,
        "calibration_deviation_pct": sim.calibration_deviation(),
        "raining": sim.weather_manager.raining,
        "temp_c": sim.weather_manager.temp,
    }


def _major_roads(sim):
    """Unique named drivable roads with their ids, for the system prompt."""
    seen = {}
    for rid, edges in sim.road_edges.items():
        if not edges:
            continue
        a, b = edges[0]
        if sim.graph.has_edge(a, b):
            d = sim.graph.edges[a, b]
        elif rid in sim.closed_roads and sim.closed_roads[rid]:
            d = sim.closed_roads[rid][0][2]
        else:
            continue
        name, rtype = d.get("name", ""), d.get("rtype", "")
        if name and name != "Unnamed Road" and name not in seen:
            seen[name] = {"road_id": rid, "name": name, "type": rtype}
    return list(seen.values())[:30]


async def _run_tool(sim, name, args):
    if name == "get_state":
        return _snapshot(sim)
    if name == "toggle_road":
        rid = int(args["road_id"])
        if rid not in sim.road_edges:
            return {"error": f"unknown road_id {rid}"}
        closed = sim.toggle_road(rid)
        return {"road_id": rid, "closed": closed}
    if name == "fast_forward":
        seconds = max(1, min(int(args.get("seconds", 30)), FAST_FORWARD_CAP_S))
        steps = seconds * 10
        for i in range(steps):
            sim.step(0.1)
            if i % 100 == 0:
                await asyncio.sleep(0)  # let websockets breathe
        return {"advanced_sim_seconds": seconds, "state_after": _snapshot(sim)}
    return {"error": f"unknown tool {name}"}


async def ask(live_sim, question):
    """Agent loop: question -> (tool calls)* -> final answer.

    Experiments run on an isolated sandbox copy of the live simulation, so the
    view other clients watch is never disturbed and concurrent questions can't
    corrupt each other.
    """
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        return {"answer": "AI analyst is not configured: add NVIDIA_API_KEY to backend/.env "
                          "(get one free at build.nvidia.com) and restart the server.",
                "actions": []}

    sim = live_sim.clone_for_experiment()

    system = (
        "You are the traffic analyst embedded in a live digital twin of the Mumbai Naka "
        "area of Nashik, India: a signal-free roundabout (Mumbai Naka Circle), the elevated "
        "Mumbai-Agra Highway corridor passing over it, and surrounding arterials. The "
        "simulation is calibrated against live TomTom speeds. Traffic is Indian mixed "
        "traffic (~46% two-wheelers). One simulated vehicle represents 2.5 real vehicles.\n\n"
        "Your experiments run on a private sandbox copy of the current network — closing "
        "roads and fast-forwarding here do NOT affect the live map.\n"
        "CRITICAL: never invent or estimate numbers. For any what-if question you MUST use "
        "the tools to get real measurements: call get_state for the baseline, toggle_road to "
        "make the change, fast_forward with 60 seconds, then get_state again — only THEN give "
        "your answer with the actual before/after numbers the tools returned. No need to reopen "
        "the road afterwards (it's a sandbox). For a lasting change on the real network, tell "
        "the user to shift+click the road on the map. Answer concisely. If asked something "
        "outside traffic/city scope, decline briefly.\n\n"
        f"Major roads (road_id: name, class): {json.dumps(_major_roads(sim))}\n\n"
        f"State now: {json.dumps(_snapshot(sim))}"
    )
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": str(question)[:2000]}]
    actions = []

    def call_nim():
        return requests.post(
            NIM_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": NIM_MODEL, "messages": messages, "tools": TOOLS,
                  "tool_choice": "auto", "temperature": 0.2, "max_tokens": 800},
            timeout=90,
        )

    for _ in range(MAX_TOOL_ROUNDS):
        try:
            resp = await asyncio.to_thread(call_nim)
        except requests.RequestException as e:
            return {"answer": f"AI service unreachable or slow ({type(e).__name__}). "
                              "The NVIDIA endpoint may be busy — try again.", "actions": actions}
        if resp.status_code != 200:
            return {"answer": f"AI backend error {resp.status_code}: {resp.text[:200]}",
                    "actions": actions}
        try:
            msg = resp.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError):
            return {"answer": "AI returned an unexpected response format.", "actions": actions}
        messages.append(msg)

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return {"answer": msg.get("content") or "(no answer)", "actions": actions}

        for tc in tool_calls:
            fn = tc["function"]["name"]
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = await _run_tool(sim, fn, args)
            actions.append({"tool": fn, "args": args,
                            "summary": {k: v for k, v in result.items() if k != "state_after"}})
            messages.append({"role": "tool", "tool_call_id": tc.get("id", fn),
                             "content": json.dumps(result)})

    return {"answer": "Experiment ran long — tool budget exhausted. Partial actions listed.",
            "actions": actions}
