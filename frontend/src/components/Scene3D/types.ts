// Shared type definitions for the Scene3D module

export interface NodeCoord { x: number; y: number; }

export interface Building {
  id: number; coordinates: NodeCoord[]; height: number; type: string;
}

export interface Road {
  id: number; coordinates: NodeCoord[]; type: string; name: string; lanes: number;
  junction?: string; layer?: number; bridge?: boolean;
}

export interface Green {
  id: number; coordinates: NodeCoord[]; kind: string; name: string;
}

export interface Landmark { name: string; kind: string; x: number; y: number; }

export interface SceneData {
  roads: Road[]; buildings: Building[]; greens?: Green[]; trees?: NodeCoord[]; landmarks?: Landmark[];
}

export interface SocketVehicle {
  id: number; x: number; y: number; z?: number; angle: number; type: string; speed: number;
}

export interface TrafficLightData { x: number; y: number; state: string; }

export interface ClientVehicle {
  id: number; type: string; speed: number;
  currentX: number; currentY: number; currentZ: number; currentAngle: number;
  targetX: number; targetY: number; targetZ: number; targetAngle: number;
}

export interface Metrics {
  health: number; avg_delay_s: number; junction_flow: number;
  queued_m: number; idle_co2_kg_h: number; idle_fuel_l_h: number;
  calibration_dev_pct?: number | null;
}

export type VehicleType = "car" | "bus" | "auto" | "bike" | "truck";
