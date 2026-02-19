/**
 * Anything World Rig Pipeline
 *
 * Uploads a GLB to Anything World's "Animate Anything" API,
 * polls until rigging+animation completes (~10 min), then
 * downloads the rigged GLB and animation GLBs.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run client/retargeting-lab/anything-world-rig.ts
 *
 * Env vars:
 *   ANIMATE_ANYTHING       — API key (required)
 *   MIXAMO_INPUT_GLB       — path to input GLB (default: latest gemini-meshy-single output)
 */

import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, basename } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_KEY = process.env.ANIMATE_ANYTHING?.trim();
const API_BASE = "https://api.anything.world";

const OUTPUT_DIR = join(
  "output",
  "retargeting-lab",
  `anything-world-rig-${new Date().toISOString().replace(/[:.]/g, "-")}`
);
mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(tag: string, msg: string) {
  console.log(`[${tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Step 1: Find input GLB
// ---------------------------------------------------------------------------
function findInputGlb(): string {
  if (process.env.MIXAMO_INPUT_GLB) {
    return process.env.MIXAMO_INPUT_GLB;
  }
  const glob = new Bun.Glob(
    "output/retargeting-lab/gemini-meshy-single-*/**/*.glb"
  );
  const files = Array.from(glob.scanSync(".")).sort().reverse();
  if (files.length > 0) {
    log("input", `Auto-detected: ${files[0]}`);
    return files[0];
  }
  throw new Error(
    "No input GLB found. Set MIXAMO_INPUT_GLB or run generate-gemini-meshy-single.ts first."
  );
}

// ---------------------------------------------------------------------------
// Step 2: Upload to Anything World /animate
// ---------------------------------------------------------------------------
async function uploadAndAnimate(glbPath: string): Promise<string> {
  log("upload", `Uploading ${basename(glbPath)} to Anything World...`);

  const fileData = readFileSync(glbPath);
  const fileName = basename(glbPath);

  const form = new FormData();
  form.append("key", API_KEY!);
  form.append("model_name", fileName.replace(/\.glb$/i, ""));
  form.append("model_type", "humanoid");
  form.append("symmetry", "true");
  form.append("auto_rotate", "true");
  form.append("files", new Blob([fileData], { type: "model/gltf-binary" }), fileName);

  const resp = await fetch(`${API_BASE}/animate`, {
    method: "POST",
    body: form,
    verbose: true,
  } as any);

  const respText = await resp.text();
  log("upload", `Response (${resp.status}): ${respText.slice(0, 500)}`);

  if (!resp.ok) {
    throw new Error(`Upload failed (${resp.status}): ${respText}`);
  }

  let data: { model_id?: string };
  try {
    data = JSON.parse(respText);
  } catch {
    throw new Error(`Non-JSON response: ${respText}`);
  }

  if (!data.model_id) {
    throw new Error(`No model_id in response: ${respText}`);
  }

  log("upload", `Model ID: ${data.model_id}`);
  writeFileSync(join(OUTPUT_DIR, "upload-response.json"), JSON.stringify(data, null, 2));
  return data.model_id;
}

// ---------------------------------------------------------------------------
// Step 3: Poll for completion
// ---------------------------------------------------------------------------
async function pollUntilDone(modelId: string): Promise<Record<string, unknown>> {
  log("poll", "Waiting for rigging + animation to complete (~10 min)...");
  const start = Date.now();
  const maxWait = 20 * 60_000; // 20 minutes max

  while (Date.now() - start < maxWait) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);

    const resp = await fetch(
      `${API_BASE}/user-processed-model?key=${encodeURIComponent(API_KEY!)}&id=${encodeURIComponent(modelId)}&stage=done`
    );

    if (resp.status === 200) {
      const data = await resp.json() as Record<string, unknown>;
      log("poll", `Completed after ${elapsed}s`);
      writeFileSync(join(OUTPUT_DIR, "processed-model.json"), JSON.stringify(data, null, 2));
      return data;
    }

    if (resp.status === 403) {
      // Still processing
      process.stdout.write(`\r[poll] Processing... ${elapsed}s`);
    } else if (resp.status === 404) {
      log("poll", `Model not found (404) — may still be queuing. ${elapsed}s`);
    } else if (resp.status === 429) {
      throw new Error("Insufficient credits (429)");
    } else {
      const text = await resp.text();
      log("poll", `Unexpected status ${resp.status}: ${text.slice(0, 200)}`);
    }

    await sleep(15_000); // Poll every 15s
  }

  throw new Error(`Timed out after ${maxWait / 60_000} minutes`);
}

// ---------------------------------------------------------------------------
// Step 4: Download rigged GLB + animations
// ---------------------------------------------------------------------------
async function downloadResults(data: Record<string, unknown>): Promise<void> {
  const model = data.model as Record<string, unknown> | undefined;
  if (!model) {
    log("download", "No 'model' field in response");
    return;
  }

  const rig = model.rig as Record<string, unknown> | undefined;
  if (!rig) {
    log("download", "No 'rig' field in model — rigging may have failed");
    return;
  }

  // Download rigged GLB
  const rigGlbUrl = rig.GLB as string | undefined;
  if (rigGlbUrl) {
    log("download", `Downloading rigged GLB...`);
    const resp = await fetch(rigGlbUrl);
    if (resp.ok) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      const outPath = join(OUTPUT_DIR, "rigged.glb");
      writeFileSync(outPath, buf);
      log("download", `Rigged GLB saved: ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
    } else {
      log("download", `Failed to download rigged GLB: ${resp.status}`);
    }
  }

  // Download animations
  const animations = rig.animations as Record<string, Record<string, string>> | undefined;
  if (animations) {
    const animDir = join(OUTPUT_DIR, "animations");
    mkdirSync(animDir, { recursive: true });

    const animNames = Object.keys(animations);
    log("download", `Downloading ${animNames.length} animations: ${animNames.join(", ")}`);

    for (const [name, formats] of Object.entries(animations)) {
      const glbUrl = formats.GLB || formats.glb;
      if (!glbUrl) continue;

      try {
        const resp = await fetch(glbUrl);
        if (resp.ok) {
          const buf = new Uint8Array(await resp.arrayBuffer());
          const outPath = join(animDir, `${name}.glb`);
          writeFileSync(outPath, buf);
          log("download", `  ${name}.glb (${(buf.length / 1024).toFixed(0)} KB)`);
        }
      } catch (err) {
        log("download", `  ${name}: download failed — ${err}`);
      }
    }
  } else {
    log("download", "No animations in response");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Anything World Rig Pipeline ===");
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log("");

  if (!API_KEY) {
    throw new Error("ANIMATE_ANYTHING env var not set. Add your API key to .env");
  }

  // Step 1: Find input
  const inputGlb = findInputGlb();
  log("input", inputGlb);

  // Step 2: Upload
  const modelId = await uploadAndAnimate(inputGlb);

  // Step 3: Poll
  console.log("");
  const result = await pollUntilDone(modelId);
  console.log("");

  // Step 4: Download
  await downloadResults(result);

  // Write metadata
  const metadata = {
    input: inputGlb,
    modelId,
    outputDir: OUTPUT_DIR,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(OUTPUT_DIR, "run-metadata.json"), JSON.stringify(metadata, null, 2));

  console.log("");
  console.log("=== Pipeline complete ===");
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
