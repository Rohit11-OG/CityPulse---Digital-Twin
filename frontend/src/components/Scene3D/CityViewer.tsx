"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { io, Socket } from "socket.io-client";
import { LineChart, Line, YAxis } from "recharts";

import type {
  SceneData, Road, Building, Green, SocketVehicle, TrafficLightData,
  ClientVehicle, Metrics, VehicleType,
} from "./types";
import { PALETTE, VEHICLE_DIMS, VEHICLE_COLORS, fmt, BACKEND_URL } from "./palette";
import {
  buildRibbon, offsetPolyline, pointInPolygon, polygonArea, polygonCentroid,
  roadWidth, distSqToSegment, filterBuildingsOffRoads,
} from "./geometry";

// ═══════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════

export default function CityViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Telemetry (video HUD)
  const [metrics, setMetrics] = useState<Metrics>({
    health: 100, avg_delay_s: 0, junction_flow: 0, queued_m: 0, idle_co2_kg_h: 0, idle_fuel_l_h: 0,
  });
  const [idleDelta, setIdleDelta] = useState<number>(0);
  const idlePrevRef = useRef<{ t: number; v: number }>({ t: 0, v: 0 });
  const [liveTraffic, setLiveTraffic] = useState<{ active: boolean; congestion: number }>({ active: false, congestion: 0 });
  const [selectedVehicle, setSelectedVehicle] = useState<{ id: number; type: string; speed: number } | null>(null);
  const selectedVehicleIdRef = useRef<number | null>(null);
  const [history, setHistory] = useState<{ health: number; flow: number }[]>([]);
  const historyPrevRef = useRef<number>(0);

  // Modes (URL params allow deep-linking a mode, e.g. ?night=1&rain=1)
  const [isNight, setIsNight] = useState<boolean>(false);
  const [isRaining, setIsRaining] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"live" | "demo">("live");
  const [speedMult, setSpeedMult] = useState<number>(1);

  // Deep-link init from URL params — must run in an effect: window is
  // undefined during the server prerender pass, and lazy useState would
  // cause a hydration mismatch when a param is set
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("night") === "1") setIsNight(true);
    if (params.get("rain") === "1") setIsRaining(true);
    if (params.get("demo") === "1") setViewMode("demo");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Refs for the render loop
  const isNightRef = useRef(false);
  const isRainingRef = useRef(false);
  const demoRef = useRef(false);
  const orbitDirRef = useRef(0); // -1 backward, 0 idle, 1 forward
  const vehiclesMapRef = useRef<Map<number, ClientVehicle>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  const clockRef = useRef<THREE.Clock>(new THREE.Clock());

  const trafficLightMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());

  useEffect(() => { isNightRef.current = isNight; }, [isNight]);
  useEffect(() => { isRainingRef.current = isRaining; }, [isRaining]);
  useEffect(() => { demoRef.current = viewMode === "demo"; }, [viewMode]);

  const setSpeed = (mult: number) => {
    setSpeedMult(mult);
    socketRef.current?.emit("set_speed", { mult });
  };

  // ═══════════════════════════════════════════════════════
  // THREE.JS SCENE
  // ═══════════════════════════════════════════════════════

  useEffect(() => {
    if (!containerRef.current) return;

    let scene: THREE.Scene;
    let camera: THREE.PerspectiveCamera;
    let renderer: THREE.WebGLRenderer;
    let controls: OrbitControls;
    let animationFrameId: number;

    let ambientLight: THREE.AmbientLight;
    let sunLight: THREE.DirectionalLight;
    let hemiLight: THREE.HemisphereLight;
    let skyUniforms: { uMix: { value: number } };

    let flagGeo: THREE.PlaneGeometry | null = null;

    // Rain streaks (line segments)
    const RAIN_COUNT = 2200;
    let rainLines: THREE.LineSegments;
    let rainPositions: Float32Array;

    // Meshes that switch day/night
    let clayMesh: THREE.Mesh | null = null;
    let glassMesh: THREE.Mesh | null = null;
    let clayEdges: THREE.LineSegments | null = null;
    let groundMesh: THREE.Mesh | null = null;
    const asphaltMeshes: THREE.Mesh[] = [];
    const grassMeshes: THREE.Mesh[] = [];
    let windowsMesh: THREE.Mesh | null = null;
    let lampBulbs: THREE.InstancedMesh | null = null;
    let lampGlow: THREE.InstancedMesh | null = null;
    let treeCanopy: THREE.InstancedMesh | null = null;

    // Vehicles
    const bodyMeshes = {} as Record<VehicleType, THREE.InstancedMesh>;
    // instance index -> vehicle id, per type; rebuilt every render frame so
    // clicks on an InstancedMesh can resolve to the actual vehicle
    const instanceIds: Record<VehicleType, number[]> = { car: [], bus: [], auto: [], bike: [], truck: [] };
    const headlightMeshes = {} as Record<VehicleType, THREE.InstancedMesh>;
    const taillightMeshes = {} as Record<VehicleType, THREE.InstancedMesh>;
    const MAX_INSTANCES = 600;
    const dummy = new THREE.Object3D();

    // ─── Scene / lights / sky ───
    const initThree = () => {
      const w = containerRef.current!.clientWidth;
      const h = containerRef.current!.clientHeight;

      scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(PALETTE.skyDay, 0.00075);

      camera = new THREE.PerspectiveCamera(45, w / h, 1, 6000);
      camera.position.set(260, 380, 420);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      containerRef.current!.innerHTML = "";
      containerRef.current!.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.maxPolarAngle = Math.PI / 2 - 0.04;
      controls.minDistance = 25;
      controls.maxDistance = 1600;
      controls.autoRotateSpeed = 0.8;

      // Gradient sky dome (day haze ↔ dusk gradient)
      skyUniforms = { uMix: { value: 0 } };
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uMix: skyUniforms.uMix,
          dayTop: { value: new THREE.Color(0xdadfe6) },
          dayBottom: { value: new THREE.Color(0xecedee) },
          duskTop: { value: new THREE.Color(0x10142e) },
          duskMid: { value: new THREE.Color(0x4a4066) },
          duskHorizon: { value: new THREE.Color(0xf0a832) },
        },
        vertexShader: `
          varying vec3 vPos;
          void main() {
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uMix;
          uniform vec3 dayTop; uniform vec3 dayBottom;
          uniform vec3 duskTop; uniform vec3 duskMid; uniform vec3 duskHorizon;
          varying vec3 vPos;
          void main() {
            float h = normalize(vPos).y;
            vec3 day = mix(dayBottom, dayTop, smoothstep(0.0, 0.5, h));
            // Wide golden band low on the horizon fading through violet to navy
            vec3 dusk = mix(duskHorizon, duskMid, smoothstep(0.02, 0.30, h));
            dusk = mix(dusk, duskTop, smoothstep(0.30, 0.70, h));
            dusk = mix(duskHorizon * 1.15, dusk, smoothstep(-0.02, 0.10, h));
            dusk = mix(duskHorizon * 0.30, dusk, smoothstep(-0.10, -0.01, h));
            gl_FragColor = vec4(mix(day, dusk, uMix), 1.0);
          }
        `,
      });
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(2800, 32, 20), skyMat));

      ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
      scene.add(ambientLight);

      sunLight = new THREE.DirectionalLight(0xfff3de, 1.35);
      sunLight.position.set(350, 520, 220);
      sunLight.castShadow = true;
      sunLight.shadow.mapSize.set(4096, 4096);
      sunLight.shadow.camera.left = -900;
      sunLight.shadow.camera.right = 900;
      sunLight.shadow.camera.top = 900;
      sunLight.shadow.camera.bottom = -900;
      sunLight.shadow.camera.far = 2200;
      sunLight.shadow.bias = -0.0004;
      scene.add(sunLight);

      hemiLight = new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 0.5);
      scene.add(hemiLight);

      // Ground
      const groundMat = new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 1.0 });
      groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), groundMat);
      groundMesh.rotation.x = -Math.PI / 2;
      groundMesh.receiveShadow = true;
      scene.add(groundMesh);
    };

    // ─── Buildings: clay low-rise + glass towers, merged ───
    const createBuildings = (buildings: Building[]) => {
      const clayGeoms: THREE.BufferGeometry[] = [];
      const glassGeoms: THREE.BufferGeometry[] = [];
      const edgeGeoms: THREE.BufferGeometry[] = [];
      const clutterMatrices: THREE.Matrix4[] = [];

      buildings.forEach((b) => {
        if (!b.coordinates || b.coordinates.length < 3) return;
        // OSM often lacks height data — fall back to a varied 6-15m (deterministic per id)
        const height = b.height && b.height > 5 ? b.height : 6 + ((b.id % 97) / 97) * 9;

        const shape = new THREE.Shape();
        shape.moveTo(b.coordinates[0].x, -b.coordinates[0].y);
        for (let i = 1; i < b.coordinates.length; i++) {
          shape.lineTo(b.coordinates[i].x, -b.coordinates[i].y);
        }
        shape.closePath();

        const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
        geom.rotateX(-Math.PI / 2);

        if (height >= 30) {
          glassGeoms.push(geom);
        } else {
          clayGeoms.push(geom);
          edgeGeoms.push(new THREE.EdgesGeometry(geom, 30));

          // Roof clutter: AC units / water tanks
          const c = polygonCentroid(b.coordinates);
          const n = 1 + Math.floor(Math.random() * 3);
          for (let k = 0; k < n; k++) {
            const m = new THREE.Matrix4();
            const s = 1.2 + Math.random() * 2.2;
            m.makeRotationY(Math.random() * Math.PI);
            m.setPosition(
              c.x + (Math.random() - 0.5) * 8,
              height + s * 0.4,
              -c.y + (Math.random() - 0.5) * 8
            );
            m.multiply(new THREE.Matrix4().makeScale(s, s * 0.8, s));
            clutterMatrices.push(m);
          }
        }
      });

      if (clayGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(clayGeoms);
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.clay, roughness: 0.95, metalness: 0.0 });
        clayMesh = new THREE.Mesh(merged, mat);
        clayMesh.castShadow = true;
        clayMesh.receiveShadow = true;
        scene.add(clayMesh);
      }
      if (glassGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(glassGeoms);
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.glass, roughness: 0.35, metalness: 0.45 });
        glassMesh = new THREE.Mesh(merged, mat);
        glassMesh.castShadow = true;
        glassMesh.receiveShadow = true;
        scene.add(glassMesh);
      }
      if (edgeGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(edgeGeoms);
        const mat = new THREE.LineBasicMaterial({ color: PALETTE.clayEdge, transparent: true, opacity: 0.5 });
        clayEdges = new THREE.LineSegments(merged, mat);
        scene.add(clayEdges);
      }
      if (clutterMatrices.length) {
        const boxGeo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.9 });
        const clutter = new THREE.InstancedMesh(boxGeo, mat, clutterMatrices.length);
        clutterMatrices.forEach((m, i) => clutter.setMatrixAt(i, m));
        clutter.castShadow = true;
        scene.add(clutter);
      }
    };

    // ─── Night windows: merged quads along building walls ───
    const createWindows = (buildings: Building[]) => {
      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      let quadCount = 0;
      const MAX_QUADS = 55000;
      const warm = new THREE.Color(PALETTE.window);

      for (const b of buildings) {
        if (quadCount >= MAX_QUADS) break;
        if (!b.coordinates || b.coordinates.length < 3) continue;
        const height = b.height && b.height > 5 ? b.height : 6 + ((b.id % 97) / 97) * 9;
        const floors = Math.min(Math.floor((height - 2.5) / 3.2) + 1, 10);
        const ccw = polygonArea(b.coordinates) > 0;

        for (let i = 0; i < b.coordinates.length - 1 && quadCount < MAX_QUADS; i++) {
          const p = b.coordinates[i], q = b.coordinates[i + 1];
          const dx = q.x - p.x, dy = q.y - p.y;
          const len = Math.hypot(dx, dy);
          if (len < 4) continue;
          const ux = dx / len, uy = dy / len;
          // Outward normal in sim coords
          let nx = uy, ny = -ux;
          if (!ccw) { nx = -uy; ny = ux; }

          const cols = Math.floor(len / 3.2);
          for (let ci = 0; ci < cols && quadCount < MAX_QUADS; ci++) {
            const t = (ci + 0.5) * 3.2;
            const wx = p.x + ux * t + nx * 0.18;
            const wy = p.y + uy * t + ny * 0.18;
            for (let f = 0; f < floors && quadCount < MAX_QUADS; f++) {
              if (Math.random() < 0.32) continue; // some windows stay dark
              const cy = 2.2 + f * 3.2;
              // Quad corners: along wall dir (±0.9), vertical (±0.7)
              const hw = 0.9, hh = 0.7;
              const ax = wx - ux * hw, ay = wy - uy * hw;
              const bx = wx + ux * hw, by = wy + uy * hw;
              const base = quadCount * 4;
              positions.push(
                ax, cy - hh, -ay,
                bx, cy - hh, -by,
                bx, cy + hh, -by,
                ax, cy + hh, -ay
              );
              const bright = 0.85 + Math.random() * 0.75;
              for (let vi = 0; vi < 4; vi++) colors.push(warm.r * bright, warm.g * bright, warm.b * bright);
              indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
              quadCount++;
            }
          }
        }
      }

      if (!quadCount) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0, toneMapped: false });
      windowsMesh = new THREE.Mesh(geo, mat);
      windowsMesh.visible = false;
      scene.add(windowsMesh);
    };

    // ─── Roads: merged dark ribbons + dashed centerlines + elevated flyovers ───
    const DECK_HEIGHT = 8.0; // must match backend TrafficSimulation.DECK_HEIGHT
    const isElevated = (r: Road) => (r.layer ?? 0) > 0 || !!r.bridge;

    const createRoads = (roads: Road[]) => {
      const ribbonGeoms: THREE.BufferGeometry[] = [];
      const dashGeoms: THREE.BufferGeometry[] = [];
      const pillarGeoms: THREE.BufferGeometry[] = [];
      const railGeoms: THREE.BufferGeometry[] = [];

      // Nodes shared with ground roads are ramp ends — deck descends to 0 there
      const groundKeys = new Set<string>();
      roads.forEach((r) => {
        if (!isElevated(r)) r.coordinates?.forEach((p) => groundKeys.add(`${p.x},${p.y}`));
      });

      roads.forEach((road) => {
        if (!road.coordinates || road.coordinates.length < 2) return;
        const pts = road.coordinates.map((p) => new THREE.Vector2(p.x, -p.y));
        const width = roadWidth(road);
        const elevated = isElevated(road);
        const heights = road.coordinates.map((p) =>
          elevated && !groundKeys.has(`${p.x},${p.y}`) ? DECK_HEIGHT + 0.12 : 0.12
        );
        const geo = buildRibbon(pts, width, elevated ? heights : 0.12);
        if (geo) ribbonGeoms.push(geo);

        // Support pillars under elevated deck sections
        if (elevated) {
          let acc = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const segLen = a.distanceTo(b);
            const dir = new THREE.Vector2().subVectors(b, a).normalize();
            let d = 25 - acc;
            while (d < segLen) {
              const t = d / segLen;
              const h = heights[i] + (heights[i + 1] - heights[i]) * t;
              if (h > 4.5) {
                const pillar = new THREE.CylinderGeometry(1.1, 1.3, h, 10);
                pillar.translate(a.x + dir.x * d, h / 2, a.y + dir.y * d);
                pillarGeoms.push(pillar);
              }
              d += 25;
            }
            acc = (acc + segLen) % 25;
          }

          // Side railings: low parapet walls along both deck edges — they
          // sell the height far better than a flat floating ribbon
          const railHeights = heights.map((h) => h + 0.55);
          for (const side of [1, -1]) {
            const railPts = offsetPolyline(pts, side * (width / 2 + 0.12));
            const rail = buildRibbon(railPts, 0.28, railHeights);
            if (rail) railGeoms.push(rail);
          }
        }

        // Dashed centerline for multi-lane roads (follows deck height)
        if (width >= 6.5) {
          let acc = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const segLen = a.distanceTo(b);
            const dir = new THREE.Vector2().subVectors(b, a).normalize();
            let d = 7 - acc;
            while (d < segLen) {
              const cx = a.x + dir.x * d;
              const cz = a.y + dir.y * d;
              const hy = elevated
                ? heights[i] + (heights[i + 1] - heights[i]) * (d / segLen) + 0.04
                : 0.16;
              const dash = new THREE.PlaneGeometry(3.0, 0.35);
              dash.rotateX(-Math.PI / 2);
              dash.rotateY(-Math.atan2(dir.y, dir.x));
              dash.translate(cx, hy, cz);
              dashGeoms.push(dash);
              d += 7;
            }
            acc = (acc + segLen) % 7;
          }
        }
      });

      if (pillarGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(pillarGeoms);
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.clayEdge, roughness: 0.9 });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        scene.add(mesh);
      }
      if (railGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(railGeoms);
        const mat = new THREE.MeshStandardMaterial({ color: 0x8f8a7d, roughness: 0.85, side: THREE.DoubleSide });
        scene.add(new THREE.Mesh(merged, mat));
      }

      if (ribbonGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(ribbonGeoms);
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.asphalt, roughness: 0.95, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.receiveShadow = true;
        asphaltMeshes.push(mesh);
        scene.add(mesh);
      }
      if (dashGeoms.length) {
        const merged = BufferGeometryUtils.mergeGeometries(dashGeoms);
        const mat = new THREE.MeshBasicMaterial({ color: 0xf5f5f0, transparent: true, opacity: 0.8 });
        scene.add(new THREE.Mesh(merged, mat));
      }
    };

    // ─── Green areas + central park bullseye paths ───
    const createGreens = (greens: Green[]) => {
      let centralPark: Green | null = null;
      let bestScore = Infinity;

      greens.forEach((g) => {
        if (!g.coordinates || g.coordinates.length < 3) return;

        const shape = new THREE.Shape();
        shape.moveTo(g.coordinates[0].x, -g.coordinates[0].y);
        for (let i = 1; i < g.coordinates.length; i++) {
          shape.lineTo(g.coordinates[i].x, -g.coordinates[i].y);
        }
        shape.closePath();

        const geo = new THREE.ShapeGeometry(shape);
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, 0.08, 0);
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE.grass, roughness: 1.0 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        grassMeshes.push(mesh);
        scene.add(mesh);

        // Central Park = park polygon closest to origin
        const c = polygonCentroid(g.coordinates);
        const d = Math.hypot(c.x, c.y);
        if (g.kind === "park" && d < bestScore && Math.abs(polygonArea(g.coordinates)) > 5000) {
          bestScore = d;
          centralPark = g;
        }
      });

      // Concentric tan paths in Central Park (bullseye like the reference)
      if (centralPark) {
        const cp = centralPark as Green;
        const c = polygonCentroid(cp.coordinates);
        const cx = c.x, cz = -c.y;
        const pathMat = new THREE.MeshStandardMaterial({ color: PALETTE.path, roughness: 1.0 });

        const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 40), pathMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(cx, 0.14, cz);
        disc.receiveShadow = true;
        scene.add(disc);

        [16, 30, 46, 62].forEach((r) => {
          const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 3.5, 64), pathMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(cx, 0.14, cz);
          ring.receiveShadow = true;
          scene.add(ring);
        });

        return { cx, cz, park: cp };
      }
      return null;
    };

    // ─── Trees: instanced low-poly blobs ───
    const createTrees = (data: SceneData, parkInfo: { cx: number; cz: number; park: Green } | null) => {
      const spots: { x: number; z: number; s: number }[] = [];
      const MAX_TREES = 3600;

      const addSpot = (x: number, y: number, scaleBase = 1) => {
        if (spots.length >= MAX_TREES) return;
        spots.push({ x, z: -y, s: scaleBase * 1.25 * (0.75 + Math.random() * 0.7) });
      };

      // 1. Mapped individual trees
      (data.trees || []).forEach((t) => addSpot(t.x, t.y, 1.1));

      // 2. Scatter inside green polygons (denser for parks)
      (data.greens || []).forEach((g) => {
        if (!g.coordinates || g.coordinates.length < 3) return;
        const area = Math.abs(polygonArea(g.coordinates));
        const isCentral = parkInfo && g === parkInfo.park;
        const density = g.kind === "park" ? (isCentral ? 26 : 45) : 90; // m² per tree
        const count = Math.min(Math.floor(area / density), 900);

        const xs = g.coordinates.map((p) => p.x), ys = g.coordinates.map((p) => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);

        let placed = 0, tries = 0;
        while (placed < count && tries < count * 12) {
          tries++;
          const x = minX + Math.random() * (maxX - minX);
          const y = minY + Math.random() * (maxY - minY);
          if (!pointInPolygon(x, y, g.coordinates)) continue;
          // Keep the bullseye centre + concentric path rings of Central Park clear
          if (isCentral && parkInfo) {
            const r = Math.hypot(x - parkInfo.cx, -y - parkInfo.cz);
            if (r < 22) continue;
            if ([16, 30, 46, 62].some((ring) => r > ring - 4 && r < ring + 8)) continue;
          }
          addSpot(x, y, g.kind === "park" ? 1.15 : 0.9);
          placed++;
        }
      });

      // 3. Street trees along major roads
      data.roads.forEach((road) => {
        if (!road.coordinates || road.coordinates.length < 2) return;
        if (!["primary", "secondary", "tertiary", "trunk", "residential"].includes(road.type)) return;
        const offset = roadWidth(road) / 2 + 3.5;
        let acc = 0;
        let side = 1;
        for (let i = 0; i < road.coordinates.length - 1; i++) {
          const p = road.coordinates[i], q = road.coordinates[i + 1];
          const dx = q.x - p.x, dy = q.y - p.y;
          const len = Math.hypot(dx, dy);
          if (len < 0.5) continue;
          const ux = dx / len, uy = dy / len;
          let d = 17 - acc;
          while (d < len) {
            const px = p.x + ux * d + -uy * offset * side;
            const py = p.y + uy * d + ux * offset * side;
            addSpot(px + (Math.random() - 0.5) * 3, py + (Math.random() - 0.5) * 3, 0.85);
            side *= -1;
            d += 17;
          }
          acc = (acc + len) % 17;
        }
      });

      if (!spots.length) return;

      // Blob canopy: three merged icosahedra
      const blobA = new THREE.IcosahedronGeometry(2.4, 0);
      const blobB = new THREE.IcosahedronGeometry(1.7, 0); blobB.translate(1.3, 0.9, 0.4);
      const blobC = new THREE.IcosahedronGeometry(1.5, 0); blobC.translate(-1.1, 1.2, -0.5);
      const canopyGeo = BufferGeometryUtils.mergeGeometries([blobA, blobB, blobC]);
      canopyGeo.translate(0, 4.6, 0);

      const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 3.2, 6);
      trunkGeo.translate(0, 1.6, 0);

      const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1.0 });

      const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, spots.length);
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
      canopy.castShadow = true;
      trunks.castShadow = true;

      const greensPalette = ["#69a84f", "#558b3f", "#7cbb5a", "#4a7d38", "#86b45e"].map((c) => new THREE.Color(c));
      spots.forEach((sp, i) => {
        dummy.position.set(sp.x, 0, sp.z);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.set(sp.s, sp.s * (0.85 + Math.random() * 0.4), sp.s);
        dummy.updateMatrix();
        canopy.setMatrixAt(i, dummy.matrix);
        trunks.setMatrixAt(i, dummy.matrix);
        canopy.setColorAt(i, greensPalette[Math.floor(Math.random() * greensPalette.length)]);
      });
      treeCanopy = canopy;
      scene.add(canopy);
      scene.add(trunks);
    };

    // ─── Giant Indian flag at Central Park ───
    const createIndianFlag = (cx: number, cz: number) => {
      const poleGeo = new THREE.CylinderGeometry(0.9, 0.9, 62, 12);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.8, roughness: 0.25 });
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(cx, 31, cz);
      pole.castShadow = true;
      scene.add(pole);

      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 340;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#FF9933"; ctx.fillRect(0, 0, 512, 113);
        ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 113, 512, 113);
        ctx.fillStyle = "#138808"; ctx.fillRect(0, 226, 512, 114);
        ctx.strokeStyle = "#000080"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(256, 170, 42, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#000080"; ctx.beginPath(); ctx.arc(256, 170, 7, 0, Math.PI * 2); ctx.fill();
        for (let a = 0; a < Math.PI * 2; a += (Math.PI * 2) / 24) {
          ctx.beginPath(); ctx.moveTo(256, 170);
          ctx.lineTo(256 + 42 * Math.cos(a), 170 + 42 * Math.sin(a)); ctx.stroke();
        }
      }
      const flagTex = new THREE.CanvasTexture(canvas);

      flagGeo = new THREE.PlaneGeometry(30, 20, 24, 16);
      flagGeo.translate(15, 0, 0);
      const flagMat = new THREE.MeshStandardMaterial({ map: flagTex, roughness: 0.7, side: THREE.DoubleSide });
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.set(cx + 0.9, 50, cz);
      flag.castShadow = true;
      scene.add(flag);
    };

    // ─── Streetlamps (emissive bulbs, no per-lamp lights) ───
    const createStreetlamps = (roads: Road[]) => {
      const spots: { x: number; z: number }[] = [];
      roads.forEach((road) => {
        if (!road.coordinates || road.coordinates.length < 2) return;
        if (!["primary", "secondary", "trunk", "tertiary"].includes(road.type)) return;
        for (let i = 0; i < road.coordinates.length; i += 3) {
          const pt = road.coordinates[i];
          spots.push({ x: pt.x + (Math.random() - 0.5) * 4, z: -pt.y + (Math.random() - 0.5) * 4 });
        }
      });
      if (!spots.length) return;

      const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 7.5, 5);
      poleGeo.translate(0, 3.75, 0);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x757a80, roughness: 0.7 });
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);

      const bulbGeo = new THREE.SphereGeometry(0.75, 6, 6);
      bulbGeo.translate(0, 7.7, 0);
      const bulbMat = new THREE.MeshStandardMaterial({
        color: 0xffc46b, emissive: 0xffb84d, emissiveIntensity: 0,
      });
      lampBulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, spots.length);

      // Warm elliptical light pools on the ground under each lamp (video look)
      const glowCanvas = document.createElement("canvas");
      glowCanvas.width = 128; glowCanvas.height = 128;
      const gctx = glowCanvas.getContext("2d")!;
      const grad = gctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      grad.addColorStop(0, "rgba(255, 178, 64, 0.85)");
      grad.addColorStop(0.5, "rgba(255, 150, 40, 0.32)");
      grad.addColorStop(1, "rgba(255, 140, 30, 0)");
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 128, 128);
      const glowTex = new THREE.CanvasTexture(glowCanvas);
      const glowGeo = new THREE.CircleGeometry(7, 24);
      glowGeo.rotateX(-Math.PI / 2);
      glowGeo.translate(0, 0.22, 0);
      const glowMat = new THREE.MeshBasicMaterial({
        map: glowTex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      lampGlow = new THREE.InstancedMesh(glowGeo, glowMat, spots.length);
      lampGlow.visible = false;

      spots.forEach((sp, i) => {
        dummy.position.set(sp.x, 0, sp.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(i, dummy.matrix);
        lampBulbs!.setMatrixAt(i, dummy.matrix);
        lampGlow!.setMatrixAt(i, dummy.matrix);
      });
      scene.add(poles);
      scene.add(lampBulbs);
      scene.add(lampGlow);
    };

    // ─── Location name labels (map-style sprites) ───
    // Labels fade with camera distance to prevent horizon clutter at low angles
    const labelSprites: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; maxDist: number }[] = [];

    const makeLabelSprite = (text: string, opts: { size?: number; color?: string; y: number; x: number; z: number; maxDist?: number }) => {
      const fontPx = 44;
      const pad = 26;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      ctx.font = `600 ${fontPx}px ui-monospace, Consolas, monospace`;
      const textW = ctx.measureText(text.toUpperCase()).width;
      canvas.width = Math.ceil(textW + pad * 2);
      canvas.height = fontPx + pad * 1.4;

      const c2 = canvas.getContext("2d")!;
      // Pill background
      c2.fillStyle = "rgba(10, 12, 16, 0.72)";
      const r = 16;
      c2.beginPath();
      c2.moveTo(r, 0);
      c2.lineTo(canvas.width - r, 0); c2.arcTo(canvas.width, 0, canvas.width, r, r);
      c2.lineTo(canvas.width, canvas.height - r); c2.arcTo(canvas.width, canvas.height, canvas.width - r, canvas.height, r);
      c2.lineTo(r, canvas.height); c2.arcTo(0, canvas.height, 0, canvas.height - r, r);
      c2.lineTo(0, r); c2.arcTo(0, 0, r, 0, r);
      c2.fill();
      c2.font = `600 ${fontPx}px ui-monospace, Consolas, monospace`;
      c2.fillStyle = opts.color || "#f5f4ef";
      c2.textBaseline = "middle";
      c2.fillText(text.toUpperCase(), pad, canvas.height / 2 + 2);

      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      const base = opts.size || 10;
      sprite.scale.set((canvas.width / canvas.height) * base, base, 1);
      sprite.position.set(opts.x, opts.y, opts.z);
      sprite.renderOrder = 999;
      scene.add(sprite);
      labelSprites.push({ sprite, mat, maxDist: opts.maxDist ?? 700 });
    };

    const createLabels = (data: SceneData) => {
      // Named landmarks (temples, hospitals, stations, theatres...)
      const seen = new Set<string>();
      (data.landmarks || []).forEach((lm) => {
        const key = lm.name.trim().toUpperCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        const short = lm.name.length > 28 ? lm.name.slice(0, 26) + "…" : lm.name;
        makeLabelSprite(short, { x: lm.x, y: 34, z: -lm.y, size: 9, maxDist: 650 });
      });

      // Named parks / gardens
      (data.greens || []).forEach((g) => {
        if (!g.name || !g.coordinates || g.coordinates.length < 3) return;
        const key = g.name.trim().toUpperCase();
        if (seen.has(key)) return;
        seen.add(key);
        const c = polygonCentroid(g.coordinates);
        makeLabelSprite(g.name, { x: c.x, y: 26, z: -c.y, size: 9, color: "#c9e8ae", maxDist: 500 });
      });

      // Major road names — longest unique-named roads
      const byName = new Map<string, Road>();
      data.roads.forEach((r) => {
        if (!r.name || !["trunk", "primary", "secondary"].includes(r.type)) return;
        const existing = byName.get(r.name);
        if (!existing || r.coordinates.length > existing.coordinates.length) byName.set(r.name, r);
      });
      [...byName.values()]
        .sort((a, b) => b.coordinates.length - a.coordinates.length)
        .slice(0, 14)
        .forEach((r) => {
          const mid = r.coordinates[Math.floor(r.coordinates.length / 2)];
          makeLabelSprite(r.name, { x: mid.x, y: 14, z: -mid.y, size: 6.5, color: "#d8d6ce", maxDist: 400 });
        });
    };

    // ─── Rain streaks ───
    const initRain = () => {
      rainPositions = new Float32Array(RAIN_COUNT * 6);
      for (let i = 0; i < RAIN_COUNT; i++) {
        const x = (Math.random() - 0.5) * 1600;
        const y = Math.random() * 320;
        const z = (Math.random() - 0.5) * 1600;
        rainPositions[i * 6] = x;
        rainPositions[i * 6 + 1] = y;
        rainPositions[i * 6 + 2] = z;
        rainPositions[i * 6 + 3] = x;
        rainPositions[i * 6 + 4] = y - 5.5;
        rainPositions[i * 6 + 5] = z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xdfe6f0, transparent: true, opacity: 0.32 });
      rainLines = new THREE.LineSegments(geo, mat);
      rainLines.visible = false;
      scene.add(rainLines);
    };

    // ─── Vehicles: instanced bodies + night light quads ───
    const initVehicles = () => {
      (Object.keys(VEHICLE_DIMS) as VehicleType[]).forEach((type) => {
        const { w, h, l } = VEHICLE_DIMS[type];

        // Body: length along X, sits on ground
        const bodyGeo = new THREE.BoxGeometry(l, h, w);
        bodyGeo.translate(0, h / 2 + 0.15, 0);
        const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
        const body = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_INSTANCES);
        body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        body.castShadow = true;
        body.count = 0;
        scene.add(body);
        bodyMeshes[type] = body;

        // Headlights: two bright bars at the front (+X), tone-mapping bypassed for glow
        const hlL = new THREE.BoxGeometry(0.7, 0.55, 0.8);
        hlL.translate(l / 2, h * 0.45, w * 0.3);
        const hlR = new THREE.BoxGeometry(0.7, 0.55, 0.8);
        hlR.translate(l / 2, h * 0.45, -w * 0.3);
        const hlGeo = BufferGeometryUtils.mergeGeometries([hlL, hlR]);
        const hlMat = new THREE.MeshBasicMaterial({ color: 0xfffdf0, toneMapped: false });
        const hl = new THREE.InstancedMesh(hlGeo, hlMat, MAX_INSTANCES);
        hl.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        hl.count = 0;
        hl.visible = false;
        scene.add(hl);
        headlightMeshes[type] = hl;

        // Taillights: two red-orange boxes at the rear (-X)
        const tlL = new THREE.BoxGeometry(0.55, 0.5, 0.65);
        tlL.translate(-l / 2, h * 0.45, w * 0.3);
        const tlR = new THREE.BoxGeometry(0.55, 0.5, 0.65);
        tlR.translate(-l / 2, h * 0.45, -w * 0.3);
        const tlGeo = BufferGeometryUtils.mergeGeometries([tlL, tlR]);
        const tlMat = new THREE.MeshBasicMaterial({ color: 0xff5433, toneMapped: false });
        const tl = new THREE.InstancedMesh(tlGeo, tlMat, MAX_INSTANCES);
        tl.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        tl.count = 0;
        tl.visible = false;
        scene.add(tl);
        taillightMeshes[type] = tl;
      });
    };

    // ─── Incident injection: click a road to close/reopen it ───
    const roadsData: Road[] = [];
    const closedOverlays = new Map<number, THREE.Mesh>();

    const roadAtWorldPoint = (wx: number, wz: number): Road | null => {
      // three.js z = -sim y
      const sy = -wz;
      let best: Road | null = null, bestD = Infinity;
      for (const r of roadsData) {
        if (!r.coordinates || r.coordinates.length < 2) continue;
        const maxD = roadWidth(r) / 2 + 4;
        for (let i = 0; i < r.coordinates.length - 1; i++) {
          const a = r.coordinates[i], b = r.coordinates[i + 1];
          const d2 = distSqToSegment(wx, sy, a.x, a.y, b.x, b.y);
          if (d2 < maxD * maxD && d2 < bestD) { bestD = d2; best = r; }
        }
      }
      return best;
    };

    const setRoadOverlay = (roadId: number, closed: boolean) => {
      const existing = closedOverlays.get(roadId);
      if (!closed) {
        if (existing) { scene.remove(existing); closedOverlays.delete(roadId); }
        return;
      }
      if (existing) return;
      const road = roadsData.find((r) => r.id === roadId);
      if (!road) return;
      const elevated = (road.layer ?? 0) > 0 || !!road.bridge;
      const pts = road.coordinates.map((p) => new THREE.Vector2(p.x, -p.y));
      const geo = buildRibbon(pts, roadWidth(road) + 1.0, elevated ? 8.35 : 0.35);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xd83a2e, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      }));
      mesh.renderOrder = 10;
      scene.add(mesh);
      closedOverlays.set(roadId, mesh);
    };

    const initRoadPicking = () => {
      const el = renderer.domElement;
      const raycaster = new THREE.Raycaster();
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      let down: { x: number; y: number; t: number } | null = null;

      el.addEventListener("pointerdown", (e) => {
        down = { x: e.clientX, y: e.clientY, t: Date.now() };
      });
      el.addEventListener("pointerup", (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const dt = Date.now() - down.t;
        down = null;
        if (moved > 6 || dt > 400) return; // that was an orbit drag, not a click
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);

        // Vehicles take priority over road toggling
        const meshes = Object.values(bodyMeshes).filter(Boolean);
        const vHit = raycaster.intersectObjects(meshes, false)[0];
        if (vHit && vHit.instanceId !== undefined) {
          const type = (Object.keys(bodyMeshes) as VehicleType[])
            .find((t) => bodyMeshes[t] === vHit.object);
          const vid = type ? instanceIds[type][vHit.instanceId] : undefined;
          if (vid !== undefined) {
            selectedVehicleIdRef.current = vid;
            return;
          }
        }
        selectedVehicleIdRef.current = null;
        setSelectedVehicle(null);

        // Closing a road is destructive — require Shift+click so vehicle
        // selection misses don't take out half the network
        if (!e.shiftKey) return;
        if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;
        const road = roadAtWorldPoint(hit.x, hit.z);
        if (road) socketRef.current?.emit("toggle_road", { road_id: road.id });
      });
    };

    // ─── WebSocket ───
    const initWebSocket = () => {
      const socket = io(BACKEND_URL);
      socketRef.current = socket;

      socket.on("road_state", (data: { road_id: number; closed: boolean }) => {
        setRoadOverlay(data.road_id, data.closed);
      });

      socket.on("traffic_update", (data) => {
        if (data.live_traffic) {
          setLiveTraffic({ active: data.live_traffic.active, congestion: data.live_traffic.congestion });
        }
        // Keep closure overlays in sync (covers reconnects / missed events)
        if (Array.isArray(data.closed_roads)) {
          const closedSet = new Set<number>(data.closed_roads);
          closedSet.forEach((id) => setRoadOverlay(id, true));
          for (const id of [...closedOverlays.keys()]) {
            if (!closedSet.has(id)) setRoadOverlay(id, false);
          }
        }
        if (data.metrics) {
          setMetrics(data.metrics);
          // Idling-waste delta badge (recomputed every ~5s)
          const now = Date.now();
          if (now - idlePrevRef.current.t > 5000) {
            if (idlePrevRef.current.t > 0) {
              setIdleDelta(data.metrics.idle_co2_kg_h - idlePrevRef.current.v);
            }
            idlePrevRef.current = { t: now, v: data.metrics.idle_co2_kg_h };
          }
          // Rolling 3-minute history for the HUD sparklines (2s sampling)
          if (now - historyPrevRef.current > 2000) {
            historyPrevRef.current = now;
            setHistory((h) => [
              ...h.slice(-88),
              { health: data.metrics.health, flow: data.metrics.junction_flow },
            ]);
          }
        }

        // Live update for the selected-vehicle card
        const selId = selectedVehicleIdRef.current;
        if (selId !== null) {
          const sv = (data.vehicles as SocketVehicle[]).find((v) => v.id === selId);
          if (sv) setSelectedVehicle({ id: sv.id, type: sv.type, speed: sv.speed });
          else { selectedVehicleIdRef.current = null; setSelectedVehicle(null); }
        }

        // Traffic lights: create small signal poles on first update, then recolor
        if (data.traffic_lights) {
          if (trafficLightMeshesRef.current.size === 0 && data.traffic_lights.length > 0) {
            data.traffic_lights.forEach((tl: TrafficLightData) => {
              const key = `${tl.x.toFixed(1)},${tl.y.toFixed(1)}`;
              const group = new THREE.Mesh(
                new THREE.SphereGeometry(0.7, 8, 8),
                new THREE.MeshStandardMaterial({ color: 0x22cc44, emissive: 0x22cc44, emissiveIntensity: 1.2 })
              );
              group.position.set(tl.x, 6.5, -tl.y);
              const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.14, 0.14, 6.5, 5),
                new THREE.MeshStandardMaterial({ color: 0x4a4f55 })
              );
              pole.position.set(0, -3.25, 0);
              group.add(pole);
              scene.add(group);
              trafficLightMeshesRef.current.set(key, group);
            });
          }
          (data.traffic_lights as TrafficLightData[]).forEach((tl) => {
            const key = `${tl.x.toFixed(1)},${tl.y.toFixed(1)}`;
            const mesh = trafficLightMeshesRef.current.get(key);
            if (mesh) {
              const col = tl.state === "green" ? 0x22cc44 : tl.state === "yellow" ? 0xffc020 : 0xff3020;
              const m = mesh.material as THREE.MeshStandardMaterial;
              m.color.setHex(col);
              m.emissive.setHex(col);
            }
          });
        }

        // Vehicles — left-hand-traffic lane offset applied here
        const activeIds = new Set<number>();
        const vMap = vehiclesMapRef.current;
        const LANE_OFFSET = 2.0;
        // Lateral spread within the lane: Indian traffic doesn't queue single
        // file. Deterministic per-id jitter; two-wheelers wander the most.
        const JITTER_AMP: Record<string, number> = { bike: 1.8, auto: 1.2, car: 0.6, bus: 0.25, truck: 0.25 };

        data.vehicles.forEach((v: SocketVehicle) => {
          activeIds.add(v.id);
          const jitter = (((v.id * 2654435761) >>> 16) % 1000) / 1000 - 0.5; // stable [-0.5, 0.5)
          const lane = LANE_OFFSET + jitter * 2 * (JITTER_AMP[v.type] ?? 0.5);
          const ox = v.x - Math.sin(v.angle) * lane;
          const oy = v.y + Math.cos(v.angle) * lane;
          const tx = ox, ty = v.z ?? 0, tz = -oy, ta = v.angle;
          const existing = vMap.get(v.id);
          if (existing) {
            existing.targetX = tx; existing.targetY = ty; existing.targetZ = tz;
            existing.targetAngle = ta; existing.speed = v.speed;
          } else {
            vMap.set(v.id, {
              id: v.id, type: v.type, speed: v.speed,
              currentX: tx, currentY: ty, currentZ: tz, currentAngle: ta,
              targetX: tx, targetY: ty, targetZ: tz, targetAngle: ta,
            });
          }
        });
        for (const [id] of vMap.entries()) { if (!activeIds.has(id)) vMap.delete(id); }
      });
    };

    // ─── Load everything ───
    const loadCity = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/scene`);
        if (!res.ok) throw new Error("Could not fetch scene data — is the backend running on :8000?");
        const data: SceneData = await res.json();

        initThree();
        createRoads(data.roads);
        // Drop OSM footprints that overlap road ribbons (mapping noise)
        const cleanBuildings = filterBuildingsOffRoads(data.buildings, data.roads);
        createBuildings(cleanBuildings);
        createWindows(cleanBuildings);
        const parkInfo = createGreens(data.greens || []);
        createTrees(data, parkInfo);
        createIndianFlag(parkInfo ? parkInfo.cx : 0, parkInfo ? parkInfo.cz : 0);
        createStreetlamps(data.roads);
        createLabels(data);
        roadsData.push(...data.roads);
        initRoadPicking();
        initRain();
        initVehicles();
        initWebSocket();

        setLoading(false);
        animate();
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : "An error occurred loading the scene.");
        setLoading(false);
      }
    };

    // ═══════════════════════════════════════════════════════
    // RENDER LOOP
    // ═══════════════════════════════════════════════════════

    const colorCache = new Map<string, THREE.Color>();
    const getColor = (hex: string) => {
      let c = colorCache.get(hex);
      if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
      return c;
    };

    const tmpTarget = { day: new THREE.Color(), night: new THREE.Color() };
    let frameCount = 0;

    const lerpMatColor = (mat: THREE.Material, day: number, night: number, isN: boolean, f: number) => {
      const m = mat as THREE.MeshStandardMaterial;
      tmpTarget.day.setHex(isN ? night : day);
      m.color.lerp(tmpTarget.day, f);
    };

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const dt = Math.min(clockRef.current.getDelta(), 0.1);
      const t = clockRef.current.elapsedTime;

      // Revolve buttons override; DEMO mode slow-orbits on its own
      if (orbitDirRef.current !== 0) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = orbitDirRef.current * 3.2;
      } else {
        controls.autoRotate = demoRef.current;
        controls.autoRotateSpeed = 0.8;
      }
      controls.update();

      const night = isNightRef.current;
      const raining = isRainingRef.current;
      // First frames snap to the active mode (deep links); afterwards smooth transition
      frameCount++;
      const F = frameCount < 8 ? 1 : 0.045;

      // Label declutter: fade sprites out beyond their tier's view distance
      if (frameCount % 6 === 0 && labelSprites.length) {
        const camPos = camera.position;
        const FADE_BAND = 120;
        for (const l of labelSprites) {
          const d = camPos.distanceTo(l.sprite.position);
          const op = Math.min(1, Math.max(0, (l.maxDist - d) / FADE_BAND));
          l.mat.opacity = op * 0.95;
          l.sprite.visible = op > 0.03;
        }
      }

      // Sky + fog + lights
      skyUniforms.uMix.value += ((night ? 1 : 0) - skyUniforms.uMix.value) * F;
      const fog = scene.fog as THREE.FogExp2;
      fog.color.lerp(getColor(night ? "#232035" : "#e3e6ea"), F);
      fog.density += ((night ? 0.0007 : 0.00075) - fog.density) * F;

      ambientLight.intensity += ((night ? 0.4 : 0.55) - ambientLight.intensity) * F;
      ambientLight.color.lerp(getColor(night ? "#b09a6e" : "#ffffff"), F);
      sunLight.intensity += ((night ? 0.24 : 1.35) - sunLight.intensity) * F;
      sunLight.color.lerp(getColor(night ? "#9a8fc9" : "#fff3de"), F);
      hemiLight.intensity += ((night ? 0.16 : 0.5) - hemiLight.intensity) * F;

      // Materials day ↔ night
      if (groundMesh) lerpMatColor(groundMesh.material as THREE.Material, PALETTE.ground, PALETTE.groundNight, night, F);
      if (clayMesh) lerpMatColor(clayMesh.material as THREE.Material, PALETTE.clay, PALETTE.clayNight, night, F);
      if (glassMesh) lerpMatColor(glassMesh.material as THREE.Material, PALETTE.glass, PALETTE.glassNight, night, F);
      if (clayEdges) {
        (clayEdges.material as THREE.LineBasicMaterial).color.lerp(
          getColor(night ? "#1a1916" : "#b8b3a6"), F);
      }
      asphaltMeshes.forEach((m) => lerpMatColor(m.material as THREE.Material, PALETTE.asphalt, PALETTE.asphaltNight, night, F));
      grassMeshes.forEach((m) => lerpMatColor(m.material as THREE.Material, PALETTE.grass, PALETTE.grassNight, night, F));
      if (treeCanopy) {
        const m = treeCanopy.material as THREE.MeshStandardMaterial;
        // Trees become near-silhouettes at night (video look)
        m.color.lerp(getColor(night ? "#232e20" : "#ffffff"), F);
      }

      // Windows fade in at night
      if (windowsMesh) {
        const m = windowsMesh.material as THREE.MeshBasicMaterial;
        m.opacity += ((night ? 1 : 0) - m.opacity) * F;
        windowsMesh.visible = m.opacity > 0.03;
      }

      // Streetlamp bulbs + ground glow pools
      if (lampBulbs) {
        const m = lampBulbs.material as THREE.MeshStandardMaterial;
        m.emissiveIntensity += ((night ? 3.2 : 0) - m.emissiveIntensity) * F;
      }
      if (lampGlow) {
        const m = lampGlow.material as THREE.MeshBasicMaterial;
        m.opacity += ((night ? 1 : 0) - m.opacity) * F;
        lampGlow.visible = m.opacity > 0.03;
      }

      // Rain
      if (rainLines) {
        rainLines.visible = raining;
        if (raining) {
          const fall = 190 * dt;
          for (let i = 0; i < RAIN_COUNT; i++) {
            rainPositions[i * 6 + 1] -= fall;
            rainPositions[i * 6 + 4] -= fall;
            if (rainPositions[i * 6 + 1] < 0) {
              const y = 280 + Math.random() * 60;
              rainPositions[i * 6 + 1] = y;
              rainPositions[i * 6 + 4] = y - 5.5;
            }
          }
          rainLines.geometry.attributes.position.needsUpdate = true;
        }
      }

      // Flag wave
      if (flagGeo) {
        const pos = flagGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          pos.setZ(i, Math.sin(x * 0.3 + t * 2.6) * (x / 30) * 1.8);
        }
        pos.needsUpdate = true;
      }

      // Vehicles: interpolate toward socket targets
      const counts: Record<VehicleType, number> = { car: 0, bus: 0, auto: 0, bike: 0, truck: 0 };
      const lerpF = Math.min(1, dt * 9);

      vehiclesMapRef.current.forEach((v) => {
        const type = (v.type as VehicleType) in VEHICLE_DIMS ? (v.type as VehicleType) : "car";
        const idx = counts[type];
        if (idx >= MAX_INSTANCES) return;

        v.currentX += (v.targetX - v.currentX) * lerpF;
        v.currentY += (v.targetY - v.currentY) * lerpF;
        v.currentZ += (v.targetZ - v.currentZ) * lerpF;
        let dA = v.targetAngle - v.currentAngle;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        v.currentAngle += dA * lerpF;

        dummy.position.set(v.currentX, v.currentY, v.currentZ);
        dummy.rotation.set(0, v.currentAngle, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        bodyMeshes[type].setMatrixAt(idx, dummy.matrix);
        instanceIds[type][idx] = v.id;
        const palette = VEHICLE_COLORS[type];
        bodyMeshes[type].setColorAt(idx, getColor(palette[v.id % palette.length]));

        if (night) {
          headlightMeshes[type].setMatrixAt(idx, dummy.matrix);
          taillightMeshes[type].setMatrixAt(idx, dummy.matrix);
        }
        counts[type]++;
      });

      (Object.keys(counts) as VehicleType[]).forEach((type) => {
        const body = bodyMeshes[type];
        body.count = counts[type];
        body.instanceMatrix.needsUpdate = true;
        if (body.instanceColor) body.instanceColor.needsUpdate = true;

        const hl = headlightMeshes[type], tl = taillightMeshes[type];
        hl.visible = night; tl.visible = night;
        if (night) {
          hl.count = counts[type]; tl.count = counts[type];
          hl.instanceMatrix.needsUpdate = true;
          tl.instanceMatrix.needsUpdate = true;
        }
      });

      renderer.render(scene, camera);
    };

    const onResize = () => {
      if (!containerRef.current || !renderer || !camera) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    loadCity();

    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(animationFrameId);
      socketRef.current?.disconnect();
      trafficLightMeshesRef.current.clear();
      vehiclesMapRef.current.clear();
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };
     
  }, []);

  // ═══════════════════════════════════════════════════════
  // HUD — matches the reference footage
  // ═══════════════════════════════════════════════════════

  const statCell = (label: string, value: string, unit?: string, extra?: React.ReactNode) => (
    <div className="px-6 py-2.5 border-r border-white/10 last:border-r-0 shrink-0 whitespace-nowrap">
      <div className="text-[10px] tracking-[0.18em] text-neutral-400 font-mono uppercase">{label}</div>
      <div className="text-xl text-neutral-50 font-mono font-semibold leading-tight">
        {value}
        {unit && <span className="text-[11px] text-neutral-400 font-normal ml-1">{unit}</span>}
      </div>
      {extra}
    </div>
  );

  return (
    <div className="relative w-full h-full bg-[#0d0e12]">
      <div ref={containerRef} className="absolute inset-0" />

      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0e12] z-50">
          <div className="w-10 h-10 border-2 border-neutral-700 border-t-amber-400 rounded-full animate-spin" />
          <p className="mt-4 text-neutral-400 font-mono text-sm tracking-widest">LOADING NASHIK…</p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e12] z-50">
          <div className="max-w-md text-center px-6">
            <p className="text-red-400 font-mono text-sm">{error}</p>
            <p className="text-neutral-500 font-mono text-xs mt-3">
              Start it with: <span className="text-neutral-300">cd backend && python main.py</span>
            </p>
          </div>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* ── Top telemetry strip ── */}
          <div className="absolute top-0 left-0 right-0 z-40 flex items-start justify-between pointer-events-none">
            <div className="flex bg-[#0c0d10]/85 backdrop-blur-sm border-b border-r border-white/5 rounded-br-lg overflow-x-auto">
              {statCell("Health", `${Math.round(metrics.health)}%`)}
              {statCell("Avg Delay /veh·2min", `${fmt(metrics.avg_delay_s)}s`)}
              {statCell("Avg Junction Flow", fmt(metrics.junction_flow), "veh/h")}
              {statCell("Queued", fmt(metrics.queued_m), "m")}
              {statCell(
                "Idling Waste*",
                fmt(metrics.idle_co2_kg_h),
                `kg CO₂/h · ${fmt(metrics.idle_fuel_l_h)} L/h`,
                idleDelta > 0.5 ? (
                  <div className="text-[11px] font-mono text-red-400 leading-none mt-0.5">▲ {fmt(idleDelta)}</div>
                ) : idleDelta < -0.5 ? (
                  <div className="text-[11px] font-mono text-emerald-400 leading-none mt-0.5">▼ {fmt(-idleDelta)}</div>
                ) : null
              )}
            </div>

            {/* ── 3-minute trend sparklines ── */}
            {history.length > 4 && (
              <div className="hidden lg:flex items-center gap-4 px-3">
                {([["HEALTH", "health", "#34d399"], ["FLOW", "flow", "#fbbf24"]] as const).map(([label, key, color]) => (
                  <div key={label} className="flex flex-col items-start">
                    <LineChart width={110} height={30} data={history}>
                      <Line type="monotone" dataKey={key} stroke={color} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                      <YAxis hide domain={["auto", "auto"]} />
                    </LineChart>
                    <div className="text-[9px] font-mono text-neutral-500 tracking-widest">{label} · 3MIN</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Mode + speed controls ── */}
            <div className="flex items-center gap-2 p-3 pointer-events-auto">
              <div className="text-[10px] font-mono text-neutral-500 mr-1 hidden md:block">
                *modelled · 1 sim veh = 2.5 veh, calibrated
              </div>
              <button
                type="button"
                onClick={() => setViewMode("live")}
                className={`px-4 py-1.5 font-mono text-xs tracking-widest border ${
                  viewMode === "live"
                    ? "bg-[#2a2a20]/90 border-amber-200/70 text-amber-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                LIVE
              </button>
              <button
                type="button"
                onClick={() => setViewMode("demo")}
                className={`px-4 py-1.5 font-mono text-xs tracking-widest border ${
                  viewMode === "demo"
                    ? "bg-[#2a2a20]/90 border-amber-200/70 text-amber-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                DEMO
              </button>
              <div className="w-px h-5 bg-white/10 mx-1" />
              <button
                type="button"
                onClick={() => setSpeed(1)}
                className={`px-3 py-1.5 font-mono text-xs border ${
                  speedMult === 1
                    ? "bg-[#2a2a20]/90 border-amber-200/70 text-amber-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                1×
              </button>
              <button
                type="button"
                onClick={() => setSpeed(10)}
                className={`px-3 py-1.5 font-mono text-xs border ${
                  speedMult === 10
                    ? "bg-[#2a2a20]/90 border-amber-200/70 text-amber-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
              >
                10×
              </button>
              <div className="w-px h-5 bg-white/10 mx-1" />
              <button
                type="button"
                onClick={() => setIsNight(!isNight)}
                className={`px-3 py-1.5 font-mono text-xs border ${
                  isNight
                    ? "bg-[#1d2140]/90 border-indigo-300/60 text-indigo-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
                title="Toggle night"
              >
                {isNight ? "☾ NIGHT" : "☀ DAY"}
              </button>
              <button
                type="button"
                onClick={() => setIsRaining(!isRaining)}
                className={`px-3 py-1.5 font-mono text-xs border ${
                  isRaining
                    ? "bg-[#152030]/90 border-sky-300/60 text-sky-100"
                    : "bg-[#16171b]/80 border-white/10 text-neutral-400 hover:text-neutral-200"
                }`}
                title="Toggle rain"
              >
                ☂ RAIN
              </button>
            </div>
          </div>

          {/* ── Title card ── */}
          <div className="absolute bottom-8 left-8 z-40 pointer-events-none select-none">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] font-mono tracking-[0.35em] text-neutral-300/90">
                MUMBAI NAKA · NASHIK
              </div>
              {liveTraffic.active ? (
                <span className="text-[10px] font-mono px-2 py-0.5 border border-emerald-400/60 text-emerald-300 bg-emerald-950/60">
                  ● TOMTOM LIVE · {Math.round(liveTraffic.congestion * 100)}% CONGESTION
                  {metrics.calibration_dev_pct != null && ` · TWIN ±${metrics.calibration_dev_pct}%`}
                </span>
              ) : (
                <span className="text-[10px] font-mono px-2 py-0.5 border border-white/15 text-neutral-500 bg-black/40">
                  ○ SIMULATED
                </span>
              )}
            </div>
            <div className="text-4xl md:text-5xl font-bold tracking-tight text-white/95 font-mono leading-none">
              DIGITAL TWIN
            </div>
            <div className="text-[11px] font-mono tracking-[0.25em] text-neutral-400 mt-2">
              LIVE TRAFFIC SIMULATION
            </div>
            <div className="text-[10px] font-mono tracking-[0.15em] text-neutral-500 mt-1">
              CLICK VEHICLE = INSPECT · SHIFT+CLICK ROAD = CLOSE / REOPEN
            </div>
          </div>

          {/* ── Selected vehicle card ── */}
          {selectedVehicle && (
            <div className="absolute bottom-24 right-4 pointer-events-none bg-black/80 border border-amber-200/40 px-4 py-3 font-mono text-xs text-neutral-200">
              <div className="text-[10px] tracking-[0.25em] text-amber-200 mb-1.5">
                VEHICLE #{selectedVehicle.id}
              </div>
              <div className="leading-relaxed">
                TYPE&nbsp;&nbsp;&nbsp;{selectedVehicle.type.toUpperCase()}
                <br />
                SPEED&nbsp;&nbsp;{selectedVehicle.speed.toFixed(0)} km/h
              </div>
            </div>
          )}

          {/* ── Revolve controls (hold to orbit) ── */}
          <div className="absolute bottom-8 right-8 z-40 flex items-center gap-2 select-none">
            <button
              type="button"
              onPointerDown={() => { orbitDirRef.current = -1; }}
              onPointerUp={() => { orbitDirRef.current = 0; }}
              onPointerLeave={() => { orbitDirRef.current = 0; }}
              className="px-4 py-2.5 font-mono text-lg border bg-[#16171b]/85 border-white/15 text-neutral-300 hover:text-amber-100 hover:border-amber-200/60 active:bg-[#2a2a20]/90"
              title="Hold to revolve backward"
            >
              ⟲
            </button>
            <div className="text-[10px] font-mono tracking-[0.2em] text-neutral-500 px-1">REVOLVE</div>
            <button
              type="button"
              onPointerDown={() => { orbitDirRef.current = 1; }}
              onPointerUp={() => { orbitDirRef.current = 0; }}
              onPointerLeave={() => { orbitDirRef.current = 0; }}
              className="px-4 py-2.5 font-mono text-lg border bg-[#16171b]/85 border-white/15 text-neutral-300 hover:text-amber-100 hover:border-amber-200/60 active:bg-[#2a2a20]/90"
              title="Hold to revolve forward"
            >
              ⟳
            </button>
          </div>
        </>
      )}
    </div>
  );
}
