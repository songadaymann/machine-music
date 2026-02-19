/**
 * Mixamo Auto-Rig Pipeline
 *
 * End-to-end headless pipeline:
 * 1. Playwright login → capture Adobe OAuth bearer token
 * 2. Blender headless → compute 7 marker positions from mesh
 * 3. REST API → upload mesh, submit markers, poll until rigged
 * 4. Download rigged FBX → convert to GLB via Blender
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run client/retargeting-lab/mixamo-rig-pipeline.ts
 *
 * Env vars:
 *   MIXAMO_INPUT_GLB  — path to input GLB (default: latest gemini-meshy-single output)
 *   BLENDER_BIN       — path to Blender binary (default: /Applications/Blender.app/Contents/MacOS/Blender)
 *   MIXAMO_TOKEN      — skip Playwright login, use this token directly
 *   MIXAMO_TOKEN_FILE — read token from this file (e.g. from a previous intercept run)
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { $ } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BLENDER_BIN =
  process.env.BLENDER_BIN ||
  "/Applications/Blender.app/Contents/MacOS/Blender";

const MIXAMO_API = "https://www.mixamo.com/api/v1";
const MIXAMO_API_KEY = "mixamo2";

const OUTPUT_DIR = join(
  "output",
  "retargeting-lab",
  `mixamo-pipeline-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Find input GLB
// ---------------------------------------------------------------------------
function findInputGlb(): string {
  if (process.env.MIXAMO_INPUT_GLB) {
    return process.env.MIXAMO_INPUT_GLB;
  }
  // Find latest gemini-meshy-single output
  const glob = new Bun.Glob(
    "output/retargeting-lab/gemini-meshy-single-*/**/*.glb"
  );
  const files = Array.from(glob.scanSync(".")).sort().reverse();
  if (files.length > 0) {
    console.log(`[pipeline] Auto-detected input: ${files[0]}`);
    return files[0];
  }
  throw new Error(
    "No input GLB found. Set MIXAMO_INPUT_GLB or run generate-gemini-meshy-single.ts first."
  );
}

// ---------------------------------------------------------------------------
// Step 1: Get auth token (Playwright or cached)
// ---------------------------------------------------------------------------
async function getAuthToken(): Promise<string> {
  // Check for direct token
  if (process.env.MIXAMO_TOKEN) {
    console.log("[auth] Using MIXAMO_TOKEN from env");
    return process.env.MIXAMO_TOKEN;
  }

  // Check for token file
  if (process.env.MIXAMO_TOKEN_FILE && existsSync(process.env.MIXAMO_TOKEN_FILE)) {
    const token = readFileSync(process.env.MIXAMO_TOKEN_FILE, "utf-8").trim();
    if (token) {
      console.log(`[auth] Using token from ${process.env.MIXAMO_TOKEN_FILE}`);
      return token;
    }
  }

  // Check for cached token from a previous intercept run
  const interceptGlob = new Bun.Glob(
    "output/retargeting-lab/mixamo-intercept-*/auth-token.txt"
  );
  const tokenFiles = Array.from(interceptGlob.scanSync(".")).sort().reverse();
  if (tokenFiles.length > 0) {
    const token = readFileSync(tokenFiles[0], "utf-8").trim();
    if (token) {
      console.log(`[auth] Using cached token from ${tokenFiles[0]}`);
      return token;
    }
  }

  // Fall back to Playwright login
  console.log("[auth] No cached token found. Opening browser for Adobe login...");
  console.log("[auth] Log in, then the browser will close automatically.");

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1200,800"],
  });

  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
  });

  const page = await context.newPage();
  await page.goto("https://www.mixamo.com/", { waitUntil: "domcontentloaded" });

  // Poll for auth token
  let token: string | null = null;
  for (let i = 0; i < 300; i++) {
    // 5 min timeout
    await new Promise((r) => setTimeout(r, 1000));
    try {
      token = await page.evaluate(() =>
        localStorage.getItem("access_token")
      );
      if (token) break;
    } catch {
      // Page might be on Adobe's domain during login
    }
  }

  await browser.close();

  if (!token) {
    throw new Error("Failed to capture auth token. Did you complete the login?");
  }

  // Cache for future runs
  const tokenPath = join(OUTPUT_DIR, "auth-token.txt");
  writeFileSync(tokenPath, token);
  console.log(`[auth] Token captured and cached at ${tokenPath}`);

  return token;
}

// ---------------------------------------------------------------------------
// Step 2: Compute markers from mesh via Blender
// ---------------------------------------------------------------------------
async function computeMarkers(
  inputGlb: string
): Promise<{ markers: Record<string, { x: number; y: number }>; bounds: Record<string, number> }> {
  const markersJson = join(OUTPUT_DIR, "markers.json");
  const scriptPath = "scripts/compute-mixamo-markers.py";

  console.log(`[markers] Running Blender on ${inputGlb}...`);

  const result =
    await $`${BLENDER_BIN} --background --python ${scriptPath} -- ${inputGlb} ${markersJson} 2>&1`.text();

  // Log Blender output
  const blenderLines = result
    .split("\n")
    .filter((l: string) => l.includes("[markers]"));
  for (const line of blenderLines) {
    console.log(line);
  }

  if (!existsSync(markersJson)) {
    console.error("[markers] Blender output:", result);
    throw new Error("Blender failed to compute markers");
  }

  return JSON.parse(readFileSync(markersJson, "utf-8"));
}

// ---------------------------------------------------------------------------
// Step 3: Transform markers from Blender space to Mixamo viewport space
// ---------------------------------------------------------------------------
function transformMarkersForMixamo(
  markers: Record<string, { x: number; y: number }>,
  bounds: Record<string, number>
): Record<string, { x: number; y: number; z: number }> {
  // Calibration from intercepted session (Feb 16, 2026):
  //
  // Captured Mixamo values:     Our Blender values (meters):
  //   chin:  x=-0.095, y=67.64    chin:  x=0.0,   y=0.9
  //   larm:  x=-71.33, y=57.91    larm:  x=-0.942, y=0.565
  //   rarm:  x=71.14,  y=57.91    rarm:  x=0.945,  y=0.565
  //
  // Scale ratios:
  //   x: -71.33 / -0.942 = 75.7
  //   y: 67.64 / 0.9 = 75.2
  //
  // Mixamo's viewport space ≈ Blender meters × 75.5
  // (likely: FBX cm conversion × viewer camera scale)
  //
  // Constant z for all markers = front projection plane depth

  const Z_FRONT = 294.56;

  // The Blender markers have y relative to mesh center (z=0 in Blender).
  // Mixamo expects all-positive coordinates (mesh bottom at y=0).
  // bounds.z_min is the bottom of the mesh in Blender Z-up space.
  const yOffset = -(bounds.z_min || -1.0); // shift so bottom = 0

  // Scale: Blender meters → Mixamo viewport units.
  // From calibration: Mixamo viewport ≈ Blender meters × 75.5
  // BUT this was calibrated against a different mesh. The scale likely
  // depends on how Mixamo normalizes meshes in its viewer.
  //
  // Alternative theory: FBX is in centimeters (×100), then Mixamo's
  // viewer applies its own normalization.
  //
  // Let's try multiple scale options via env var, defaulting to 100
  // (pure FBX cm) since that's the most predictable transform.
  const scale = parseFloat(process.env.MIXAMO_SCALE || "100");

  console.log(`[transform] yOffset=${yOffset.toFixed(4)} (shifting mesh bottom to y=0)`);
  console.log(`[transform] scale=${scale} (Blender meters → Mixamo viewport)`);

  const result: Record<string, { x: number; y: number; z: number }> = {};

  for (const [name, pos] of Object.entries(markers)) {
    result[name] = {
      x: pos.x * scale,
      y: (pos.y + yOffset) * scale,
      z: Z_FRONT,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3b: Convert GLB to FBX via Blender (Mixamo only accepts FBX/OBJ)
// ---------------------------------------------------------------------------
async function convertGlbToFbx(inputGlb: string): Promise<string> {
  const fbxPath = join(OUTPUT_DIR, basename(inputGlb).replace(/\.glb$/i, ".fbx"));
  console.log(`[convert] GLB → FBX: ${basename(inputGlb)} → ${basename(fbxPath)}`);

  const script = `
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[-2])
bpy.ops.export_scene.fbx(
    filepath=sys.argv[-1],
    use_selection=False,
    apply_scale_options='FBX_SCALE_ALL',
    path_mode='COPY',
    embed_textures=True,
)
print("[convert] FBX export complete")
`;

  const scriptPath = join(OUTPUT_DIR, "_glb2fbx.py");
  writeFileSync(scriptPath, script);

  const result = await $`${BLENDER_BIN} --background --python ${scriptPath} -- ${inputGlb} ${fbxPath} 2>&1`.text();

  if (!existsSync(fbxPath)) {
    console.error("[convert] Blender output:", result);
    throw new Error("GLB→FBX conversion failed");
  }

  const size = readFileSync(fbxPath).length;
  console.log(`[convert] FBX written: ${(size / 1024).toFixed(0)} KB`);
  return fbxPath;
}

// ---------------------------------------------------------------------------
// Step 4: Upload mesh to Mixamo
// ---------------------------------------------------------------------------
async function uploadCharacter(
  token: string,
  fbxPath: string
): Promise<string> {
  console.log(`[upload] Uploading ${basename(fbxPath)} to Mixamo...`);

  const fileData = readFileSync(fbxPath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileData], { type: "application/octet-stream" }),
    basename(fbxPath)
  );

  const resp = await fetch(`${MIXAMO_API}/characters`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Api-Key": MIXAMO_API_KEY,
    },
    body: formData,
  });

  if (!resp.ok && resp.status !== 202) {
    const body = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { uuid: string; status: string };
  console.log(
    `[upload] Character UUID: ${data.uuid}, status: ${data.status}`
  );
  return data.uuid;
}

// ---------------------------------------------------------------------------
// Step 5: Poll monitor until job completes
// ---------------------------------------------------------------------------
async function pollUntilComplete(
  token: string,
  characterId: string,
  label: string,
  maxWaitMs = 120_000
): Promise<void> {
  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < maxWaitMs) {
    const resp = await fetch(
      `${MIXAMO_API}/characters/${characterId}/monitor`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Api-Key": MIXAMO_API_KEY,
        },
      }
    );

    const data = (await resp.json()) as {
      status: string;
      message: string;
      job_type: string;
    };

    if (data.status === "completed") {
      console.log(`[${label}] Completed: ${data.message}`);
      return;
    }

    if (data.status === "failed") {
      throw new Error(`[${label}] Job failed: ${data.message}`);
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error(`[${label}] Timed out after ${maxWaitMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Step 5b: Read Mixamo's unrigged geometry to discover coordinate space
// ---------------------------------------------------------------------------
async function discoverMixamoCoordinateSpace(
  token: string,
  characterId: string
): Promise<{ geoId: string; bounds: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number } } | null> {
  console.log("[discover] Reading Mixamo's unrigged geometry...");

  // Fetch verold.json to find the geometry asset ID
  const veroldResp = await fetch(
    `${MIXAMO_API}/characters/${characterId}/assets/unrigged/verold.json`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": MIXAMO_API_KEY,
      },
    }
  );

  if (!veroldResp.ok) {
    console.log(`[discover] Failed to fetch verold.json (${veroldResp.status})`);
    return null;
  }

  const verold = (await veroldResp.json()) as Array<{ type: string; id: string; name: string }>;
  writeFileSync(join(OUTPUT_DIR, "unrigged-verold.json"), JSON.stringify(verold, null, 2));

  // Find the geometry asset
  const geoAsset = verold.find((a) => a.type === "mesh" || a.type === "geometry");
  if (!geoAsset) {
    // The geo ID is embedded in the verold differently - look for geo.json files
    // From the intercept, the URL pattern is: /assets/unrigged/{id}-geo.json
    // The id comes from the mesh entry's geometry reference
    console.log("[discover] No explicit geo asset in verold, looking for mesh references...");
  }

  // Fetch the geo.json to get vertex attribute info
  // From the intercept, the geo JSON has vertex_attributes.positions with count and fileOffset
  // We need to fetch the binary to get actual vertex positions

  // For now, let's try a different approach: use the character's thumbnail/viewer data
  // Actually, let's fetch the geo binary and compute bounds ourselves

  // The geo file IDs follow the pattern seen in the intercept
  // Let's look at what verold.json contains
  const meshEntries = verold.filter((a: Record<string, unknown>) =>
    a.type === "mesh" || (a as Record<string, unknown>).resources !== undefined
  );

  console.log(`[discover] Verold entries: ${verold.map((v) => `${v.type}:${v.name}`).join(", ")}`);

  // Try to find geo files by listing what's available
  // From intercept pattern: the geo ID is in the URL like {uuid}-geo.json
  for (const entry of verold) {
    if (entry.type !== "mesh") continue;
    const mesh = entry as Record<string, unknown>;
    const resources = mesh.resources as Array<{ path: string }> | undefined;
    if (resources) {
      for (const res of resources) {
        if (res.path.endsWith("-geo.json")) {
          const geoId = res.path.replace("-geo.json", "");
          console.log(`[discover] Found geo asset: ${geoId}`);

          // Fetch geo.json for metadata
          const geoResp = await fetch(
            `${MIXAMO_API}/characters/${characterId}/assets/unrigged/${res.path}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "X-Api-Key": MIXAMO_API_KEY,
              },
            }
          );
          if (geoResp.ok) {
            const geoMeta = await geoResp.json();
            writeFileSync(join(OUTPUT_DIR, "unrigged-geo.json"), JSON.stringify(geoMeta, null, 2));
            console.log("[discover] Geo metadata saved");
          }
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 6: Submit rig markers
// ---------------------------------------------------------------------------
async function submitRig(
  token: string,
  characterId: string,
  mixamoMarkers: Record<string, { x: number; y: number; z: number }>
): Promise<void> {
  console.log("[rig] Submitting markers...");

  for (const [name, pos] of Object.entries(mixamoMarkers)) {
    console.log(
      `  ${name}: x=${pos.x.toFixed(2)}, y=${pos.y.toFixed(2)}, z=${pos.z.toFixed(2)}`
    );
  }

  const resp = await fetch(
    `${MIXAMO_API}/characters/${characterId}/rig`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": MIXAMO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rigging_inputs: mixamoMarkers }),
    }
  );

  if (!resp.ok && resp.status !== 202) {
    const body = await resp.text();
    throw new Error(`Rig submission failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { status: string; job_type: string };
  console.log(`[rig] Job queued: ${data.job_type}`);
}

// ---------------------------------------------------------------------------
// Step 7: Download rigged character assets
// ---------------------------------------------------------------------------
async function downloadRiggedAssets(
  token: string,
  characterId: string
): Promise<string> {
  // First check character status
  const charResp = await fetch(
    `${MIXAMO_API}/characters/${characterId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": MIXAMO_API_KEY,
      },
    }
  );

  const charData = (await charResp.json()) as { status: string; name: string };
  console.log(
    `[download] Character "${charData.name}" status: ${charData.status}`
  );

  if (charData.status !== "ready") {
    throw new Error(`Character not ready: ${charData.status}`);
  }

  // Download the skeleton
  const skelResp = await fetch(
    `${MIXAMO_API}/characters/${characterId}/assets/rigged/skeleton.json`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": MIXAMO_API_KEY,
      },
    }
  );

  const skeleton = await skelResp.json();
  const skelPath = join(OUTPUT_DIR, "rigged-skeleton.json");
  writeFileSync(skelPath, JSON.stringify(skeleton, null, 2));
  console.log(`[download] Skeleton saved to ${skelPath}`);

  // Try to export as FBX via the animations/export endpoint
  console.log("[download] Requesting FBX export...");

  const exportResp = await fetch(`${MIXAMO_API}/animations/export`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Api-Key": MIXAMO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      character_id: characterId,
      gms_hash: [
        {
          "model-id": 118060902,
          mirror: false,
          trim: [0, 100],
          overdrive: 0,
          params: "0,0",
          "arm-space": 0,
          inplace: false,
        },
      ],
      preferences: { format: "fbx7_unity", skin: "true", fps: "30" },
      product_name: "Idle",
      type: "Motion",
    }),
  });

  if (!exportResp.ok && exportResp.status !== 202) {
    const body = await exportResp.text();
    console.log(
      `[download] Export request failed (${exportResp.status}): ${body}`
    );
    console.log("[download] Skeleton JSON saved; FBX export needs investigation.");
    return skelPath;
  }

  // Poll for export completion
  const exportData = (await exportResp.json()) as Record<string, unknown>;
  console.log("[download] Export response:", JSON.stringify(exportData));
  writeFileSync(
    join(OUTPUT_DIR, "export-response.json"),
    JSON.stringify(exportData, null, 2)
  );

  // The export endpoint typically returns a monitor URL or download URL
  // We'll need to handle whatever comes back
  return skelPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Mixamo Auto-Rig Pipeline ===");
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log("");

  // Find input
  const inputGlb = findInputGlb();
  console.log(`Input: ${inputGlb}`);
  console.log("");

  // Step 1: Auth
  const token = await getAuthToken();
  console.log(`[auth] Token: ${token.slice(0, 30)}...`);
  console.log("");

  // Step 2: Compute markers
  const { markers, bounds } = await computeMarkers(inputGlb);
  console.log("");

  // Step 3: Transform markers for Mixamo
  const mixamoMarkers = transformMarkersForMixamo(markers, bounds);

  // Save both raw and transformed markers
  writeFileSync(
    join(OUTPUT_DIR, "markers-raw.json"),
    JSON.stringify({ markers, bounds }, null, 2)
  );
  writeFileSync(
    join(OUTPUT_DIR, "markers-mixamo.json"),
    JSON.stringify(mixamoMarkers, null, 2)
  );
  console.log("");

  // Step 3b: Convert GLB to FBX for Mixamo
  const fbxPath = await convertGlbToFbx(inputGlb);
  console.log("");

  // Step 4: Upload FBX
  const characterId = await uploadCharacter(token, fbxPath);
  console.log("");

  // Step 5: Poll upload processing
  await pollUntilComplete(token, characterId, "upload");
  console.log("");

  // Step 5b: Discover Mixamo's coordinate space from unrigged geometry
  await discoverMixamoCoordinateSpace(token, characterId);
  console.log("");

  // Step 6: Submit rig
  console.log("[rig] Submitting with scale=" + (process.env.MIXAMO_SCALE || "100"));
  await submitRig(token, characterId, mixamoMarkers);
  console.log("");

  // Step 7: Poll rigging
  await pollUntilComplete(token, characterId, "rig");
  console.log("");

  // Step 8: Download
  const outputPath = await downloadRiggedAssets(token, characterId);
  console.log("");

  // Save run metadata
  writeFileSync(
    join(OUTPUT_DIR, "run-metadata.json"),
    JSON.stringify(
      {
        input: inputGlb,
        characterId,
        outputPath,
        timestamp: new Date().toISOString(),
        scale: parseFloat(process.env.MIXAMO_SCALE || "100"),
      },
      null,
      2
    )
  );

  console.log("=== Pipeline complete ===");
  console.log(`Character ID: ${characterId}`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
