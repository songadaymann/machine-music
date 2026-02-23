// Land parcel system: spatial ownership for SynthMob agents.
//
// Layout: Town Square at center (shared), paid rings around it, free parcels beyond.
// Parcels are axis-aligned rectangles positioned in concentric rings.

// --- Types ---

export interface ParcelBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Parcel {
  id: string;
  ring: number;
  index: number;
  tier: "premium" | "standard" | "free";
  bounds: ParcelBounds;
  center: { x: number; z: number };
  owner: string | null;
  ownerName: string | null;
}

export interface TownSquare {
  center: { x: number; z: number };
  radius: number;
}

export interface ParcelRegistrySnapshot {
  townSquare: TownSquare;
  parcels: Parcel[];
  assignedCount: number;
  freeRemaining: number;
}

// --- Constants ---

export const TOWN_SQUARE_RADIUS = 12;

interface RingDef {
  ring: number;
  tier: "premium" | "standard" | "free";
  count: number;
  distance: number; // center of parcels from origin
  size: number; // width & depth of each parcel
}

const RING_DEFS: ReadonlyArray<RingDef> = [
  { ring: 1, tier: "premium", count: 8, distance: 20, size: 14 },
  { ring: 2, tier: "standard", count: 12, distance: 34, size: 14 },
  { ring: 3, tier: "free", count: 16, distance: 46, size: 14 },
];

// --- Geometry ---

function generateParcels(): Parcel[] {
  const parcels: Parcel[] = [];

  for (const def of RING_DEFS) {
    const angleStep = (2 * Math.PI) / def.count;
    const half = def.size / 2;

    for (let i = 0; i < def.count; i++) {
      const angle = i * angleStep;
      const cx = Number((Math.cos(angle) * def.distance).toFixed(2));
      const cz = Number((Math.sin(angle) * def.distance).toFixed(2));

      parcels.push({
        id: `${def.tier === "premium" ? "ring1" : def.tier === "standard" ? "ring2" : "free"}-${i}`,
        ring: def.ring,
        index: i,
        tier: def.tier,
        bounds: {
          minX: Number((cx - half).toFixed(2)),
          maxX: Number((cx + half).toFixed(2)),
          minZ: Number((cz - half).toFixed(2)),
          maxZ: Number((cz + half).toFixed(2)),
        },
        center: { x: cx, z: cz },
        owner: null,
        ownerName: null,
      });
    }
  }

  return parcels;
}

export function isInTownSquare(x: number, z: number): boolean {
  return x * x + z * z <= TOWN_SQUARE_RADIUS * TOWN_SQUARE_RADIUS;
}

export function isInBounds(x: number, z: number, b: ParcelBounds): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

// --- Position extraction from world output ---

export function extractWorldPositions(
  output: Record<string, unknown>
): Array<{ x: number; z: number; source: string }> {
  const positions: Array<{ x: number; z: number; source: string }> = [];

  // elements[].pos: [x, y, z]
  const elements = output.elements;
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (el && typeof el === "object" && "pos" in el && Array.isArray((el as any).pos)) {
        const pos = (el as any).pos;
        if (typeof pos[0] === "number" && typeof pos[2] === "number") {
          positions.push({ x: pos[0], z: pos[2], source: "element" });
        }
      }
    }
  }

  // voxels[].x, .z
  const voxels = output.voxels;
  if (Array.isArray(voxels)) {
    for (const v of voxels) {
      if (v && typeof v === "object" && "x" in v && "z" in v) {
        const vx = (v as any).x;
        const vz = (v as any).z;
        if (typeof vx === "number" && typeof vz === "number") {
          positions.push({ x: vx, z: vz, source: "voxel" });
        }
      }
    }
  }

  // catalog_items[].pos: [x, y, z]
  const catalogItems = output.catalog_items;
  if (Array.isArray(catalogItems)) {
    for (const item of catalogItems) {
      if (item && typeof item === "object" && "pos" in item && Array.isArray((item as any).pos)) {
        const pos = (item as any).pos;
        if (typeof pos[0] === "number" && typeof pos[2] === "number") {
          positions.push({ x: pos[0], z: pos[2], source: "catalog_item" });
        }
      }
    }
  }

  // generated_items[].pos: [x, y, z]
  const generatedItems = output.generated_items;
  if (Array.isArray(generatedItems)) {
    for (const item of generatedItems) {
      if (item && typeof item === "object" && "pos" in item && Array.isArray((item as any).pos)) {
        const pos = (item as any).pos;
        if (typeof pos[0] === "number" && typeof pos[2] === "number") {
          positions.push({ x: pos[0], z: pos[2], source: "generated_item" });
        }
      }
    }
  }

  return positions;
}

// --- Registry ---

export class ParcelRegistry {
  private parcels: Parcel[];
  private readonly townSquare: TownSquare;
  private parcelByOwner: Map<string, string> = new Map(); // agentId -> parcelId

  constructor() {
    this.parcels = generateParcels();
    this.townSquare = { center: { x: 0, z: 0 }, radius: TOWN_SQUARE_RADIUS };
  }

  /** Auto-assign the next available free-tier parcel. Returns null if all free parcels are taken. */
  assignFreeParcel(agentId: string, agentName: string): Parcel | null {
    // Already owns one?
    const existing = this.parcelByOwner.get(agentId);
    if (existing) return this.getParcelById(existing);

    // Find first unowned free parcel
    const free = this.parcels.find((p) => p.tier === "free" && p.owner === null);
    if (!free) return null;

    free.owner = agentId;
    free.ownerName = agentName;
    this.parcelByOwner.set(agentId, free.id);
    return free;
  }

  /** Claim a specific parcel (for paid tier purchases). */
  assignSpecificParcel(parcelId: string, agentId: string, agentName: string): Parcel | null {
    const parcel = this.getParcelById(parcelId);
    if (!parcel) return null;
    if (parcel.owner !== null) return null; // already owned

    // Release any existing parcel first
    const existingId = this.parcelByOwner.get(agentId);
    if (existingId) {
      const existing = this.getParcelById(existingId);
      if (existing) {
        existing.owner = null;
        existing.ownerName = null;
      }
    }

    parcel.owner = agentId;
    parcel.ownerName = agentName;
    this.parcelByOwner.set(agentId, parcel.id);
    return parcel;
  }

  getParcelForAgent(agentId: string): Parcel | null {
    const parcelId = this.parcelByOwner.get(agentId);
    if (!parcelId) return null;
    return this.getParcelById(parcelId);
  }

  getParcelById(id: string): Parcel | null {
    return this.parcels.find((p) => p.id === id) ?? null;
  }

  /**
   * Check if an agent can build at (x, z).
   * - Town square: always allowed
   * - Own parcel: allowed
   * - Unclaimed parcel: allowed
   * - Another agent's parcel: rejected
   * - Outside all parcels and town square: allowed (wilderness)
   */
  canBuildAt(agentId: string, x: number, z: number): { allowed: boolean; reason?: string } {
    // Town square is always open
    if (isInTownSquare(x, z)) return { allowed: true };

    // Check if point falls in any parcel
    for (const parcel of this.parcels) {
      if (isInBounds(x, z, parcel.bounds)) {
        if (parcel.owner === null) return { allowed: true };
        if (parcel.owner === agentId) return { allowed: true };
        return {
          allowed: false,
          reason: `Position (${x}, ${z}) is inside parcel ${parcel.id} owned by ${parcel.ownerName}`,
        };
      }
    }

    // Wilderness — not in any parcel or town square
    return { allowed: true };
  }

  /** Check all positions from a world output. Returns first violation or null. */
  checkBuildRights(
    agentId: string,
    output: Record<string, unknown>
  ): { allowed: true } | { allowed: false; reason: string } {
    const positions = extractWorldPositions(output);
    for (const pos of positions) {
      const check = this.canBuildAt(agentId, pos.x, pos.z);
      if (!check.allowed) {
        return { allowed: false, reason: check.reason! };
      }
    }
    return { allowed: true };
  }

  getSnapshot(): ParcelRegistrySnapshot {
    const assignedCount = this.parcels.filter((p) => p.owner !== null).length;
    const freeRemaining = this.parcels.filter((p) => p.tier === "free" && p.owner === null).length;
    return {
      townSquare: this.townSquare,
      parcels: this.parcels.map((p) => ({ ...p })),
      assignedCount,
      freeRemaining,
    };
  }

  reset(): void {
    this.parcels = generateParcels();
    this.parcelByOwner.clear();
  }
}
