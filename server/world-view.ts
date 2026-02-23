// world-view.ts -- Spatial view endpoint for bot agents.
// Returns a bird's-eye SVG map or structured JSON of the world from a given viewpoint.

interface ViewPoint {
  x: number;
  z: number;
}

interface SpatialObject {
  type: "element" | "catalog_item" | "generated_item" | "voxel_cluster";
  name: string;
  label: string;
  pos: [number, number, number];
  footprint: number; // max(width, depth) after scale
  height: number;
  scale: number;
  color: string;
  category: string;
  distance: number;
  bearing: number;
  direction: string;
  placedBy: string;
}

interface VoxelCluster {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
  count: number;
  blocks: Set<string>;
  agentId: string;
  botName: string;
}

// Estimated dimensions for catalog items (width, height, depth in world units)
const CATALOG_SIZES: Record<string, { w: number; h: number; d: number }> = {
  tree_oak: { w: 4, h: 6, d: 4 },
  tree_pine: { w: 3, h: 8, d: 3 },
  bush: { w: 2, h: 1.5, d: 2 },
  rock_large: { w: 3, h: 2, d: 3 },
  rock_small: { w: 1, h: 0.7, d: 1 },
  mushroom: { w: 0.8, h: 1, d: 0.8 },
  flower: { w: 0.5, h: 0.8, d: 0.5 },
  campfire: { w: 2, h: 1, d: 2 },
  bench: { w: 2, h: 1, d: 0.8 },
  lamppost: { w: 0.5, h: 4, d: 0.5 },
  barrel: { w: 1, h: 1.2, d: 1 },
  crate: { w: 1, h: 1, d: 1 },
  fence: { w: 3, h: 1.5, d: 0.3 },
  column: { w: 1, h: 4, d: 1 },
  arch: { w: 4, h: 4, d: 1 },
  staircase: { w: 2, h: 3, d: 4 },
  sign: { w: 0.8, h: 2.5, d: 0.3 },
  torch: { w: 0.3, h: 1.5, d: 0.3 },
  chest: { w: 1.2, h: 0.8, d: 0.8 },
  flag: { w: 0.5, h: 3, d: 0.5 },
};

// Base sizes for primitive element types (at scale=1)
const ELEMENT_SIZES: Record<string, { w: number; h: number; d: number }> = {
  box: { w: 1, h: 1, d: 1 },
  sphere: { w: 1, h: 1, d: 1 },
  cylinder: { w: 0.6, h: 1, d: 0.6 },
  torus: { w: 1, h: 0.24, d: 1 },
  cone: { w: 0.8, h: 1, d: 0.8 },
  plane: { w: 1, h: 0, d: 1 },
  ring: { w: 1, h: 0, d: 1 },
};

const CATEGORY_COLORS: Record<string, string> = {
  nature: "#228B22",
  urban: "#8B4513",
  building: "#708090",
  decor: "#DAA520",
  element: "#4169E1",
  generated: "#9932CC",
  voxel: "#CD853F",
};

function distance2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
}

function bearingDeg(fromX: number, fromZ: number, toX: number, toZ: number): number {
  // 0=north(-z), 90=east(+x), 180=south(+z), 270=west(-x)
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const rad = Math.atan2(dx, -dz); // north = -z
  return ((rad * 180) / Math.PI + 360) % 360;
}

function cardinalDirection(bearing: number): string {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const idx = Math.round(bearing / 45) % 8;
  return dirs[idx];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface WorldSnapshot {
  environment: Record<string, unknown>;
  contributions: Array<{
    agentId: string;
    botName: string;
    elements: unknown[];
    updatedAt: string;
  }>;
  voxels: Array<{
    x: number;
    y: number;
    z: number;
    block: string;
    agentId: string;
    botName: string;
  }>;
  catalog_items: Array<{
    item: string;
    pos: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
    agentId: string;
    botName: string;
  }>;
  generated_items: Array<{
    url: string;
    pos: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
    agentId: string;
    botName: string;
  }>;
}

function collectObjects(
  snapshot: WorldSnapshot,
  vp: ViewPoint,
  radius: number
): SpatialObject[] {
  const objects: SpatialObject[] = [];

  // Primitive elements
  for (const contrib of snapshot.contributions) {
    for (const el of contrib.elements) {
      const e = el as Record<string, unknown>;
      const pos = e.pos as [number, number, number] | undefined;
      if (!pos || !Array.isArray(pos)) continue;
      const dist = distance2D(vp.x, vp.z, pos[0], pos[2]);
      if (dist > radius) continue;

      const elType = (e.type as string) || "box";
      const base = ELEMENT_SIZES[elType] || ELEMENT_SIZES.box;
      const s = typeof e.scale === "number" ? e.scale : 1;

      objects.push({
        type: "element",
        name: elType,
        label: elType,
        pos: [pos[0], pos[1] ?? 0, pos[2]],
        footprint: Math.max(base.w, base.d) * s,
        height: base.h * s,
        scale: s,
        color: (typeof e.color === "string" ? e.color : null) || CATEGORY_COLORS.element,
        category: "element",
        distance: Math.round(dist * 10) / 10,
        bearing: Math.round(bearingDeg(vp.x, vp.z, pos[0], pos[2])),
        direction: cardinalDirection(bearingDeg(vp.x, vp.z, pos[0], pos[2])),
        placedBy: contrib.botName,
      });
    }
  }

  // Catalog items
  for (const ci of snapshot.catalog_items) {
    const dist = distance2D(vp.x, vp.z, ci.pos[0], ci.pos[2]);
    if (dist > radius) continue;

    const base = CATALOG_SIZES[ci.item] || { w: 1, h: 1, d: 1 };
    const s = ci.scale ?? 1;
    const category = getCatalogCategory(ci.item);

    objects.push({
      type: "catalog_item",
      name: ci.item,
      label: ci.item.replace(/_/g, " "),
      pos: ci.pos,
      footprint: Math.max(base.w, base.d) * s,
      height: base.h * s,
      scale: s,
      color: CATEGORY_COLORS[category] || CATEGORY_COLORS.nature,
      category,
      distance: Math.round(dist * 10) / 10,
      bearing: Math.round(bearingDeg(vp.x, vp.z, ci.pos[0], ci.pos[2])),
      direction: cardinalDirection(bearingDeg(vp.x, vp.z, ci.pos[0], ci.pos[2])),
      placedBy: ci.botName,
    });
  }

  // Generated items
  for (const gi of snapshot.generated_items) {
    const dist = distance2D(vp.x, vp.z, gi.pos[0], gi.pos[2]);
    if (dist > radius) continue;

    const s = gi.scale ?? 1;
    // Generated items are normalized to 2 units tall
    objects.push({
      type: "generated_item",
      name: gi.url.split("/").pop() || "generated",
      label: "generated",
      pos: gi.pos,
      footprint: 2 * s, // approximate width = height
      height: 2 * s,
      scale: s,
      color: CATEGORY_COLORS.generated,
      category: "generated",
      distance: Math.round(dist * 10) / 10,
      bearing: Math.round(bearingDeg(vp.x, vp.z, gi.pos[0], gi.pos[2])),
      direction: cardinalDirection(bearingDeg(vp.x, vp.z, gi.pos[0], gi.pos[2])),
      placedBy: gi.botName,
    });
  }

  // Voxel clusters — group adjacent voxels by agent
  const agentVoxels = new Map<string, typeof snapshot.voxels>();
  for (const v of snapshot.voxels) {
    const dist = distance2D(vp.x, vp.z, v.x, v.z);
    if (dist > radius) continue;
    const key = v.agentId;
    if (!agentVoxels.has(key)) agentVoxels.set(key, []);
    agentVoxels.get(key)!.push(v);
  }

  for (const [, voxels] of agentVoxels) {
    if (voxels.length === 0) continue;
    const clusters = clusterVoxels(voxels);
    for (const cluster of clusters) {
      const cx = (cluster.minX + cluster.maxX) / 2;
      const cz = (cluster.minZ + cluster.maxZ) / 2;
      const dist = distance2D(vp.x, vp.z, cx, cz);
      const w = cluster.maxX - cluster.minX + 1;
      const d = cluster.maxZ - cluster.minZ + 1;
      const h = cluster.maxY - cluster.minY + 1;

      objects.push({
        type: "voxel_cluster",
        name: `${cluster.count} voxels`,
        label: `${cluster.count}v (${Array.from(cluster.blocks).slice(0, 3).join(",")})`,
        pos: [cx, cluster.minY, cz],
        footprint: Math.max(w, d),
        height: h,
        scale: 1,
        color: CATEGORY_COLORS.voxel,
        category: "voxel",
        distance: Math.round(dist * 10) / 10,
        bearing: Math.round(bearingDeg(vp.x, vp.z, cx, cz)),
        direction: cardinalDirection(bearingDeg(vp.x, vp.z, cx, cz)),
        placedBy: voxels[0].botName,
      });
    }
  }

  objects.sort((a, b) => a.distance - b.distance);
  return objects;
}

function getCatalogCategory(item: string): string {
  const nature = ["tree_oak", "tree_pine", "bush", "rock_large", "rock_small", "mushroom", "flower", "campfire"];
  const urban = ["bench", "lamppost", "barrel", "crate", "fence"];
  const building = ["column", "arch", "staircase"];
  if (nature.includes(item)) return "nature";
  if (urban.includes(item)) return "urban";
  if (building.includes(item)) return "building";
  return "decor";
}

// Simple flood-fill clustering for voxels
function clusterVoxels(voxels: Array<{ x: number; y: number; z: number; block: string; agentId: string; botName: string }>): VoxelCluster[] {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const voxelMap = new Map<string, typeof voxels[0]>();
  for (const v of voxels) voxelMap.set(key(v.x, v.y, v.z), v);

  const visited = new Set<string>();
  const clusters: VoxelCluster[] = [];

  for (const v of voxels) {
    const k = key(v.x, v.y, v.z);
    if (visited.has(k)) continue;

    // BFS flood fill
    const cluster: VoxelCluster = {
      minX: v.x, maxX: v.x, minZ: v.z, maxZ: v.z,
      minY: v.y, maxY: v.y, count: 0,
      blocks: new Set(), agentId: v.agentId, botName: v.botName,
    };
    const queue = [k];
    visited.add(k);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const cv = voxelMap.get(cur)!;
      cluster.count++;
      cluster.blocks.add(cv.block);
      cluster.minX = Math.min(cluster.minX, cv.x);
      cluster.maxX = Math.max(cluster.maxX, cv.x);
      cluster.minZ = Math.min(cluster.minZ, cv.z);
      cluster.maxZ = Math.max(cluster.maxZ, cv.z);
      cluster.minY = Math.min(cluster.minY, cv.y);
      cluster.maxY = Math.max(cluster.maxY, cv.y);

      // Check 6 neighbors
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const nk = key(cv.x + dx, cv.y + dy, cv.z + dz);
        if (!visited.has(nk) && voxelMap.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// --- SVG rendering ---

export function renderSVG(
  snapshot: WorldSnapshot,
  vp: ViewPoint,
  radius: number
): string {
  const SIZE = 800;
  const HALF = SIZE / 2;
  const pxPerUnit = HALF / radius;
  const objects = collectObjects(snapshot, vp, radius);

  // World coords to SVG coords
  const toSvgX = (wx: number) => HALF + (wx - vp.x) * pxPerUnit;
  const toSvgY = (wz: number) => HALF - (wz - vp.z) * pxPerUnit; // -z = up (north)

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" style="background:#1a1a2e">`);
  lines.push(`<defs><style>text{font-family:monospace;fill:#ccc;font-size:9px}text.compass{font-size:14px;font-weight:bold;fill:#888}text.legend{font-size:10px}</style></defs>`);

  // Grid lines
  const gridStep = 10;
  const gridStart = Math.ceil((vp.x - radius) / gridStep) * gridStep;
  const gridEndX = Math.floor((vp.x + radius) / gridStep) * gridStep;
  const gridStartZ = Math.ceil((vp.z - radius) / gridStep) * gridStep;
  const gridEndZ = Math.floor((vp.z + radius) / gridStep) * gridStep;

  for (let gx = gridStart; gx <= gridEndX; gx += gridStep) {
    const sx = toSvgX(gx);
    lines.push(`<line x1="${sx}" y1="0" x2="${sx}" y2="${SIZE}" stroke="#333" stroke-width="0.5"/>`);
    lines.push(`<text x="${sx + 2}" y="${SIZE - 4}">${gx}</text>`);
  }
  for (let gz = gridStartZ; gz <= gridEndZ; gz += gridStep) {
    const sy = toSvgY(gz);
    lines.push(`<line x1="0" y1="${sy}" x2="${SIZE}" y2="${sy}" stroke="#333" stroke-width="0.5"/>`);
    lines.push(`<text x="4" y="${sy - 3}">${gz}</text>`);
  }

  // Compass labels
  lines.push(`<text class="compass" x="${HALF}" y="18" text-anchor="middle">N</text>`);
  lines.push(`<text class="compass" x="${HALF}" y="${SIZE - 6}" text-anchor="middle">S</text>`);
  lines.push(`<text class="compass" x="8" y="${HALF + 5}">W</text>`);
  lines.push(`<text class="compass" x="${SIZE - 18}" y="${HALF + 5}">E</text>`);

  // Radius circle
  lines.push(`<circle cx="${HALF}" cy="${HALF}" r="${HALF - 10}" fill="none" stroke="#444" stroke-width="1" stroke-dasharray="4,4"/>`);

  // Objects (sorted by distance, farthest first so close objects draw on top)
  const sorted = [...objects].reverse();
  for (const obj of sorted) {
    const sx = toSvgX(obj.pos[0]);
    const sy = toSvgY(obj.pos[2]);
    const r = Math.max(4, (obj.footprint / 2) * pxPerUnit);

    if (obj.type === "voxel_cluster") {
      // Draw as rectangle
      const vObj = obj as SpatialObject;
      const hw = r;
      const hd = r;
      lines.push(`<rect x="${sx - hw}" y="${sy - hd}" width="${hw * 2}" height="${hd * 2}" fill="${obj.color}" fill-opacity="0.4" stroke="${obj.color}" stroke-width="1" rx="2"/>`);
    } else {
      lines.push(`<circle cx="${sx}" cy="${sy}" r="${r}" fill="${obj.color}" fill-opacity="0.6" stroke="${obj.color}" stroke-width="1.5"/>`);
    }
    // Label
    const shortLabel = obj.label.length > 12 ? obj.label.slice(0, 11) + "…" : obj.label;
    lines.push(`<text x="${sx}" y="${sy + r + 11}" text-anchor="middle" fill="#ddd" font-size="8">${escapeXml(shortLabel)}</text>`);
  }

  // Viewpoint marker
  lines.push(`<circle cx="${HALF}" cy="${HALF}" r="5" fill="#ff4444" stroke="#fff" stroke-width="2"/>`);
  lines.push(`<text x="${HALF + 8}" y="${HALF + 4}" fill="#ff6666" font-size="10">you</text>`);

  // Legend
  const legendY = 30;
  const legendItems = [
    { color: CATEGORY_COLORS.nature, label: "nature" },
    { color: CATEGORY_COLORS.urban, label: "urban" },
    { color: CATEGORY_COLORS.building, label: "building" },
    { color: CATEGORY_COLORS.decor, label: "decor" },
    { color: CATEGORY_COLORS.element, label: "primitive" },
    { color: CATEGORY_COLORS.generated, label: "generated" },
    { color: CATEGORY_COLORS.voxel, label: "voxels" },
  ];
  for (let i = 0; i < legendItems.length; i++) {
    const ly = legendY + i * 16;
    lines.push(`<rect x="${SIZE - 90}" y="${ly - 8}" width="10" height="10" fill="${legendItems[i].color}" rx="2"/>`);
    lines.push(`<text class="legend" x="${SIZE - 76}" y="${ly}">${legendItems[i].label}</text>`);
  }

  // Object count
  lines.push(`<text x="${SIZE - 90}" y="${legendY + legendItems.length * 16 + 4}" fill="#888" font-size="9">${objects.length} objects</text>`);

  lines.push(`</svg>`);
  return lines.join("\n");
}

// --- JSON rendering ---

export function renderJSON(
  snapshot: WorldSnapshot,
  vp: ViewPoint,
  radius: number
) {
  const objects = collectObjects(snapshot, vp, radius);

  // Build summary
  const byType: Record<string, number> = {};
  let largest: SpatialObject | null = null;
  let largestSize = 0;
  for (const obj of objects) {
    byType[obj.type] = (byType[obj.type] || 0) + 1;
    const size = obj.footprint * obj.scale;
    if (size > largestSize) {
      largestSize = size;
      largest = obj;
    }
  }

  // Find densest cluster
  let densestCenter: [number, number] | null = null;
  let densestCount = 0;
  for (const obj of objects) {
    let count = 0;
    for (const other of objects) {
      if (distance2D(obj.pos[0], obj.pos[2], other.pos[0], other.pos[2]) < 5) {
        count++;
      }
    }
    if (count > densestCount) {
      densestCount = count;
      densestCenter = [obj.pos[0], obj.pos[2]];
    }
  }

  const typeSummary = Object.entries(byType)
    .map(([t, n]) => `${n} ${t.replace("_", " ")}${n > 1 ? "s" : ""}`)
    .join(", ");

  let summary = `${objects.length} objects within ${radius}m: ${typeSummary}.`;
  if (largest) {
    summary += ` Largest: ${largest.label} (footprint ${largest.footprint.toFixed(1)}m).`;
  }
  if (densestCenter && densestCount > 2) {
    summary += ` Densest area: around (${densestCenter[0].toFixed(0)}, ${densestCenter[1].toFixed(0)}) with ${densestCount} objects within 5m.`;
  }

  return {
    viewpoint: { x: vp.x, z: vp.z },
    radius,
    object_count: objects.length,
    objects: objects.map((obj) => ({
      type: obj.type,
      name: obj.name,
      label: obj.label,
      pos: obj.pos,
      estimated_size: {
        footprint: Math.round(obj.footprint * 10) / 10,
        height: Math.round(obj.height * 10) / 10,
      },
      scale: obj.scale,
      distance: obj.distance,
      direction: obj.direction,
      bearing: obj.bearing,
      placed_by: obj.placedBy,
    })),
    summary,
  };
}
