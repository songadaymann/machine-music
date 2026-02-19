/**
 * Retargeting Lab utility:
 * - Generate one Gemini ("Nano Banana") character reference image from a JSON spec.
 * - Use that image as input to Meshy image-to-3d.
 * - Download artifacts for fast T-pose inspection.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run client/retargeting-lab/generate-gemini-meshy-single.ts
 *
 * Optional environment variables:
 *   RETARGETING_LAB_CHARACTER_SPEC=client/retargeting-lab/nano-banana-tpose-spec.streetwear-man.json
 *   RETARGETING_LAB_OUTPUT_DIR=output/retargeting-lab/gemini-meshy-single-<timestamp>
 *   GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
 *   MESHY_IMAGE_TO_3D_MODEL=meshy-6
 */

import { access, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MESHY_BASE_URL = "https://api.meshy.ai";

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
const MESHY_IMAGE_TO_3D_MODEL = process.env.MESHY_IMAGE_TO_3D_MODEL?.trim() || "meshy-6";
const MESHY_TARGET_POLYCOUNT = 10000;

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const DOWNLOAD_RETRY_COUNT = 2;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const MESHY_API_KEY = process.env.MESHY_API_KEY?.trim();
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set. Export it or source .env before running.");
  process.exit(1);
}
if (!MESHY_API_KEY) {
  console.error("MESHY_API_KEY not set. Export it or source .env before running.");
  process.exit(1);
}

interface CharacterImageSpec {
  id: string;
  name: string;
  description: string;
  visual_style: string;
  pose: {
    type: string;
    arm_angle_degrees: number;
    hand_orientation: string;
    leg_stance: string;
    expression: string;
  };
  framing: {
    full_body_visible: boolean;
    centered: boolean;
    camera_view: string;
    feet_visible: boolean;
    aspect_ratio: string;
  };
  background: {
    type: string;
    color: string;
    description: string;
  };
  exclusions: string[];
}

interface GeminiInlineData {
  mimeType?: unknown;
  mime_type?: unknown;
  data?: unknown;
}

interface GeminiPart {
  text?: unknown;
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
  finishReason?: unknown;
  finish_reason?: unknown;
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: unknown;
}

interface MeshyTaskCreateResponse {
  result?: unknown;
}

interface MeshyTaskError {
  message?: unknown;
}

interface MeshyTask {
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  model_urls?: unknown;
  texture_urls?: unknown;
  thumbnail_url?: unknown;
  task_error?: MeshyTaskError;
}

interface MeshyTextureRef {
  key: string;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolvePath(repoRoot: string, input: string): string {
  return input.startsWith("/") ? input : join(repoRoot, input);
}

function extFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  return "bin";
}

function extensionFromUrl(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const idx = clean.lastIndexOf(".");
  if (idx < 0) return "bin";
  const ext = clean.slice(idx + 1).toLowerCase();
  return ext.length > 0 ? ext : "bin";
}

function makeDataUri(mimeType: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

function collectTextureRefs(input: unknown): MeshyTextureRef[] {
  const refs: MeshyTextureRef[] = [];

  const visit = (value: unknown, path: string) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      refs.push({ key: path || "texture", url: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, path ? `${path}[${index}]` : `[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, path ? `${path}.${key}` : key);
      }
    }
  };

  visit(input, "");

  const dedup = new Map<string, MeshyTextureRef>();
  for (const ref of refs) {
    if (!dedup.has(ref.url)) dedup.set(ref.url, ref);
  }
  return [...dedup.values()];
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
      return await downloadToFile(url, outPath);
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

async function loadCharacterSpec(specPath: string): Promise<CharacterImageSpec> {
  const raw = await readFile(specPath, "utf8");
  const parsed = JSON.parse(raw) as CharacterImageSpec;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid spec JSON in ${specPath}`);
  }
  if (!asNonEmptyString(parsed.id)) {
    throw new Error(`Spec ${specPath} is missing "id"`);
  }
  if (!asNonEmptyString(parsed.description)) {
    throw new Error(`Spec ${specPath} is missing "description"`);
  }
  if (!isRecord(parsed.framing) || !asNonEmptyString(parsed.framing.aspect_ratio)) {
    throw new Error(`Spec ${specPath} is missing framing.aspect_ratio`);
  }
  return parsed;
}

function buildGeminiPrompt(spec: CharacterImageSpec): string {
  const specJson = JSON.stringify(spec, null, 2);
  return [
    "Create exactly one full-body character reference image for 3D model generation.",
    "Follow the JSON specification literally.",
    "",
    "JSON specification:",
    "```json",
    specJson,
    "```",
    "",
    "Hard requirements:",
    "- A strict T-pose with both arms straight and horizontal at shoulder height.",
    "- Entire body visible from head to toe with feet inside the frame.",
    "- Single character only, centered, no props, no extra people.",
    "- Neutral plain background matching the JSON.",
    "- No text, logos, watermarks, borders, or dramatic camera angles.",
  ].join("\n");
}

async function geminiGenerateImage(prompt: string, aspectRatio: string): Promise<{
  mimeType: string;
  bytes: Uint8Array;
  responseJson: GeminiGenerateResponse;
}> {
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY ?? ""
  )}`;
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio,
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseJson: GeminiGenerateResponse;
  try {
    responseJson = JSON.parse(responseText) as GeminiGenerateResponse;
  } catch {
    throw new Error(`Gemini returned non-JSON (${response.status}): ${responseText.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Gemini generateContent failed (${response.status}): ${responseText.slice(0, 500)}`);
  }

  const candidates = Array.isArray(responseJson.candidates) ? responseJson.candidates : [];
  const textParts: string[] = [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inlineData = part.inlineData ?? part.inline_data;
      const mimeType = asNonEmptyString(inlineData?.mimeType ?? inlineData?.mime_type);
      const data = asNonEmptyString(inlineData?.data);
      if (mimeType && data) {
        return {
          mimeType,
          bytes: new Uint8Array(Buffer.from(data, "base64")),
          responseJson,
        };
      }
      const text = asNonEmptyString(part.text);
      if (text) textParts.push(text);
    }
  }

  const hint = textParts.length > 0 ? ` Text output: ${textParts.join(" | ")}` : "";
  throw new Error(`Gemini response did not include an image part.${hint}`);
}

async function meshyRequest<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${MESHY_API_KEY}` };
  let payload: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${MESHY_BASE_URL}${path}`, { method, headers, body: payload });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meshy ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

async function pollMeshyImageTask(taskId: string): Promise<MeshyTask> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const task = await meshyRequest<MeshyTask>("GET", `/openapi/v1/image-to-3d/${taskId}`);
    const status = `${task.status ?? ""}`.toUpperCase();
    const progress =
      typeof task.progress === "number" ? task.progress.toFixed(1) : typeof task.progress === "string" ? task.progress : "?";
    console.log(`  [meshy:image-to-3d] status=${status || "UNKNOWN"} progress=${progress}`);

    if (status === "SUCCEEDED") return task;
    if (status === "FAILED" || status === "CANCELED") {
      const details = asNonEmptyString(task.task_error?.message) ?? JSON.stringify(task);
      throw new Error(`Meshy image-to-3d task ${status}: ${details}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Meshy image-to-3d task timed out");
}

function extractMeshyGlbUrl(task: MeshyTask): string | null {
  if (isRecord(task.model_urls)) {
    const direct = asNonEmptyString(task.model_urls.glb);
    if (direct) return direct;
  }
  return null;
}

async function main() {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const defaultSpecPath = fileURLToPath(new URL("./nano-banana-tpose-spec.streetwear-man.json", import.meta.url));
  const requestedSpecPath = process.env.RETARGETING_LAB_CHARACTER_SPEC?.trim();
  const specPath = requestedSpecPath ? resolvePath(repoRoot, requestedSpecPath) : defaultSpecPath;

  if (!(await pathExists(specPath))) {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const spec = await loadCharacterSpec(specPath);
  const prompt = buildGeminiPrompt(spec);
  const sampleId = sanitizeSegment(spec.id);

  const outRoot = join(repoRoot, "output", "retargeting-lab");
  const requestedOutputDir = process.env.RETARGETING_LAB_OUTPUT_DIR?.trim();
  const runDir =
    requestedOutputDir && requestedOutputDir.length > 0
      ? resolvePath(repoRoot, requestedOutputDir)
      : join(outRoot, `gemini-meshy-single-${nowStamp()}`);
  const sampleDir = join(runDir, sampleId);
  await mkdir(sampleDir, { recursive: true });

  console.log("=== Retargeting Lab: Gemini -> Meshy (Single Character) ===");
  console.log(`Spec file: ${specPath}`);
  console.log(`Sample ID: ${sampleId}`);
  console.log(`Output:    ${sampleDir}`);
  console.log(`Gemini model: ${GEMINI_IMAGE_MODEL}`);
  console.log(`Meshy model:  ${MESHY_IMAGE_TO_3D_MODEL}`);

  const geminiRequestPath = join(sampleDir, "gemini-request.txt");
  await writeFile(geminiRequestPath, prompt);

  console.log("\nStep 1: Generating reference image with Gemini...");
  const gemini = await geminiGenerateImage(prompt, spec.framing.aspect_ratio);
  const imageExt = extFromMimeType(gemini.mimeType);
  const referenceImagePath = join(sampleDir, `reference-image.${imageExt}`);
  await writeFile(referenceImagePath, gemini.bytes);
  const geminiResponsePath = join(sampleDir, "gemini-response.json");
  await writeFile(geminiResponsePath, JSON.stringify(gemini.responseJson, null, 2));
  console.log(`  saved reference image -> ${referenceImagePath}`);

  console.log("\nStep 2: Submitting image to Meshy image-to-3d...");
  const imageDataUri = makeDataUri(gemini.mimeType, gemini.bytes);
  const createTaskRes = await meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v1/image-to-3d", {
    image_url: imageDataUri,
    ai_model: MESHY_IMAGE_TO_3D_MODEL,
    topology: "triangle",
    target_polycount: MESHY_TARGET_POLYCOUNT,
    should_texture: true,
    should_remesh: true,
  });

  const imageTaskId = asNonEmptyString(createTaskRes.result);
  if (!imageTaskId) {
    throw new Error("Meshy image-to-3d create response did not include a task ID");
  }
  console.log(`  image-to-3d task ID: ${imageTaskId}`);

  const meshyTask = await pollMeshyImageTask(imageTaskId);
  const meshyTaskPath = join(sampleDir, "meshy-image-task.json");
  await writeFile(meshyTaskPath, JSON.stringify(meshyTask, null, 2));
  console.log(`  saved Meshy task json -> ${meshyTaskPath}`);

  const glbUrl = extractMeshyGlbUrl(meshyTask);
  if (!glbUrl) {
    throw new Error("Meshy task succeeded but no GLB URL was found");
  }

  const glbPath = join(sampleDir, `${sampleId}-image-to-3d.glb`);
  console.log(`\nStep 3: Downloading GLB -> ${glbPath}`);
  await downloadWithRetry(glbUrl, glbPath, `${sampleId}.glb`);

  let previewImagePath: string | null = null;
  const thumbnailUrl = asNonEmptyString(meshyTask.thumbnail_url);
  if (thumbnailUrl) {
    const thumbExt = extensionFromUrl(thumbnailUrl);
    previewImagePath = join(sampleDir, `meshy-preview.${thumbExt}`);
    await downloadWithRetry(thumbnailUrl, previewImagePath, `${sampleId}.preview`);
  }

  const textureRefs = collectTextureRefs(meshyTask.texture_urls);
  const textureFiles: string[] = [];
  for (let i = 0; i < textureRefs.length; i++) {
    const ref = textureRefs[i];
    const ext = extensionFromUrl(ref.url);
    const texturePath = join(sampleDir, `${String(i + 1).padStart(2, "0")}-${sanitizeSegment(ref.key)}.${ext}`);
    try {
      await downloadWithRetry(ref.url, texturePath, texturePath);
      textureFiles.push(texturePath);
    } catch (error) {
      console.warn(`  texture download skipped (${ref.url}): ${String(error)}`);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    specPath,
    sampleId,
    models: {
      gemini: GEMINI_IMAGE_MODEL,
      meshy: MESHY_IMAGE_TO_3D_MODEL,
    },
    outputs: {
      sampleDir,
      geminiRequestPath,
      geminiResponsePath,
      referenceImagePath,
      meshyTaskPath,
      glbPath,
      previewImagePath,
      textureFiles,
    },
    meshy: {
      imageTaskId,
      glbUrl,
    },
  };
  const summaryPath = join(sampleDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log("\n=== Done ===");
  console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
