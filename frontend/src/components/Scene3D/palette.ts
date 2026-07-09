// Visual constants — clay-render palette + vehicle appearance + shared config

import type { VehicleType } from "./types";

export const PALETTE = {
  skyDay: 0xe3e6ea,
  ground: 0xd8d5cc,
  groundNight: 0x17181f,
  clay: 0xf4f2ec,
  clayNight: 0x97824c,
  clayEdge: 0xb8b3a6,
  clayEdgeNight: 0x1a1916,
  glass: 0x9db1c4,
  glassNight: 0x252c3c,
  asphalt: 0x3c3f45,
  asphaltNight: 0x191b20,
  grass: 0x83b45c,
  grassNight: 0x1c2b18,
  path: 0xd9c9a4,
  window: 0xffb75e,
};

// Slightly over-scaled (~1.2x) so traffic reads clearly from orbit height
export const VEHICLE_DIMS: Record<VehicleType, { w: number; h: number; l: number }> = {
  car: { w: 2.4, h: 1.8, l: 5.3 },
  bus: { w: 3.1, h: 4.1, l: 13.2 },
  auto: { w: 2.0, h: 2.4, l: 3.6 },
  bike: { w: 1.1, h: 1.9, l: 2.4 },
  truck: { w: 3.0, h: 3.8, l: 9.0 },
};

export const VEHICLE_COLORS: Record<VehicleType, string[]> = {
  car: ["#f5f5f2", "#d9dde2", "#2f3640", "#e8c02a", "#b4372c", "#e9e4d6", "#8a9199", "#f5f5f2"],
  bus: ["#e0721f", "#e0721f", "#2e8b57", "#d95f18"],
  auto: ["#f2c12e", "#f2c12e", "#e8b400"],
  bike: ["#33383f", "#4a4f57"],
  truck: ["#3a7d44", "#5a6268", "#7a4f2a"],
};

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

// Backend origin for REST + websocket; override with NEXT_PUBLIC_BACKEND_URL
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";
