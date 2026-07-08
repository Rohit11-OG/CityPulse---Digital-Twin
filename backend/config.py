"""
Central configuration for the CityPulse backend.

All paths are resolved relative to this file, so the server works no matter
which directory it is launched from. The .env file is parsed here exactly
once, before any setting that may be overridden by an environment variable
is read.
"""
import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
DATA_DIR = BACKEND_DIR / "data"
SCENE_PATH = DATA_DIR / "scene.json"
ENV_PATH = BACKEND_DIR / ".env"


def _load_dotenv(path: Path = ENV_PATH) -> None:
    """Parses KEY=VALUE lines from .env into os.environ (no extra deps)."""
    if not path.exists():
        return
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()

# Simulated city centre. Defaults to Mumbai Naka Circle, Nashik, Maharashtra.
# Override via environment or .env: CITY_LAT / CITY_LON / CITY_RADIUS_M.
CITY_LAT = float(os.environ.get("CITY_LAT", "19.98708"))
CITY_LON = float(os.environ.get("CITY_LON", "73.78399"))
CITY_RADIUS_M = int(os.environ.get("CITY_RADIUS_M", "600"))

# Frontend origins allowed to call the API / websocket.
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if o.strip()
]
