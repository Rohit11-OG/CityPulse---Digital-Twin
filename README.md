# CityPulse — Digital Twin

A 3D digital twin and live traffic simulator of a real city area, built from
OpenStreetMap data. A FastAPI backend runs a 10 Hz traffic physics simulation
(A* routing, car-following, traffic-light FSMs, CO₂/fuel metrics) and streams
vehicle positions over Socket.IO to a Next.js + Three.js frontend that renders
the city in clay-render 3D.

**Default location:** Mumbai Naka Circle, Nashik, India — configurable via `.env`.

## Architecture

```text
backend/                     FastAPI + python-socketio
  config.py                  paths, city coords, CORS (loads .env)
  osm_loader.py              downloads roads/buildings/parks from Overpass API
  main.py                    HTTP API + websocket server + sim lifecycle
  simulation/
    traffic_engine.py        vehicles, traffic lights, physics, metrics
    live_traffic.py          real congestion via TomTom Flow API (optional)
    weather.py               real weather via OpenWeatherMap (optional)

frontend/                    Next.js 16 + React 19 + Three.js
  src/components/Scene3D/CityViewer.tsx   3D scene, socket client, HUD
```

## Prerequisites

- Python 3.13+ and Node.js 20+
- No API keys required — weather and live traffic degrade gracefully to simulated data

## Run

**Backend** (terminal 1):

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows  (Linux/Mac: source .venv/bin/activate)
pip install -r requirements.txt
python main.py                  # first boot auto-downloads OSM scene data (~30s)
```

Server: `http://localhost:8000`

**Frontend** (terminal 2):

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`

## Configuration (optional)

Copy `backend/.env.example` to `backend/.env`:

| Variable | Purpose |
| --- | --- |
| `OPENWEATHER_API_KEY` | Live weather sync (rain/temperature) |
| `TOMTOM_API_KEY` | Real road congestion drives sim speeds and density |
| `CITY_LAT` / `CITY_LON` / `CITY_RADIUS_M` | Simulate a different location (delete `backend/data/scene.json` after changing) |
| `CORS_ORIGINS` | Allowed frontend origins, comma-separated |

Never commit `.env` — it is gitignored.

## Tests

```bash
cd backend
pip install pytest
pytest
```
