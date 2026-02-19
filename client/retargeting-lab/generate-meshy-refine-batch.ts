/**
 * Retargeting Lab utility:
 * - Generate 5 unique Meshy avatars through preview + refine only (no rigging).
 * - Persist refine-stage artifacts for inspection.
 * - Produce a consistency report aligned to the lab checklist.
 *
 * Usage:
 *   set -a; source .env; bun run client/retargeting-lab/generate-meshy-refine-batch.ts
 */

import { access, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

const MESHY_BASE_URL = "https://api.meshy.ai";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const DOWNLOAD_RETRY_COUNT = 2;
const MESHY_MODEL = "meshy-6";
const MESHY_POSE_MODE = "t-pose";

const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error("MESHY_API_KEY not set. Export it or source .env before running.");
  process.exit(1);
}

interface PromptSpec {
  id: string;
  prompt: string;
}

const PROMPTS: PromptSpec[] = [
  {
    id: "streetwear-man",
    prompt:
      "Full-body character in a clean T-pose, arms straight out horizontally. A young man with short black hair, red overalls, shirtless torso, realistic proportions, game-ready style.",
  },
  {
    id: "astronaut-woman",
    prompt:
      "Full-body character in a strict T-pose, arms extended horizontally. A woman astronaut in a white and orange suit with patches and boots, realistic proportions, game-ready style.",
  },
  {
    id: "cyberpunk-dj",
    prompt:
      "Full-body character in a neutral T-pose, arms straight out. A cyberpunk DJ with neon jacket, headphones, and cargo pants, realistic proportions, game-ready style.",
  },
  {
    id: "fantasy-ranger",
    prompt:
      "Full-body character in a canonical T-pose, arms extended. A fantasy ranger with leather armor, cloak, and utility belt, realistic proportions, game-ready style.",
  },
  {
    id: "retro-worker",
    prompt:
      "Full-body character in a precise T-pose with arms horizontal. A retro mechanic in blue coveralls, gloves, and work boots, realistic proportions, game-ready style.",
  },
];

interface MeshyTaskCreateResponse {
  result?: string;
}

interface MeshyTaskError {
  message?: string;
}

interface MeshyTask {
  id?: string;
  status?: string;
  progress?: number;
  model_urls?: Record<string, unknown>;
  texture_urls?: unknown;
  task_error?: MeshyTaskError;
}

interface MeshyTextureRef {
  key: string;
  url: string;
}

interface GlbImageInfo {
  index: number;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  source: "bufferView" | "dataURI" | "externalURI" | "unknown";
}

interface GlbAnalysis {
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  skins: number;
  animations: number;
  totalVertices: number;
  totalTriangles: number | null;
  hasAnyUV0: boolean;
  hasAnyNormals: boolean;
  hasAnyTangents: boolean;
  missingUvPrimitiveCount: number;
  nonTriPrimitiveCount: number;
  nonUniformScaleNodes: number;
  negativeScaleNodes: number;
  rootNodeCount: number;
  pbrChannels: {
    baseColorTextureMaterials: number;
    metallicRoughnessTextureMaterials: number;
    normalTextureMaterials: number;
    occlusionTextureMaterials: number;
    emissiveTextureMaterials: number;
  };
  positionBounds: {
    min: [number, number, number] | null;
    max: [number, number, number] | null;
    size: [number, number, number] | null;
  };
  imageInfo: GlbImageInfo[];
  maxTextureDimension: number | null;
}

interface SampleResult {
  id: string;
  prompt: string;
  previewTaskId: string;
  refineTaskId: string;
  glbUrl: string;
  outputDir: string;
  glbPath: string;
  textureFiles: string[];
  analysis: GlbAnalysis;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function nowStamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function meshyRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  let payload: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${MESHY_BASE_URL}${path}`, { method, headers, body: payload });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meshy ${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

async function pollTask(path: string, label: string): Promise<MeshyTask> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const task = await meshyRequest<MeshyTask>("GET", path);
    const status = `${task.status ?? ""}`.toUpperCase();
    const progress = typeof task.progress === "number" ? task.progress.toFixed(1) : "?";
    console.log(`  [${label}] status=${status || "UNKNOWN"} progress=${progress}`);

    if (status === "SUCCEEDED") return task;
    if (status === "FAILED" || status === "CANCELED") {
      const details = task.task_error?.message ?? JSON.stringify(task);
      throw new Error(`Task ${status}: ${details}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Task timeout (${label})`);
}

function collectTextureRefs(input: unknown): MeshyTextureRef[] {
  const out: MeshyTextureRef[] = [];

  const visit = (value: unknown, path: string) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      out.push({ key: path || "texture", url: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, path ? `${path}[${i}]` : `[${i}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        const nextPath = path ? `${path}.${k}` : k;
        visit(v, nextPath);
      }
    }
  };

  visit(input, "");

  const dedup = new Map<string, MeshyTextureRef>();
  for (const ref of out) {
    if (!dedup.has(ref.url)) dedup.set(ref.url, ref);
  }
  return [...dedup.values()];
}

function extensionFromUrl(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const idx = clean.lastIndexOf(".");
  if (idx < 0) return "bin";
  const ext = clean.slice(idx + 1).toLowerCase();
  if (!ext) return "bin";
  return ext;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeTextureFileName(index: number, key: string, url: string): string {
  const ext = extensionFromUrl(url);
  return `${String(index + 1).padStart(2, "0")}-${sanitizeSegment(key)}.${ext}`;
}

async function downloadToFile(url: string, outPath: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(outPath, bytes);
  return bytes;
}

async function downloadWithRetry(url: string, outPath: string, label: string): Promise<Uint8Array> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT; attempt++) {
    try {
      return await downloadToFile(url, outPath, DOWNLOAD_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_RETRY_COUNT) {
        console.warn(`  download retry (${attempt}/${DOWNLOAD_RETRY_COUNT - 1}) for ${label}`);
        await sleep(1000 * attempt);
      }
    }
  }
  throw new Error(`Download failed for ${label}: ${String(lastError)}`);
}

async function downloadTextureRefs(textureRefs: MeshyTextureRef[], sampleDir: string): Promise<string[]> {
  const textureFiles: string[] = [];
  for (let i = 0; i < textureRefs.length; i++) {
    const ref = textureRefs[i];
    const textureName = makeTextureFileName(i, ref.key, ref.url);
    const texturePath = join(sampleDir, textureName);

    if (await pathExists(texturePath)) {
      textureFiles.push(texturePath);
      continue;
    }

    console.log(`  downloading texture ${i + 1}/${textureRefs.length} -> ${textureName}`);
    try {
      await downloadWithRetry(ref.url, texturePath, `${textureName}`);
      textureFiles.push(texturePath);
    } catch (error) {
      console.warn(`  texture download skipped (${textureName}): ${String(error)}`);
    }
  }
  return textureFiles;
}

function parseGlb(glbBytes: Uint8Array): { gltf: Record<string, unknown>; binChunk: Uint8Array | null } {
  const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
  if (glbBytes.byteLength < 20) {
    throw new Error("GLB too small");
  }
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error("Invalid GLB header");
  }

  let offset = 12;
  let gltfJson: Record<string, unknown> | null = null;
  let binChunk: Uint8Array | null = null;
  const textDecoder = new TextDecoder("utf-8");

  while (offset + 8 <= glbBytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > glbBytes.byteLength) break;

    const chunkData = glbBytes.subarray(chunkStart, chunkEnd);
    if (chunkType === 0x4e4f534a) {
      const jsonText = textDecoder.decode(chunkData);
      gltfJson = JSON.parse(jsonText) as Record<string, unknown>;
    } else if (chunkType === 0x004e4942) {
      binChunk = chunkData;
    }
    offset = chunkEnd;
  }

  if (!gltfJson) throw new Error("Missing JSON chunk in GLB");
  return { gltf: gltfJson, binChunk };
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < pngSig.length; i++) {
    if (bytes[i] !== pngSig[i]) return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  return { width, height };
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;

    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;
    if (isSof) {
      if (offset + 7 > bytes.length) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    offset += length;
  }
  return null;
}

function decodeDataUri(uri: string): Uint8Array | null {
  const match = /^data:.*?;base64,(.+)$/i.exec(uri);
  if (!match) return null;
  return new Uint8Array(Buffer.from(match[1], "base64"));
}

function getImageBytes(
  gltf: Record<string, unknown>,
  binChunk: Uint8Array | null,
  image: Record<string, unknown>
): { bytes: Uint8Array | null; source: GlbImageInfo["source"]; mimeType: string | null } {
  const mimeType = asNonEmptyString(image.mimeType);
  const uri = asNonEmptyString(image.uri);

  if (uri) {
    if (uri.startsWith("data:")) {
      return { bytes: decodeDataUri(uri), source: "dataURI", mimeType };
    }
    return { bytes: null, source: "externalURI", mimeType };
  }

  const bufferViewIndex = image.bufferView;
  if (typeof bufferViewIndex === "number" && Number.isInteger(bufferViewIndex)) {
    const bufferViews = Array.isArray(gltf.bufferViews) ? (gltf.bufferViews as Record<string, unknown>[]) : [];
    const bufferView = bufferViews[bufferViewIndex];
    if (bufferView && binChunk) {
      const byteOffset = typeof bufferView.byteOffset === "number" ? bufferView.byteOffset : 0;
      const byteLength = typeof bufferView.byteLength === "number" ? bufferView.byteLength : 0;
      if (byteLength > 0 && byteOffset + byteLength <= binChunk.byteLength) {
        return {
          bytes: binChunk.subarray(byteOffset, byteOffset + byteLength),
          source: "bufferView",
          mimeType,
        };
      }
    }
  }

  return { bytes: null, source: "unknown", mimeType };
}

function analyzeGlb(glbBytes: Uint8Array): GlbAnalysis {
  const { gltf, binChunk } = parseGlb(glbBytes);

  const nodes = Array.isArray(gltf.nodes) ? (gltf.nodes as Record<string, unknown>[]) : [];
  const meshes = Array.isArray(gltf.meshes) ? (gltf.meshes as Record<string, unknown>[]) : [];
  const materials = Array.isArray(gltf.materials) ? (gltf.materials as Record<string, unknown>[]) : [];
  const textures = Array.isArray(gltf.textures) ? (gltf.textures as Record<string, unknown>[]) : [];
  const images = Array.isArray(gltf.images) ? (gltf.images as Record<string, unknown>[]) : [];
  const skins = Array.isArray(gltf.skins) ? (gltf.skins as Record<string, unknown>[]) : [];
  const animations = Array.isArray(gltf.animations) ? (gltf.animations as Record<string, unknown>[]) : [];
  const accessors = Array.isArray(gltf.accessors) ? (gltf.accessors as Record<string, unknown>[]) : [];
  const scenes = Array.isArray(gltf.scenes) ? (gltf.scenes as Record<string, unknown>[]) : [];

  let primitiveCount = 0;
  let totalVertices = 0;
  let totalTriangles = 0;
  let triangleKnown = true;
  let hasAnyUV0 = false;
  let hasAnyNormals = false;
  let hasAnyTangents = false;
  let missingUvPrimitiveCount = 0;
  let nonTriPrimitiveCount = 0;

  let minPos: [number, number, number] | null = null;
  let maxPos: [number, number, number] | null = null;

  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? (mesh.primitives as Record<string, unknown>[]) : [];
    for (const prim of primitives) {
      primitiveCount++;
      const attributes = isRecord(prim.attributes) ? prim.attributes : {};
      const positionAccessorIndex = attributes.POSITION;
      const uvAccessorIndex = attributes.TEXCOORD_0;
      const normalAccessorIndex = attributes.NORMAL;
      const tangentAccessorIndex = attributes.TANGENT;

      if (typeof uvAccessorIndex === "number") hasAnyUV0 = true;
      else missingUvPrimitiveCount++;

      if (typeof normalAccessorIndex === "number") hasAnyNormals = true;
      if (typeof tangentAccessorIndex === "number") hasAnyTangents = true;

      if (typeof positionAccessorIndex === "number") {
        const posAccessor = accessors[positionAccessorIndex];
        if (posAccessor) {
          const count = typeof posAccessor.count === "number" ? posAccessor.count : 0;
          totalVertices += count;

          const aMin = Array.isArray(posAccessor.min) ? posAccessor.min : null;
          const aMax = Array.isArray(posAccessor.max) ? posAccessor.max : null;
          if (aMin && aMax && aMin.length >= 3 && aMax.length >= 3) {
            const localMin: [number, number, number] = [Number(aMin[0]), Number(aMin[1]), Number(aMin[2])];
            const localMax: [number, number, number] = [Number(aMax[0]), Number(aMax[1]), Number(aMax[2])];
            if (!minPos) {
              minPos = [...localMin];
              maxPos = [...localMax];
            } else {
              minPos[0] = Math.min(minPos[0], localMin[0]);
              minPos[1] = Math.min(minPos[1], localMin[1]);
              minPos[2] = Math.min(minPos[2], localMin[2]);
              maxPos![0] = Math.max(maxPos![0], localMax[0]);
              maxPos![1] = Math.max(maxPos![1], localMax[1]);
              maxPos![2] = Math.max(maxPos![2], localMax[2]);
            }
          }
        }
      }

      const mode = typeof prim.mode === "number" ? prim.mode : 4;
      if (mode !== 4) {
        nonTriPrimitiveCount++;
      }

      if (mode === 4) {
        if (typeof prim.indices === "number") {
          const idxAccessor = accessors[prim.indices];
          const idxCount = idxAccessor && typeof idxAccessor.count === "number" ? idxAccessor.count : 0;
          totalTriangles += Math.floor(idxCount / 3);
        } else if (typeof positionAccessorIndex === "number") {
          const posAccessor = accessors[positionAccessorIndex];
          const posCount = posAccessor && typeof posAccessor.count === "number" ? posAccessor.count : 0;
          totalTriangles += Math.floor(posCount / 3);
        } else {
          triangleKnown = false;
        }
      } else {
        triangleKnown = false;
      }
    }
  }

  let nonUniformScaleNodes = 0;
  let negativeScaleNodes = 0;
  for (const node of nodes) {
    const scale = Array.isArray(node.scale) ? node.scale : [1, 1, 1];
    if (scale.length < 3) continue;
    const sx = Number(scale[0]);
    const sy = Number(scale[1]);
    const sz = Number(scale[2]);
    const nearlyEqual = (a: number, b: number) => Math.abs(a - b) < 1e-5;
    if (!nearlyEqual(sx, sy) || !nearlyEqual(sy, sz)) nonUniformScaleNodes++;
    if (sx < 0 || sy < 0 || sz < 0) negativeScaleNodes++;
  }

  let rootNodeCount = 0;
  if (scenes.length > 0) {
    const sceneIndex = typeof gltf.scene === "number" ? gltf.scene : 0;
    const scene = scenes[sceneIndex] ?? scenes[0];
    const roots = scene && Array.isArray(scene.nodes) ? scene.nodes : [];
    rootNodeCount = roots.length;
  }

  const pbrChannels = {
    baseColorTextureMaterials: 0,
    metallicRoughnessTextureMaterials: 0,
    normalTextureMaterials: 0,
    occlusionTextureMaterials: 0,
    emissiveTextureMaterials: 0,
  };
  for (const mat of materials) {
    const pbr = isRecord(mat.pbrMetallicRoughness) ? mat.pbrMetallicRoughness : {};
    if (isRecord(pbr.baseColorTexture)) pbrChannels.baseColorTextureMaterials++;
    if (isRecord(pbr.metallicRoughnessTexture)) pbrChannels.metallicRoughnessTextureMaterials++;
    if (isRecord(mat.normalTexture)) pbrChannels.normalTextureMaterials++;
    if (isRecord(mat.occlusionTexture)) pbrChannels.occlusionTextureMaterials++;
    if (isRecord(mat.emissiveTexture)) pbrChannels.emissiveTextureMaterials++;
  }

  const imageInfo: GlbImageInfo[] = [];
  let maxTextureDimension: number | null = null;
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const { bytes, source, mimeType } = getImageBytes(gltf, binChunk, image);
    let width: number | null = null;
    let height: number | null = null;

    if (bytes) {
      const png = parsePngDimensions(bytes);
      const jpeg = png ? null : parseJpegDimensions(bytes);
      if (png) {
        width = png.width;
        height = png.height;
      } else if (jpeg) {
        width = jpeg.width;
        height = jpeg.height;
      }
      if (width && height) {
        const dim = Math.max(width, height);
        maxTextureDimension = maxTextureDimension === null ? dim : Math.max(maxTextureDimension, dim);
      }
    }

    imageInfo.push({
      index: i,
      mimeType,
      width,
      height,
      source,
    });
  }

  const positionBounds = {
    min: minPos,
    max: maxPos,
    size:
      minPos && maxPos
        ? ([maxPos[0] - minPos[0], maxPos[1] - minPos[1], maxPos[2] - minPos[2]] as [number, number, number])
        : null,
  };

  return {
    nodes: nodes.length,
    meshes: meshes.length,
    primitives: primitiveCount,
    materials: materials.length,
    textures: textures.length,
    images: images.length,
    skins: skins.length,
    animations: animations.length,
    totalVertices,
    totalTriangles: triangleKnown ? totalTriangles : null,
    hasAnyUV0,
    hasAnyNormals,
    hasAnyTangents,
    missingUvPrimitiveCount,
    nonTriPrimitiveCount,
    nonUniformScaleNodes,
    negativeScaleNodes,
    rootNodeCount,
    pbrChannels,
    positionBounds,
    imageInfo,
    maxTextureDimension,
  };
}

function valueToLabel(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildConsistencyRows(samples: SampleResult[]) {
  const metricDefs: Array<{ key: string; label: string; get: (s: SampleResult) => unknown }> = [
    { key: "skins", label: "Skins present", get: (s) => s.analysis.skins > 0 },
    { key: "animations", label: "Animations embedded", get: (s) => s.analysis.animations > 0 },
    { key: "nonUniformScaleNodes", label: "Non-uniform scale node count", get: (s) => s.analysis.nonUniformScaleNodes },
    { key: "negativeScaleNodes", label: "Negative scale node count", get: (s) => s.analysis.negativeScaleNodes },
    { key: "hasUV0", label: "Has UV0", get: (s) => s.analysis.hasAnyUV0 },
    { key: "hasNormals", label: "Has normals", get: (s) => s.analysis.hasAnyNormals },
    { key: "hasTangents", label: "Has tangents", get: (s) => s.analysis.hasAnyTangents },
    { key: "rootNodeCount", label: "Root node count", get: (s) => s.analysis.rootNodeCount },
    { key: "meshes", label: "Mesh count", get: (s) => s.analysis.meshes },
    { key: "primitives", label: "Primitive count", get: (s) => s.analysis.primitives },
    { key: "vertices", label: "Vertex count", get: (s) => s.analysis.totalVertices },
    { key: "triangles", label: "Triangle count", get: (s) => s.analysis.totalTriangles },
    {
      key: "bboxHeight",
      label: "Bounds height",
      get: (s) => (s.analysis.positionBounds.size ? Number(s.analysis.positionBounds.size[1].toFixed(6)) : null),
    },
    {
      key: "bboxWidth",
      label: "Bounds width (X)",
      get: (s) => (s.analysis.positionBounds.size ? Number(s.analysis.positionBounds.size[0].toFixed(6)) : null),
    },
    {
      key: "bboxDepth",
      label: "Bounds depth (Z)",
      get: (s) => (s.analysis.positionBounds.size ? Number(s.analysis.positionBounds.size[2].toFixed(6)) : null),
    },
    { key: "materials", label: "Material count", get: (s) => s.analysis.materials },
    { key: "images", label: "Image count", get: (s) => s.analysis.images },
    {
      key: "baseColorMaterials",
      label: "Materials using baseColor texture",
      get: (s) => s.analysis.pbrChannels.baseColorTextureMaterials,
    },
    {
      key: "metalRoughMaterials",
      label: "Materials using metallicRoughness texture",
      get: (s) => s.analysis.pbrChannels.metallicRoughnessTextureMaterials,
    },
    {
      key: "normalMaterials",
      label: "Materials using normal texture",
      get: (s) => s.analysis.pbrChannels.normalTextureMaterials,
    },
    {
      key: "occlusionMaterials",
      label: "Materials using occlusion texture",
      get: (s) => s.analysis.pbrChannels.occlusionTextureMaterials,
    },
    {
      key: "emissiveMaterials",
      label: "Materials using emissive texture",
      get: (s) => s.analysis.pbrChannels.emissiveTextureMaterials,
    },
    {
      key: "maxTextureDimension",
      label: "Max texture dimension",
      get: (s) => s.analysis.maxTextureDimension,
    },
  ];

  const rows = metricDefs.map((def) => {
    const values = samples.map((s) => ({ id: s.id, value: def.get(s) }));
    const labels = values.map((v) => valueToLabel(v.value));
    const consistent = new Set(labels).size === 1;
    return {
      key: def.key,
      label: def.label,
      consistent,
      values,
    };
  });
  return rows;
}

function buildMarkdownReport(samples: SampleResult[], consistencyRows: ReturnType<typeof buildConsistencyRows>): string {
  const lines: string[] = [];
  lines.push("# Meshy Refine-Only Batch Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Samples: ${samples.length}`);
  lines.push(`Pipeline: preview (pose_mode=t-pose) -> refine (enable_pbr=true), no rigging`);
  lines.push("");

  lines.push("## Prompts");
  for (const s of samples) {
    lines.push(`- \`${s.id}\`: ${s.prompt}`);
  }
  lines.push("");

  lines.push("## Per-Sample Snapshot");
  lines.push("");
  lines.push("| sample | preview task | refine task | meshes | primitives | vertices | materials | images | skins | max tex |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of samples) {
    const a = s.analysis;
    lines.push(
      `| ${s.id} | ${s.previewTaskId} | ${s.refineTaskId} | ${a.meshes} | ${a.primitives} | ${a.totalVertices} | ${a.materials} | ${a.images} | ${a.skins} | ${a.maxTextureDimension ?? "n/a"} |`
    );
  }
  lines.push("");

  const consistent = consistencyRows.filter((r) => r.consistent);
  const inconsistent = consistencyRows.filter((r) => !r.consistent);

  lines.push("## Consistent Across All 5");
  if (consistent.length === 0) {
    lines.push("- none");
  } else {
    for (const row of consistent) {
      lines.push(`- ${row.label}: ${valueToLabel(row.values[0]?.value)}`);
    }
  }
  lines.push("");

  lines.push("## Inconsistent Across Samples");
  if (inconsistent.length === 0) {
    lines.push("- none");
  } else {
    for (const row of inconsistent) {
      const valueList = row.values.map((v) => `${v.id}=${valueToLabel(v.value)}`).join("; ");
      lines.push(`- ${row.label}: ${valueList}`);
    }
  }
  lines.push("");

  lines.push("## Checklist Mapping");
  lines.push("");
  lines.push("Measured now (preview/refine stage):");
  lines.push("- Ingest transform stability: non-uniform and negative scale node counts");
  lines.push("- Geometry consistency: mesh/primitive counts, vertices, UV/normals availability, bounds");
  lines.push("- Material/PBR consistency: baseColor/metallicRoughness/normal usage, texture counts/sizes");
  lines.push("- Runtime cost proxies: vertices, materials, texture dimensions");
  lines.push("");
  lines.push("Deferred until rigging/animation stage:");
  lines.push("- Skeleton/hierarchy consistency");
  lines.push("- Rest-pose and joint orientation consistency");
  lines.push("- Skin weight quality");
  lines.push("- IK/foot-lock behavior");
  lines.push("- Motion retarget quality and contact fidelity");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function runOnePrompt(batchDir: string, spec: PromptSpec): Promise<SampleResult> {
  const sampleDir = join(batchDir, sanitizeSegment(spec.id));
  await mkdir(sampleDir, { recursive: true });

  console.log(`\n=== ${spec.id} ===`);
  console.log(`Prompt: ${spec.prompt}`);

  console.log("Step 1: Creating preview task...");
  const previewRes = await meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v2/text-to-3d", {
    mode: "preview",
    prompt: spec.prompt,
    ai_model: MESHY_MODEL,
    pose_mode: MESHY_POSE_MODE,
    topology: "triangle",
    target_polycount: 10000,
    should_remesh: true,
  });
  const previewTaskId = asNonEmptyString(previewRes.result);
  if (!previewTaskId) throw new Error(`No preview task ID returned for ${spec.id}`);
  console.log(`  preview task ID: ${previewTaskId}`);

  await pollTask(`/openapi/v2/text-to-3d/${previewTaskId}`, `${spec.id}:preview`);
  console.log("  preview done");

  console.log("Step 2: Creating refine task...");
  const refineRes = await meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v2/text-to-3d", {
    mode: "refine",
    preview_task_id: previewTaskId,
    enable_pbr: true,
  });
  const refineTaskId = asNonEmptyString(refineRes.result);
  if (!refineTaskId) throw new Error(`No refine task ID returned for ${spec.id}`);
  console.log(`  refine task ID: ${refineTaskId}`);

  const refineTask = await pollTask(`/openapi/v2/text-to-3d/${refineTaskId}`, `${spec.id}:refine`);
  console.log("  refine done");

  const modelUrls = isRecord(refineTask.model_urls) ? refineTask.model_urls : {};
  const glbUrl = asNonEmptyString(modelUrls.glb);
  if (!glbUrl) {
    throw new Error(`No GLB URL found in refine output for ${spec.id}`);
  }

  const refineTaskPath = join(sampleDir, "refine-task.json");
  await writeFile(refineTaskPath, JSON.stringify(refineTask, null, 2));

  const glbPath = join(sampleDir, `${sanitizeSegment(spec.id)}-refine.glb`);
  console.log(`  downloading GLB -> ${glbPath}`);
  const glbBytes = await downloadWithRetry(glbUrl, glbPath, `${spec.id}-refine.glb`);

  const textureRefs = collectTextureRefs(refineTask.texture_urls);
  const textureFiles = await downloadTextureRefs(textureRefs, sampleDir);

  const analysis = analyzeGlb(glbBytes);
  const analysisPath = join(sampleDir, "analysis.json");
  await writeFile(analysisPath, JSON.stringify(analysis, null, 2));

  return {
    id: spec.id,
    prompt: spec.prompt,
    previewTaskId,
    refineTaskId,
    glbUrl,
    outputDir: sampleDir,
    glbPath,
    textureFiles,
    analysis,
  };
}

async function tryResumeSample(batchDir: string, spec: PromptSpec): Promise<SampleResult | null> {
  const sampleDir = join(batchDir, sanitizeSegment(spec.id));
  const refineTaskPath = join(sampleDir, "refine-task.json");
  const glbPath = join(sampleDir, `${sanitizeSegment(spec.id)}-refine.glb`);
  if (!(await pathExists(refineTaskPath)) || !(await pathExists(glbPath))) {
    return null;
  }

  console.log(`\n=== ${spec.id} (resume) ===`);
  console.log("Found existing refine artifacts, skipping preview/refine generation.");

  const refineTaskRaw = await readFile(refineTaskPath, "utf8");
  const refineTask = JSON.parse(refineTaskRaw) as MeshyTask & Record<string, unknown>;
  const previewTaskId = asNonEmptyString(refineTask.preview_task_id) ?? "unknown";
  const refineTaskId = asNonEmptyString(refineTask.id) ?? "unknown";
  const modelUrls = isRecord(refineTask.model_urls) ? refineTask.model_urls : {};
  const glbUrl = asNonEmptyString(modelUrls.glb) ?? "unknown";

  const textureRefs = collectTextureRefs(refineTask.texture_urls);
  const textureFiles = await downloadTextureRefs(textureRefs, sampleDir);

  const analysisPath = join(sampleDir, "analysis.json");
  let analysis: GlbAnalysis;
  if (await pathExists(analysisPath)) {
    const analysisRaw = await readFile(analysisPath, "utf8");
    analysis = JSON.parse(analysisRaw) as GlbAnalysis;
  } else {
    const glbBytes = new Uint8Array(await readFile(glbPath));
    analysis = analyzeGlb(glbBytes);
    await writeFile(analysisPath, JSON.stringify(analysis, null, 2));
  }

  return {
    id: spec.id,
    prompt: spec.prompt,
    previewTaskId,
    refineTaskId,
    glbUrl,
    outputDir: sampleDir,
    glbPath,
    textureFiles,
    analysis,
  };
}

async function main() {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const outRoot = join(repoRoot, "output", "retargeting-lab");
  const requestedBatchDirRaw = process.env.MESHY_REFINEMENT_BATCH_DIR?.trim();
  const batchDir =
    requestedBatchDirRaw && requestedBatchDirRaw.length > 0
      ? requestedBatchDirRaw.startsWith("/")
        ? requestedBatchDirRaw
        : join(repoRoot, requestedBatchDirRaw)
      : join(outRoot, `meshy-refine-batch-${nowStamp()}`);
  await mkdir(batchDir, { recursive: true });

  console.log("=== Meshy Refine-Only Batch (Retargeting Lab) ===");
  console.log(`Output directory: ${batchDir}`);
  if (requestedBatchDirRaw) {
    console.log(`Resume mode: enabled via MESHY_REFINEMENT_BATCH_DIR=${requestedBatchDirRaw}`);
  }
  console.log(`Prompt count: ${PROMPTS.length}`);
  console.log("Rigging stage: skipped (preview+refine only)\n");

  const results: SampleResult[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const spec = PROMPTS[i];
    console.log(`\n[${i + 1}/${PROMPTS.length}] ${spec.id}`);
    const resumed = await tryResumeSample(batchDir, spec);
    if (resumed) {
      results.push(resumed);
      continue;
    }
    const sample = await runOnePrompt(batchDir, spec);
    results.push(sample);
  }

  const consistencyRows = buildConsistencyRows(results);
  const reportMd = buildMarkdownReport(results, consistencyRows);

  const summary = {
    generatedAt: new Date().toISOString(),
    batchDir,
    promptCount: PROMPTS.length,
    model: MESHY_MODEL,
    notes: {
      riggingStageSkipped: true,
      poseRequestedViaPrompt: true,
      poseKeyword: "T-pose / arms extended horizontally",
      poseModeExplicit: MESHY_POSE_MODE,
    },
    samples: results,
    consistency: consistencyRows,
  };

  const summaryPath = join(batchDir, "summary.json");
  const reportPath = join(batchDir, "comparison-report.md");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  await writeFile(reportPath, reportMd);

  console.log("\n=== Batch complete ===");
  console.log(`Summary JSON: ${summaryPath}`);
  console.log(`Report MD:    ${reportPath}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
