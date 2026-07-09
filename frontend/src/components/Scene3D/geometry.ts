// Pure geometry helpers for the 3D scene (no three.js scene state)

import * as THREE from "three";
import type { NodeCoord, Road, Building } from "./types";

/** Flat road ribbon from a polyline (XZ plane, three.js coords).
 *  `y` may be a per-point height array (flyover ramps) or a constant. */
export function buildRibbon(pts: THREE.Vector2[], width: number, y: number | number[]): THREE.BufferGeometry | null {
  if (pts.length < 2) return null;
  const half = width / 2;
  const positions: number[] = [];
  const indices: number[] = [];

  const dirs: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    dirs.push(new THREE.Vector2().subVectors(pts[i + 1], pts[i]).normalize());
  }

  for (let i = 0; i < pts.length; i++) {
    const d = i === 0 ? dirs[0] : i === pts.length - 1 ? dirs[i - 1] : new THREE.Vector2().addVectors(dirs[i - 1], dirs[i]).normalize();
    // Perpendicular in XZ plane
    const nx = -d.y, nz = d.x;
    const py = Array.isArray(y) ? y[i] : y;
    positions.push(pts[i].x + nx * half, py, pts[i].y + nz * half);
    positions.push(pts[i].x - nx * half, py, pts[i].y - nz * half);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Polyline shifted sideways by `offset` metres (positive = left of travel). */
export function offsetPolyline(pts: THREE.Vector2[], offset: number): THREE.Vector2[] {
  if (pts.length < 2) return pts;
  const dirs: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    dirs.push(new THREE.Vector2().subVectors(pts[i + 1], pts[i]).normalize());
  }
  return pts.map((p, i) => {
    const d = i === 0 ? dirs[0] : i === pts.length - 1 ? dirs[i - 1]
      : new THREE.Vector2().addVectors(dirs[i - 1], dirs[i]).normalize();
    return new THREE.Vector2(p.x + -d.y * offset, p.y + d.x * offset);
  });
}

/** Point-in-polygon (sim coords x,y). */
export function pointInPolygon(x: number, y: number, poly: NodeCoord[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: NodeCoord[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

export function polygonCentroid(poly: NodeCoord[]): NodeCoord {
  let cx = 0, cy = 0;
  poly.forEach((p) => { cx += p.x; cy += p.y; });
  return { x: cx / poly.length, y: cy / poly.length };
}

/** Rendered ribbon width for a road (metres). */
export function roadWidth(road: Road): number {
  if (["service", "residential", "unclassified", "living_street"].includes(road.type)) return 4.5;
  if (road.type === "tertiary") return 7;
  return Math.max(road.lanes, 2) * 3.2 + 1.0;
}

/** Squared distance from point to segment (sim coords). */
export function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}

/** Drops buildings whose footprint intrudes into a road ribbon (bad OSM overlaps). */
export function filterBuildingsOffRoads(buildings: Building[], roads: Road[]): Building[] {
  type Seg = { ax: number; ay: number; bx: number; by: number; half: number };
  const groundSegs: Seg[] = [];
  const deckSegs: Seg[] = []; // elevated corridor footprint
  roads.forEach((r) => {
    if (!r.coordinates || r.coordinates.length < 2) return;
    const elevated = (r.layer ?? 0) > 0 || !!r.bridge;
    const half = roadWidth(r) / 2 + 1.0;
    const list = elevated ? deckSegs : groundSegs;
    for (let i = 0; i < r.coordinates.length - 1; i++) {
      list.push({
        ax: r.coordinates[i].x, ay: r.coordinates[i].y,
        bx: r.coordinates[i + 1].x, by: r.coordinates[i + 1].y, half,
      });
    }
  });
  // Depth of intrusion into a road ribbon: 0 = outside, 1 = on the centerline
  const depthIn = (segs: Seg[], x: number, y: number) => {
    let depth = 0;
    for (const s of segs) {
      const d2 = distSqToSegment(x, y, s.ax, s.ay, s.bx, s.by);
      if (d2 < s.half * s.half) {
        depth = Math.max(depth, 1 - Math.sqrt(d2) / s.half);
        if (depth > 0.99) break;
      }
    }
    return depth;
  };

  const DECK_CLEARANCE = 6; // buildings taller than this would pierce the deck

  return buildings.filter((b) => {
    if (!b.coordinates || b.coordinates.length < 3) return false;
    // Under the flyover only low structures survive; tall ones poke through the deck
    const cullDeck = b.height > DECK_CLEARANCE;
    const c = polygonCentroid(b.coordinates);
    if (depthIn(groundSegs, c.x, c.y) > 0) return false;
    if (cullDeck && depthIn(deckSegs, c.x, c.y) > 0) return false;

    // Sample along the footprint outline (~every 6m), not just its vertices —
    // a footprint can straddle a road with every vertex outside the ribbon
    let samples = 0, inside = 0;
    const n = b.coordinates.length;
    for (let i = 0; i < n; i++) {
      const p = b.coordinates[i], q = b.coordinates[(i + 1) % n];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
        const depth = depthIn(groundSegs, x, y);
        samples++;
        if (depth > 0) inside++;
        if (depth > 0.25) return false; // outline reaches the carriageway
        if (cullDeck && depthIn(deckSegs, x, y) > 0.25) return false;
      }
    }
    return inside / samples < 0.25; // mostly-on-road footprints
  });
}
