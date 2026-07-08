import json
import asyncio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import socketio

from config import SCENE_PATH, CORS_ORIGINS, CITY_LAT, CITY_LON, CITY_RADIUS_M

# Import our custom traffic simulation classes
from simulation.traffic_engine import TrafficSimulation, run_simulation_loop

# Global variables for simulation control
sim = None
run_event = asyncio.Event()
simulation_task = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manages the startup and shutdown lifecycle of the FastAPI server.
    Spawns the traffic physics engine as a background task.
    """
    global sim, run_event, simulation_task

    # Fetch OSM data on first boot so the server never crashes on a missing scene
    if not SCENE_PATH.exists():
        print(f"Scene data not found at {SCENE_PATH}. Downloading from OpenStreetMap...")
        from osm_loader import download_and_process_scene
        await asyncio.to_thread(
            download_and_process_scene, CITY_LAT, CITY_LON, CITY_RADIUS_M
        )

    sim = TrafficSimulation()

    # Enable simulation by default
    run_event.set()

    # Spawn background task
    simulation_task = asyncio.create_task(run_simulation_loop(sim, sio, run_event))
    print("FastAPI Lifespan: Started background simulation loop.")

    yield

    # Clean up on shutdown
    if simulation_task:
        simulation_task.cancel()
        try:
            await simulation_task
        except asyncio.CancelledError:
            pass
        print("FastAPI Lifespan: Cancelled background simulation loop.")

# Initialize FastAPI App with our lifespan context manager
app = FastAPI(title="CityPulse Backend", version="1.0.0", lifespan=lifespan)

# CORS: explicit origins — a wildcard is invalid alongside allow_credentials
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Socket.IO Server with ASGI integration
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=CORS_ORIGINS)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# Scene JSON is static after download — read it once and serve from memory
_scene_cache = None

@app.get("/")
def read_root():
    return {"status": "ok", "message": "CityPulse Backend API is running."}

@app.get("/api/scene")
def get_scene():
    """Serves the downloaded and parsed road and building network data."""
    global _scene_cache
    if _scene_cache is None:
        if not SCENE_PATH.exists():
            return {"error": "Scene data not found. Restart the server to trigger a download."}
        with open(SCENE_PATH, "r") as f:
            _scene_cache = json.load(f)
    return _scene_cache

# Socket.IO Event Handlers
@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    # Welcome message
    await sio.emit("message", {"data": "Connected to CityPulse Real-time Server"}, to=sid)

@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")

@sio.event
async def start_simulation(sid, data):
    """Start the simulation loop."""
    print("Starting simulation request received")
    run_event.set()
    await sio.emit("simulation_status", {"status": "running"})

@sio.event
async def stop_simulation(sid, data):
    """Stop the simulation loop."""
    print("Stopping/Pausing simulation request received")
    run_event.clear()
    await sio.emit("simulation_status", {"status": "stopped"})

@sio.event
async def set_speed(sid, data):
    """Set simulation time scale (1x / 10x)."""
    global sim
    mult = int(data.get("mult", 1))
    if sim and mult in (1, 10):
        sim.speed_mult = mult
        print(f"Simulation speed set to {mult}x")
        await sio.emit("simulation_speed", {"mult": mult})

if __name__ == "__main__":
    uvicorn.run(socket_app, host="0.0.0.0", port=8000)
