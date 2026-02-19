/**
 * Test script: Generate a Meshy avatar through preview + refine only (no rigging).
 * Downloads the refined GLB so we can inspect textures before rigging corrupts them.
 *
 * Usage: bun run test/meshy-refine-only.ts
 */

const MESHY_BASE_URL = "https://api.meshy.ai";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180;

const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error("MESHY_API_KEY not set in environment");
  process.exit(1);
}

const PROMPT = "A friendly robot musician with headphones, cartoon style";

async function meshyRequest<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  let payload: string | undefined;
  if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${MESHY_BASE_URL}${path}`, { method, headers, body: payload });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Meshy ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function pollTask(path: string, label: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const task = await meshyRequest<Record<string, unknown>>("GET", path);
    const status = (task.status as string)?.toUpperCase();
    const progress = task.progress ?? "?";
    console.log(`  [${label}] status=${status} progress=${progress}`);

    if (status === "SUCCEEDED") return task;
    if (status === "FAILED" || status === "CANCELED") {
      console.error(`  Task ${status}:`, JSON.stringify(task.task_error ?? task, null, 2));
      throw new Error(`Task ${status}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Poll timeout");
}

async function main() {
  console.log("=== Meshy Refine-Only Test ===");
  console.log(`Prompt: "${PROMPT}"\n`);

  // Step 1: Preview
  console.log("Step 1: Creating preview task...");
  const previewRes = await meshyRequest<{ result?: string }>("POST", "/openapi/v2/text-to-3d", {
    mode: "preview",
    prompt: PROMPT,
    ai_model: "meshy-6",
    pose_mode: "t-pose",
    topology: "triangle",
    target_polycount: 10000,
    should_remesh: true,
  });
  const previewTaskId = previewRes.result;
  if (!previewTaskId) throw new Error("No preview task ID returned");
  console.log(`  Preview task ID: ${previewTaskId}`);

  console.log("  Polling preview...");
  await pollTask(`/openapi/v2/text-to-3d/${previewTaskId}`, "preview");
  console.log("  Preview complete!\n");

  // Step 2: Refine (with PBR textures)
  console.log("Step 2: Creating refine task...");
  const refineRes = await meshyRequest<{ result?: string }>("POST", "/openapi/v2/text-to-3d", {
    mode: "refine",
    preview_task_id: previewTaskId,
    enable_pbr: true,
  });
  const refineTaskId = refineRes.result;
  if (!refineTaskId) throw new Error("No refine task ID returned");
  console.log(`  Refine task ID: ${refineTaskId}`);

  console.log("  Polling refine...");
  const refineTask = await pollTask(`/openapi/v2/text-to-3d/${refineTaskId}`, "refine");
  console.log("  Refine complete!\n");

  // Log the full refine response for inspection
  console.log("=== Full Refine Task Response ===");
  console.log(JSON.stringify(refineTask, null, 2));
  console.log("");

  // Extract GLB URL
  const modelUrls = refineTask.model_urls as Record<string, unknown> | undefined;
  const glbUrl = modelUrls?.glb as string | undefined;
  if (!glbUrl) {
    console.error("No GLB URL found in refine task!");
    console.log("model_urls:", JSON.stringify(modelUrls, null, 2));
    process.exit(1);
  }
  console.log(`GLB URL: ${glbUrl}`);

  // Also log texture URLs if present
  if (refineTask.texture_urls) {
    console.log("\nTexture URLs:");
    console.log(JSON.stringify(refineTask.texture_urls, null, 2));
  }

  // Download the refined GLB
  const { mkdir, writeFile } = await import("fs/promises");
  const outputDir = new URL("../output/", import.meta.url).pathname;
  await mkdir(outputDir, { recursive: true });

  console.log("\nDownloading refined GLB...");
  const glbRes = await fetch(glbUrl);
  if (!glbRes.ok) throw new Error(`Download failed: ${glbRes.status}`);
  const bytes = await glbRes.arrayBuffer();
  const outputPath = `${outputDir}refine-only-${refineTaskId}.glb`;
  await writeFile(outputPath, Buffer.from(bytes));
  console.log(`Saved to: ${outputPath}`);

  // Also download FBX and other formats if available
  for (const [format, url] of Object.entries(modelUrls ?? {})) {
    if (format !== "glb" && typeof url === "string" && url.startsWith("http")) {
      console.log(`\nDownloading ${format}...`);
      const fRes = await fetch(url);
      if (fRes.ok) {
        const fBytes = await fRes.arrayBuffer();
        const ext = format === "usdz" ? "usdz" : format;
        const fPath = `${outputDir}refine-only-${refineTaskId}.${ext}`;
        await writeFile(fPath, Buffer.from(fBytes));
        console.log(`Saved to: ${fPath}`);
      }
    }
  }

  console.log("\n=== Done! ===");
  console.log("Open the GLB in https://gltf-viewer.donmccurdy.com/ or Blender to inspect textures.");
  console.log("Compare this against a rigged version to confirm textures are correct at this stage.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
