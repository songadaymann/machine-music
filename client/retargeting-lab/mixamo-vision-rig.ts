/**
 * Mixamo Vision-Rig Pipeline
 *
 * Automates Mixamo auto-rigging via Vision LLM + Playwright click automation.
 *
 * Strategy: REST API for upload/polling (proven working), Playwright only for
 * the marker placement step where we need visual interaction. The browser acts
 * as a coordinate transform machine — Gemini Vision identifies landmarks in
 * pixel space, Playwright clicks them on the canvas, and the browser computes
 * the viewport coordinates internally when it fires PUT /rig.
 *
 * Flow:
 * 1. GLB → FBX conversion via Blender headless
 * 2. Upload FBX to Mixamo via REST API
 * 3. Poll until upload processing completes
 * 4. Launch Playwright browser, inject auth token, navigate to Mixamo
 * 5. Set uploaded character as primary → SPA shows marker placement screen
 * 6. Screenshot the marker canvas
 * 7. Gemini Vision identifies 8 body landmark pixel coordinates
 * 8. Playwright clicks each landmark position on the canvas
 * 9. Click "Next" to submit markers → browser fires PUT /rig
 * 10. Poll for rigging completion via REST
 * 11. Download rigged FBX via REST export endpoint
 * 12. Convert rigged FBX → GLB via Blender headless
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun run client/retargeting-lab/mixamo-vision-rig.ts
 *
 * Env vars:
 *   MIXAMO_INPUT_GLB       — path to input GLB (default: latest gemini-meshy-single output)
 *   BLENDER_BIN            — Blender binary (default: /Applications/Blender.app/Contents/MacOS/Blender)
 *   MIXAMO_TOKEN           — skip interactive login
 *   MIXAMO_TOKEN_FILE      — read token from file
 *   GEMINI_API_KEY         — required for Vision LLM
 *   GEMINI_VISION_MODEL    — model for landmark detection (default: gemini-2.5-flash)
 *   MIXAMO_KEEP_BROWSER    — keep browser open after run for debugging
 *   MIXAMO_VISION_MAX_RETRIES — retry count for bad landmarks (default: 2)
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
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

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL?.trim() || "gemini-2.5-flash";
const MAX_VISION_RETRIES = parseInt(process.env.MIXAMO_VISION_MAX_RETRIES || "2", 10);

const BROWSER_VIEWPORT = { width: 1400, height: 900 };

const OUTPUT_DIR = join(
  "output",
  "retargeting-lab",
  `mixamo-vision-rig-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface LandmarkPixel {
  x: number;
  y: number;
}

interface MixamoLandmarks {
  chin: LandmarkPixel;
  larm: LandmarkPixel;
  rarm: LandmarkPixel;
  lelbow: LandmarkPixel;
  relbow: LandmarkPixel;
  lknee: LandmarkPixel;
  rknee: LandmarkPixel;
  groin: LandmarkPixel;
}

interface VisionResult {
  landmarks: MixamoLandmarks;
  rawResponse: unknown;
  confidence: string;
}

const MARKER_NAMES: (keyof MixamoLandmarks)[] = [
  "chin", "larm", "rarm", "lelbow", "relbow", "lknee", "rknee", "groin",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
// Step 2: Get auth token (env → file → cached → interactive Playwright login)
// ---------------------------------------------------------------------------
async function getAuthToken(): Promise<string> {
  if (process.env.MIXAMO_TOKEN) {
    log("auth", "Using MIXAMO_TOKEN from env");
    return process.env.MIXAMO_TOKEN;
  }

  if (process.env.MIXAMO_TOKEN_FILE && existsSync(process.env.MIXAMO_TOKEN_FILE)) {
    const token = readFileSync(process.env.MIXAMO_TOKEN_FILE, "utf-8").trim();
    if (token) {
      log("auth", `Using token from ${process.env.MIXAMO_TOKEN_FILE}`);
      return token;
    }
  }

  // Check cached token from previous intercept/pipeline runs
  const interceptGlob = new Bun.Glob(
    "output/retargeting-lab/mixamo-{intercept,pipeline,vision-rig}-*/auth-token.txt"
  );
  const tokenFiles = Array.from(interceptGlob.scanSync(".")).sort().reverse();
  if (tokenFiles.length > 0) {
    const token = readFileSync(tokenFiles[0], "utf-8").trim();
    if (token) {
      log("auth", `Using cached token from ${tokenFiles[0]}`);
      return token;
    }
  }

  // Fall back to Playwright login
  log("auth", "No cached token found. Opening browser for Adobe login...");
  log("auth", "Log in, then the browser will close automatically.");

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1200,800"],
  });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();
  await page.goto("https://www.mixamo.com/", { waitUntil: "domcontentloaded" });

  let token: string | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    try {
      token = await page.evaluate(() => localStorage.getItem("access_token"));
      if (token) break;
    } catch {
      // Page may be on Adobe's domain during login
    }
  }

  await browser.close();

  if (!token) {
    throw new Error("Failed to capture auth token. Did you complete the login?");
  }

  const tokenPath = join(OUTPUT_DIR, "auth-token.txt");
  writeFileSync(tokenPath, token);
  log("auth", `Token captured and cached at ${tokenPath}`);
  return token;
}

// ---------------------------------------------------------------------------
// Step 3: Convert GLB → FBX via Blender
// ---------------------------------------------------------------------------
async function convertGlbToFbx(inputGlb: string): Promise<string> {
  const fbxPath = join(OUTPUT_DIR, basename(inputGlb).replace(/\.glb$/i, ".fbx"));
  log("convert", `GLB → FBX: ${basename(inputGlb)} → ${basename(fbxPath)}`);

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
  log("convert", `FBX written: ${(size / 1024).toFixed(0)} KB`);
  return fbxPath;
}

// ---------------------------------------------------------------------------
// Step 4: Upload mesh to Mixamo via REST
// ---------------------------------------------------------------------------
async function uploadCharacter(token: string, fbxPath: string): Promise<string> {
  log("upload", `Uploading ${basename(fbxPath)} to Mixamo...`);

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
  log("upload", `Character UUID: ${data.uuid}, status: ${data.status}`);
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
      log(label, `Completed: ${data.message}`);
      return;
    }

    if (data.status === "failed") {
      throw new Error(`[${label}] Job failed: ${data.message}`);
    }

    process.stdout.write(".");
    await sleep(pollInterval);
  }

  throw new Error(`[${label}] Timed out after ${maxWaitMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Step 6: Launch Playwright browser with auth
// ---------------------------------------------------------------------------
async function launchMixamoBrowser(token: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  log("browser", "Launching Playwright browser...");

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1400,900"],
  });

  const context = await browser.newContext({
    viewport: BROWSER_VIEWPORT,
  });

  const page = await context.newPage();

  // Navigate to Mixamo to set localStorage on the correct origin
  await page.goto("https://www.mixamo.com/", { waitUntil: "domcontentloaded" });

  // Inject auth token
  await page.evaluate((t) => {
    localStorage.setItem("access_token", t);
  }, token);

  // Reload to activate the session
  await page.goto("https://www.mixamo.com/", { waitUntil: "networkidle" });
  log("browser", "Browser launched and authenticated");

  return { browser, context, page };
}

// ---------------------------------------------------------------------------
// Step 7: Upload via browser UI and wait for marker placement screen
// ---------------------------------------------------------------------------
async function uploadAndWaitForMarkerScreen(
  page: Page,
  fbxPath: string
): Promise<string> {
  log("upload-ui", "Clicking 'UPLOAD CHARACTER' button...");

  // Click the "UPLOAD CHARACTER" button on the right side panel
  const uploadBtn = await page.$('button:has-text("UPLOAD CHARACTER")')
    ?? await page.$('button:has-text("Upload Character")');

  if (!uploadBtn) {
    // Dump buttons for debugging
    const buttons = await page.$$eval("button", (btns) =>
      btns.map((b) => ({
        text: b.textContent?.trim().slice(0, 60),
        visible: b.offsetParent !== null,
      }))
    );
    writeFileSync(join(OUTPUT_DIR, "debug-buttons-upload.json"), JSON.stringify(buttons, null, 2));
    throw new Error("Could not find 'UPLOAD CHARACTER' button. Check debug-buttons-upload.json");
  }

  // Click "UPLOAD CHARACTER" — this opens a modal, NOT a file chooser directly
  await uploadBtn.click();
  log("upload-ui", "Waiting for upload modal to appear...");

  // Wait for the modal with "Select character file" link inside
  const selectFileLink = await page.waitForSelector(
    'text="Select character file"',
    { timeout: 10_000 }
  ).catch(() => null)
    // Fallback: try variations of the link text
    ?? await page.waitForSelector(
      'text="select character file"',
      { timeout: 3_000 }
    ).catch(() => null)
    ?? await page.waitForSelector(
      // The drop zone may contain an anchor or span with this text
      '.drop-zone a, .dropzone a, [class*="drop"] a, [class*="upload"] a',
      { timeout: 3_000 }
    ).catch(() => null);

  if (!selectFileLink) {
    // Debug: dump modal contents
    const modalText = await page.evaluate(() => {
      const modal = document.querySelector('[class*="modal"]')
        || document.querySelector('[role="dialog"]')
        || document.querySelector('[class*="overlay"]');
      return modal?.textContent?.trim().slice(0, 500) || document.body.innerText.slice(0, 1000);
    });
    writeFileSync(join(OUTPUT_DIR, "debug-modal-text.txt"), modalText);
    const modalScreenshot = await page.screenshot({ type: "png" });
    writeFileSync(join(OUTPUT_DIR, "debug-modal-screenshot.png"), modalScreenshot);
    throw new Error(
      'Could not find "Select character file" link in upload modal. Check debug-modal-text.txt and debug-modal-screenshot.png'
    );
  }

  log("upload-ui", "Found 'Select character file' link. Clicking to trigger file chooser...");

  // Set up file chooser handler BEFORE clicking the link that actually triggers it
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await selectFileLink.click();

  log("upload-ui", "Waiting for file chooser dialog...");
  const fileChooser = await fileChooserPromise;

  // Resolve to absolute path for the file chooser
  const absoluteFbxPath = join(process.cwd(), fbxPath);
  log("upload-ui", `Selecting file: ${absoluteFbxPath}`);
  await fileChooser.setFiles(absoluteFbxPath);

  log("upload-ui", "File selected. Waiting for upload + processing...");

  // Capture the character UUID from the POST /characters response
  let characterId = "";
  const charIdPromise = new Promise<string>((resolve) => {
    const handler = async (response: any) => {
      const url: string = response.url();
      if (url.includes("/api/v1/characters") && !url.includes("/") && response.request().method() === "POST") {
        try {
          const data = await response.json();
          if (data.uuid) {
            resolve(data.uuid);
            page.off("response", handler);
          }
        } catch {
          // Not JSON or no uuid
        }
      }
    };
    page.on("response", handler);
  });

  // Also intercept by watching for the character UUID in any POST /characters response
  const charIdFromIntercept = new Promise<string>((resolve) => {
    const handler = (req: any) => {
      const url: string = req.url();
      if (url.match(/\/api\/v1\/characters$/) && req.method() === "POST") {
        req.response().then(async (resp: any) => {
          if (!resp) return;
          try {
            const data = await resp.json();
            if (data.uuid) {
              resolve(data.uuid);
              page.off("request", handler);
            }
          } catch {}
        }).catch(() => {});
      }
    };
    page.on("request", handler);
  });

  // After upload + processing, the auto-rigger opens with two sequential screens:
  //   1. "Orient" screen — shows the model, asks user to confirm T-pose orientation
  //      → has BACK and NEXT buttons
  //   2. "Marker placement" screen — asks user to click body landmarks on the model
  //      → has "Place the marker on the Chin" etc.
  //
  // We need to wait for screen 1, click NEXT, then wait for screen 2.

  log("upload-ui", "Waiting for auto-rigger Orient screen (this may take 30-60s)...");

  // Take periodic screenshots while waiting
  const screenshotInterval = setInterval(async () => {
    try {
      const ss = await page.screenshot({ type: "png" });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(OUTPUT_DIR, `waiting-${ts}.png`), ss);
    } catch {
      // Page might be navigating
    }
  }, 10_000);

  try {
    // --- Screen 1: Orient ---
    // Wait for the AUTO-RIGGER dialog with "Orient" text
    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        return bodyText.includes("AUTO-RIGGER") || bodyText.includes("AUTO RIGGER") || bodyText.includes("Orient");
      },
      { timeout: 120_000 }
    );
    log("upload-ui", "Orient screen detected!");

    // Screenshot the orient screen for debugging
    const orientScreenshot = await page.screenshot({ type: "png" });
    writeFileSync(join(OUTPUT_DIR, "orient-screen.png"), orientScreenshot);

    // Give WebGL a moment to finish rendering the 3D preview
    await sleep(2000);

    // Click NEXT to advance past Orient to the marker placement screen
    const nextBtn = await page.$('button:has-text("NEXT")')
      ?? await page.$('button:has-text("Next")');

    if (!nextBtn) {
      const buttons = await page.$$eval("button", (btns) =>
        btns.map((b) => ({
          text: b.textContent?.trim().slice(0, 60),
          visible: b.offsetParent !== null,
        }))
      );
      writeFileSync(join(OUTPUT_DIR, "debug-buttons-orient.json"), JSON.stringify(buttons, null, 2));
      throw new Error("Could not find NEXT button on Orient screen. Check debug-buttons-orient.json");
    }

    log("upload-ui", "Clicking NEXT to advance to marker placement...");
    await nextBtn.click();

    // --- Screen 2: Marker placement ---
    // Wait for the marker placement UI to appear (text like "Place the marker" or "Chin")
    log("upload-ui", "Waiting for marker placement screen...");
    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        return (
          bodyText.includes("Place the marker") ||
          bodyText.includes("PLACE THE MARKER") ||
          bodyText.includes("place the marker") ||
          // Mixamo shows the current marker name (Chin is always first)
          /\bchin\b/i.test(bodyText)
        );
      },
      { timeout: 30_000 }
    );
    log("upload-ui", "Marker placement screen detected!");
  } catch (err) {
    log("upload-ui", `Error during orient/marker transition: ${err}`);

    // Fallback: just check if we have a canvas visible
    try {
      await page.waitForSelector("canvas", { timeout: 5_000 });
      log("upload-ui", "Canvas found — proceeding with best-effort marker placement");
    } catch {
      throw new Error("No marker placement screen detected after upload. Check waiting-*.png screenshots.");
    }
  } finally {
    clearInterval(screenshotInterval);
  }

  // Give WebGL time to finish rendering the marker placement view
  await sleep(3000);

  // Full-page screenshot for debugging
  const fullScreenshot = await page.screenshot({ type: "png" });
  writeFileSync(join(OUTPUT_DIR, "marker-screen-full.png"), fullScreenshot);
  log("upload-ui", "Marker screen screenshot saved");

  // Try to get the character ID we captured
  try {
    characterId = await Promise.race([
      charIdPromise,
      charIdFromIntercept,
      sleep(1000).then(() => ""),
    ]) as string;
  } catch {
    // Couldn't capture UUID, that's okay — we can still proceed with the rig
  }

  if (characterId) {
    log("upload-ui", `Captured character UUID: ${characterId}`);
  } else {
    log("upload-ui", "Could not capture character UUID from upload response (will extract from rig intercept)");
  }

  return characterId;
}

// ---------------------------------------------------------------------------
// Step 8: Screenshot the auto-rigger dialog for Vision LLM
// ---------------------------------------------------------------------------
async function screenshotForVision(
  page: Page
): Promise<{ screenshot: Buffer; width: number; height: number; offsetX: number; offsetY: number }> {
  // Crop to JUST the <canvas> element (the 3D viewport), not the full dialog.
  // The dialog includes a sidebar (labels + marker circles) on the left and
  // an instruction panel on the right. If we include those, the vision LLM's
  // arm-tip x-coordinates map to sidebar/panel zones on the actual page,
  // causing wrist/elbow markers to miss the canvas drop target.
  //
  // By cropping to canvas-only, the LLM's pixel coordinates map directly
  // to canvas-absolute positions.

  // Ensure we're on the marker placement screen (not the Orient screen).
  // Both screens have a <canvas>, but only the marker screen has .autorig-marker elements.
  // If we're stuck on Orient, click NEXT to advance.
  log("screenshot", "Waiting for .autorig-marker elements (confirms marker placement screen)...");
  let markersFound = false;
  try {
    await page.waitForSelector(".autorig-marker", { timeout: 10_000 });
    markersFound = true;
    log("screenshot", "Marker elements found — on marker placement screen");
  } catch {
    log("screenshot", "No markers yet — probably stuck on Orient screen, trying to click NEXT...");
    const debugSs = await page.screenshot({ type: "png" }) as Buffer;
    writeFileSync(join(OUTPUT_DIR, "debug-pre-next-click.png"), debugSs);

    // Try clicking NEXT to advance past Orient screen.
    // The NEXT button may be a <button>, <a>, <div>, or <span> — dump all
    // candidates and click whatever element contains "NEXT" text.
    let clicked = false;

    // Strategy 1: Playwright text selector (matches any element type)
    const textSelectors = [
      'text="NEXT"',
      'text="Next"',
      ':has-text("NEXT"):visible',
    ];
    for (const sel of textSelectors) {
      if (clicked) break;
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          log("screenshot", `Found NEXT element (${sel}) — clicking...`);
          await el.click();
          clicked = true;
        }
      } catch { /* try next */ }
    }

    // Strategy 2: DOM search — find any visible element with "NEXT" text and click its center
    if (!clicked) {
      log("screenshot", "Text selectors failed — searching DOM for NEXT element...");
      const nextPos = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node: Element | null;
        while ((node = walker.nextNode() as Element | null)) {
          const text = (node as HTMLElement).textContent?.trim();
          if (text === "NEXT" || text === "Next") {
            const rect = (node as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
        }
        return null;
      });

      if (nextPos) {
        log("screenshot", `Found NEXT at page (${nextPos.x.toFixed(0)}, ${nextPos.y.toFixed(0)}) — clicking...`);
        await page.mouse.click(nextPos.x, nextPos.y);
        clicked = true;
      }
    }

    // Debug: dump all clickable elements for diagnosis
    if (!clicked) {
      const elements = await page.evaluate(() => {
        const els = document.querySelectorAll("button, a, [role='button'], [onclick]");
        return Array.from(els).map((el) => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 60),
          class: el.className?.toString().slice(0, 80),
          visible: (el as HTMLElement).offsetParent !== null,
        }));
      });
      writeFileSync(join(OUTPUT_DIR, "debug-buttons-next.json"), JSON.stringify(elements, null, 2));
      log("screenshot", `Could not find NEXT — dumped ${elements.length} clickable elements to debug-buttons-next.json`);
    }

    if (clicked) {
      log("screenshot", "Clicked NEXT, waiting for marker placement screen...");
      await sleep(3000);
    }

    // Now wait for markers to appear after the NEXT click
    try {
      await page.waitForSelector(".autorig-marker", { timeout: 30_000 });
      markersFound = true;
      log("screenshot", "Marker elements found after NEXT click!");
    } catch {
      log("screenshot", "WARNING: Still no .autorig-marker elements — proceeding with best effort");
      const debugSs2 = await page.screenshot({ type: "png" }) as Buffer;
      writeFileSync(join(OUTPUT_DIR, "debug-no-markers.png"), debugSs2);
    }
  }

  // Save a full-page screenshot for debugging reference
  const fullScreenshot = await page.screenshot({ type: "png" }) as Buffer;
  writeFileSync(join(OUTPUT_DIR, "marker-screen-full.png"), fullScreenshot);

  // Calculate the 3D viewport region: the area between the sidebar (left)
  // and the instruction panel (right) within the dialog. We can't rely on
  // the <canvas> element because it sits behind the dialog as a background
  // and doesn't correspond to just the visible 3D area.
  //
  // Strategy:
  // 1. Find dialog bounds (walk up from .autorig-marker)
  // 2. Find sidebar right edge (from .autorig-marker positions)
  // 3. Find instruction panel left edge (from "Place markers" text)
  // 4. Crop to the 3D viewport between sidebar and panel
  const viewportBounds = await page.evaluate(() => {
    const markers = document.querySelectorAll(".autorig-marker");
    if (markers.length === 0) return null;

    // Get sidebar right edge from marker positions (rightmost marker + padding)
    let sidebarRight = 0;
    for (const m of markers) {
      const rect = (m as HTMLElement).getBoundingClientRect();
      sidebarRight = Math.max(sidebarRight, rect.right);
    }
    sidebarRight += 20; // small padding past the markers

    // Find dialog bounds by walking up from a marker
    let el: HTMLElement | null = (markers[0] as HTMLElement).parentElement;
    let dialog: { x: number; y: number; width: number; height: number; right: number; bottom: number } | null = null;
    while (el && el !== document.body) {
      const rect = el.getBoundingClientRect();
      if (
        rect.width > 400 &&
        rect.height > 300 &&
        rect.width < window.innerWidth * 0.95 &&
        rect.height < window.innerHeight * 0.95
      ) {
        if (!dialog || rect.width * rect.height < dialog.width * dialog.height) {
          dialog = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        }
      }
      el = el.parentElement as HTMLElement | null;
    }
    if (!dialog) return null;

    // Find instruction panel left edge by looking for "Place markers" heading
    let panelLeft = dialog.right; // default: no panel found, use full dialog right
    const headings = document.querySelectorAll("h2, h3, h4, strong, b, [class*='title'], [class*='header']");
    for (const h of headings) {
      const text = (h as HTMLElement).textContent?.trim() || "";
      if (/place\s*markers/i.test(text)) {
        // Walk up to find the panel container
        let panel: HTMLElement | null = h as HTMLElement;
        while (panel && panel !== document.body) {
          const pRect = panel.getBoundingClientRect();
          // The panel should be a tall container on the right side
          if (pRect.height > 200 && pRect.x > dialog.x + dialog.width * 0.4) {
            panelLeft = pRect.x;
            break;
          }
          panel = panel.parentElement;
        }
        break;
      }
    }

    return {
      x: sidebarRight,
      y: dialog.y,
      width: panelLeft - sidebarRight,
      height: dialog.height,
      dialogX: dialog.x,
      dialogWidth: dialog.width,
      sidebarRight,
      panelLeft,
    };
  });

  if (viewportBounds && viewportBounds.width > 150 && viewportBounds.height > 200) {
    log("screenshot", `3D viewport: x=${viewportBounds.x.toFixed(0)} y=${viewportBounds.y.toFixed(0)} ${viewportBounds.width.toFixed(0)}x${viewportBounds.height.toFixed(0)}`);
    log("screenshot", `  dialog=${viewportBounds.dialogX.toFixed(0)}..${(viewportBounds.dialogX + viewportBounds.dialogWidth).toFixed(0)}, sidebar→${viewportBounds.sidebarRight.toFixed(0)}, panel←${viewportBounds.panelLeft.toFixed(0)}`);

    const clip = {
      x: viewportBounds.x,
      y: viewportBounds.y,
      width: viewportBounds.width,
      height: viewportBounds.height,
    };

    const screenshot = await page.screenshot({ type: "png", clip }) as Buffer;
    writeFileSync(join(OUTPUT_DIR, "marker-screen.png"), screenshot);

    return {
      screenshot,
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      offsetX: clip.x,
      offsetY: clip.y,
    };
  }

  // Fallback: full dialog bounds
  log("screenshot", "Could not calculate viewport bounds — falling back to dialog crop");
  if (viewportBounds) {
    // We have dialog info but viewport calc failed — use full dialog
    const clip = {
      x: viewportBounds.dialogX,
      y: viewportBounds.y,
      width: viewportBounds.dialogWidth,
      height: viewportBounds.height,
    };
    const screenshot = await page.screenshot({ type: "png", clip }) as Buffer;
    writeFileSync(join(OUTPUT_DIR, "marker-screen.png"), screenshot);
    return {
      screenshot,
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      offsetX: clip.x,
      offsetY: clip.y,
    };
  }

  // Last resort: full-page screenshot
  log("screenshot", "Could not find dialog — falling back to full-page screenshot");
  const screenshot = await page.screenshot({ type: "png" }) as Buffer;
  writeFileSync(join(OUTPUT_DIR, "marker-screen.png"), screenshot);

  return {
    screenshot,
    width: BROWSER_VIEWPORT.width,
    height: BROWSER_VIEWPORT.height,
    offsetX: 0,
    offsetY: 0,
  };
}

// ---------------------------------------------------------------------------
// Step 9: Gemini Vision landmark detection
// ---------------------------------------------------------------------------
function buildLandmarkPrompt(attempt: number, imageWidth: number, imageHeight: number): string {
  const base = `You are analyzing a screenshot of a 3D character viewport. The screenshot is tightly cropped to just the 3D canvas showing a humanoid character model in a T-pose (arms extended horizontally) from a front view. The character's outstretched arms extend close to the left and right edges of the image.

The image dimensions are ${imageWidth}x${imageHeight} pixels.

Your task: identify the pixel coordinates (x, y) of exactly 8 body landmarks on this character. Coordinates are relative to the image's top-left corner (0, 0). x increases rightward, y increases downward.

The 8 landmarks are:
1. "chin" — the bottom center of the character's chin/jaw
2. "larm" — the character's LEFT wrist (appears on the RIGHT side of the image, since we view from front). At the end of the left arm.
3. "rarm" — the character's RIGHT wrist (appears on the LEFT side of the image). At the end of the right arm.
4. "lelbow" — the character's LEFT elbow (appears on the RIGHT side of the image). The bend point of the left arm.
5. "relbow" — the character's RIGHT elbow (appears on the LEFT side of the image). The bend point of the right arm.
6. "lknee" — the character's LEFT knee (appears on the RIGHT side of the image). Midpoint of the left leg.
7. "rknee" — the character's RIGHT knee (appears on the LEFT side of the image). Midpoint of the right leg.
8. "groin" — the center point where the legs meet the torso (crotch area).

CRITICAL RULES:
- "left" and "right" refer to THE CHARACTER'S body parts, which are MIRRORED from the viewer's perspective.
- Character's LEFT arm → RIGHT side of image (higher x values)
- Character's RIGHT arm → LEFT side of image (lower x values)
- Wrists should be at or near the hand/fingertip endpoints of each outstretched arm.
- Elbows should be approximately halfway between shoulder and wrist on each arm.
- Knees should be approximately halfway between groin and feet on each leg.
- Chin should be at the lower part of the head/jaw, NOT the top of the head.
- All coordinates must be positive integers within the image dimensions.

Return ONLY valid JSON with this exact structure:
{"chin":{"x":0,"y":0},"larm":{"x":0,"y":0},"rarm":{"x":0,"y":0},"lelbow":{"x":0,"y":0},"relbow":{"x":0,"y":0},"lknee":{"x":0,"y":0},"rknee":{"x":0,"y":0},"groin":{"x":0,"y":0},"confidence":"high"}`;

  if (attempt > 0) {
    return base + `\n\nThis is retry attempt ${attempt + 1}. Previous landmarks failed validation. Be extra precise about:
- Left/right mirroring (character's left = image right)
- Wrist markers at the very tips of outstretched arms
- Vertical ordering: chin above elbows above groin above knees`;
  }

  return base;
}

async function detectLandmarks(
  screenshotBuffer: Buffer,
  attempt: number,
  canvasWidth: number,
  canvasHeight: number
): Promise<VisionResult> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const base64Image = screenshotBuffer.toString("base64");
  const prompt = buildLandmarkPrompt(attempt, canvasWidth, canvasHeight);

  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(GEMINI_VISION_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: "image/png", data: base64Image } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  };

  log("vision", `Calling ${GEMINI_VISION_MODEL} (attempt ${attempt + 1})...`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const respText = await resp.text();
  let respJson: unknown;
  try {
    respJson = JSON.parse(respText);
  } catch {
    throw new Error(`Gemini returned non-JSON (${resp.status}): ${respText.slice(0, 500)}`);
  }

  if (!resp.ok) {
    throw new Error(`Gemini API failed (${resp.status}): ${respText.slice(0, 500)}`);
  }

  // Extract text content from Gemini response
  const candidates = (respJson as any)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Gemini returned no candidates");
  }

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini returned no parts");
  }

  let landmarksJson: unknown = null;
  for (const part of parts) {
    if (part.text) {
      try {
        landmarksJson = JSON.parse(part.text);
        break;
      } catch {
        // Try next part
      }
    }
  }

  if (!landmarksJson || typeof landmarksJson !== "object") {
    throw new Error(`Could not parse landmarks from Gemini response: ${JSON.stringify(parts).slice(0, 500)}`);
  }

  // Validate all 8 markers are present
  const lm = landmarksJson as Record<string, unknown>;
  const landmarks: Record<string, LandmarkPixel> = {};
  for (const name of MARKER_NAMES) {
    const pos = lm[name] as { x?: number; y?: number } | undefined;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
      throw new Error(`Missing or invalid landmark "${name}" in Gemini response`);
    }
    landmarks[name] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }

  const confidence = typeof lm.confidence === "string" ? lm.confidence : "unknown";

  return {
    landmarks: landmarks as unknown as MixamoLandmarks,
    rawResponse: respJson,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Step 10: Validate landmarks (geometric sanity checks)
// ---------------------------------------------------------------------------
function validateLandmarks(
  lm: MixamoLandmarks,
  width: number,
  height: number
): string[] {
  const errors: string[] = [];

  // Bounds check
  for (const name of MARKER_NAMES) {
    const pos = lm[name];
    if (pos.x < 0 || pos.x >= width) errors.push(`${name}.x=${pos.x} out of bounds [0,${width})`);
    if (pos.y < 0 || pos.y >= height) errors.push(`${name}.y=${pos.y} out of bounds [0,${height})`);
  }

  // Vertical ordering (y increases downward)
  if (lm.chin.y >= lm.groin.y) errors.push("chin should be above groin");
  if (lm.groin.y >= lm.lknee.y) errors.push("groin should be above left knee");
  if (lm.groin.y >= lm.rknee.y) errors.push("groin should be above right knee");

  // Arms should be roughly at the same height
  const armYDiff = Math.abs(lm.larm.y - lm.rarm.y);
  if (armYDiff > height * 0.15) errors.push(`arm y-positions differ by ${armYDiff}px (>15% of height)`);

  // Character's left arm (larm) should be on the RIGHT side of the image (higher x)
  if (lm.larm.x < lm.chin.x) errors.push("larm should be right of chin (character's left = image right)");
  if (lm.rarm.x > lm.chin.x) errors.push("rarm should be left of chin (character's right = image left)");

  // Elbow ordering along x-axis
  if (lm.larm.x < lm.lelbow.x) errors.push("larm should be further right than lelbow");
  if (lm.rarm.x > lm.relbow.x) errors.push("rarm should be further left than relbow");

  // Knee symmetry
  const lkneeDist = Math.abs(lm.lknee.x - lm.groin.x);
  const rkneeDist = Math.abs(lm.rknee.x - lm.groin.x);
  if (lkneeDist + rkneeDist > 0 && Math.abs(lkneeDist - rkneeDist) > width * 0.15) {
    errors.push(`knee positions asymmetric: left=${lkneeDist}px, right=${rkneeDist}px from groin`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Step 11: Find sidebar marker circles
// ---------------------------------------------------------------------------
interface MarkerCircle {
  pageX: number;
  pageY: number;
  label: string;
}

async function findMarkerCircles(
  page: Page
): Promise<Record<keyof MixamoLandmarks, MarkerCircle>> {
  log("circles", "Finding sidebar marker circles via .autorig-marker class...");

  // Query elements with class "autorig-marker" directly — much more reliable
  // than scanning for generic circular elements
  const markerInfo = await page.evaluate(() => {
    const markers = document.querySelectorAll(".autorig-marker");
    return Array.from(markers).map((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        h: rect.height,
        border: style.borderColor,
      };
    });
  });

  writeFileSync(
    join(OUTPUT_DIR, "debug-circles.json"),
    JSON.stringify(markerInfo, null, 2)
  );
  log("circles", `Found ${markerInfo.length} .autorig-marker elements`);

  if (markerInfo.length < 8) {
    throw new Error(
      `Expected 8 .autorig-marker elements but found ${markerInfo.length}. Check debug-circles.json`
    );
  }

  // Identify markers by border color (each body part group has a unique color)
  // Known Mixamo marker colors:
  //   Chin:    rgb(9, 215, 213)   — cyan
  //   Wrists:  rgb(174, 217, 90)  — green
  //   Elbows:  rgb(238, 219, 114) — yellow
  //   Knees:   rgb(240, 159, 80)  — orange
  //   Groin:   rgb(249, 124, 153) — pink
  const colorMap: Record<string, keyof MixamoLandmarks | "wrist" | "elbow" | "knee"> = {
    "rgb(9, 215, 213)": "chin",
    "rgb(174, 217, 90)": "wrist" as any,
    "rgb(238, 219, 114)": "elbow" as any,
    "rgb(240, 159, 80)": "knee" as any,
    "rgb(249, 124, 153)": "groin",
  };

  // Group markers by their body part color
  const groups: Record<string, typeof markerInfo> = {};
  for (const m of markerInfo) {
    const part = colorMap[m.border];
    if (!part) {
      log("circles", `  Unknown marker color: ${m.border} at (${m.x.toFixed(0)}, ${m.y.toFixed(0)})`);
      continue;
    }
    if (!groups[part]) groups[part] = [];
    groups[part].push(m);
  }

  log("circles", `Color groups: ${Object.entries(groups).map(([k, v]) => `${k}(${v.length})`).join(", ")}`);

  const result: Record<string, MarkerCircle> = {};

  // CHIN — single marker
  const chinGroup = groups["chin"];
  if (!chinGroup || chinGroup.length < 1) throw new Error("No chin marker found");
  result.chin = { pageX: chinGroup[0]!.x, pageY: chinGroup[0]!.y, label: "CHIN" };

  // WRISTS — 2 markers, sort by x: lower x = character's right (rarm), higher x = character's left (larm)
  const wristGroup = groups["wrist"];
  if (!wristGroup || wristGroup.length < 2) throw new Error(`Expected 2 wrist markers, found ${wristGroup?.length || 0}`);
  wristGroup.sort((a, b) => a.x - b.x);
  result.rarm = { pageX: wristGroup[0]!.x, pageY: wristGroup[0]!.y, label: "WRIST-R" };
  result.larm = { pageX: wristGroup[1]!.x, pageY: wristGroup[1]!.y, label: "WRIST-L" };

  // ELBOWS — 2 markers
  const elbowGroup = groups["elbow"];
  if (!elbowGroup || elbowGroup.length < 2) throw new Error(`Expected 2 elbow markers, found ${elbowGroup?.length || 0}`);
  elbowGroup.sort((a, b) => a.x - b.x);
  result.relbow = { pageX: elbowGroup[0]!.x, pageY: elbowGroup[0]!.y, label: "ELBOW-R" };
  result.lelbow = { pageX: elbowGroup[1]!.x, pageY: elbowGroup[1]!.y, label: "ELBOW-L" };

  // KNEES — 2 markers
  const kneeGroup = groups["knee"];
  if (!kneeGroup || kneeGroup.length < 2) throw new Error(`Expected 2 knee markers, found ${kneeGroup?.length || 0}`);
  kneeGroup.sort((a, b) => a.x - b.x);
  result.rknee = { pageX: kneeGroup[0]!.x, pageY: kneeGroup[0]!.y, label: "KNEE-R" };
  result.lknee = { pageX: kneeGroup[1]!.x, pageY: kneeGroup[1]!.y, label: "KNEE-L" };

  // GROIN — single marker
  const groinGroup = groups["groin"];
  if (!groinGroup || groinGroup.length < 1) throw new Error("No groin marker found");
  result.groin = { pageX: groinGroup[0]!.x, pageY: groinGroup[0]!.y, label: "GROIN" };

  log("circles", "Marker circle mapping:");
  for (const name of MARKER_NAMES) {
    const c = result[name]!;
    log("circles", `  ${name} (${c.label}): page(${c.pageX.toFixed(0)}, ${c.pageY.toFixed(0)})`);
  }

  return result as Record<keyof MixamoLandmarks, MarkerCircle>;
}

// ---------------------------------------------------------------------------
// Step 12: Drag markers from sidebar to body landmarks on canvas
// ---------------------------------------------------------------------------
async function placeMarkers(
  page: Page,
  landmarks: MixamoLandmarks,
  offsetX: number,
  offsetY: number
): Promise<void> {
  log("drag", "Placing markers via drag-and-drop...");
  log("drag", `Canvas offset: (${offsetX.toFixed(0)}, ${offsetY.toFixed(0)})`);

  // Find the sidebar marker circles
  const circles = await findMarkerCircles(page);

  for (const name of MARKER_NAMES) {
    const src = circles[name];
    const dest = landmarks[name];

    // Vision LLM coordinates are relative to the canvas clip — add offset to get page-absolute
    const destPageX = dest.x + offsetX;
    const destPageY = dest.y + offsetY;

    log(
      "drag",
      `${name}: circle(${src.pageX.toFixed(0)}, ${src.pageY.toFixed(0)}) → body(${destPageX.toFixed(0)}, ${destPageY.toFixed(0)})`
    );

    // Perform drag: move to source → press → move to destination → release
    await page.mouse.move(src.pageX, src.pageY);
    await sleep(200);
    await page.mouse.down();
    await sleep(100);
    // Move in multiple steps for a smooth drag that the UI recognizes
    await page.mouse.move(destPageX, destPageY, { steps: 20 });
    await sleep(200);
    await page.mouse.up();

    // Wait for UI to register the marker placement
    await sleep(1500);

    // Debug screenshot after each marker drag
    const ss = await page.screenshot({ type: "png" });
    writeFileSync(join(OUTPUT_DIR, `after-drag-${name}.png`), ss);
    log("drag", `  → screenshot saved: after-drag-${name}.png`);
  }

  log("drag", "All 8 markers placed");

  // Take post-markers screenshot
  const postScreenshot = await page.screenshot({ type: "png" });
  writeFileSync(join(OUTPUT_DIR, "post-markers.png"), postScreenshot);
}

// ---------------------------------------------------------------------------
// Step 12: Submit rig via "Next" button
// ---------------------------------------------------------------------------
async function submitRig(page: Page): Promise<void> {
  log("rig", "Looking for submit/Next button...");

  // Try several selector strategies for the "Next" button
  const selectors = [
    'button:has-text("NEXT")',
    'button:has-text("Next")',
    'button:has-text("next")',
    '[class*="next" i]',
    'button[class*="primary"]',
  ];

  for (const selector of selectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        const visible = await btn.isVisible();
        if (visible) {
          log("rig", `Found button with selector: ${selector}`);
          await btn.click();
          log("rig", "Clicked submit button");
          return;
        }
      }
    } catch {
      // Selector may be invalid for this page, try next
    }
  }

  // Fallback: dump visible buttons for debugging
  const buttons = await page.$$eval("button", (btns) =>
    btns.map((b) => ({
      text: b.textContent?.trim().slice(0, 50),
      class: b.className.slice(0, 80),
      visible: b.offsetParent !== null,
    }))
  );
  writeFileSync(join(OUTPUT_DIR, "debug-buttons.json"), JSON.stringify(buttons, null, 2));
  log("rig", `Could not find Next button. Dumped ${buttons.length} buttons to debug-buttons.json`);

  throw new Error(
    "Could not find the submit/Next button. Check debug-buttons.json and post-markers.png"
  );
}

// ---------------------------------------------------------------------------
// Step 13: Download rigged FBX
// ---------------------------------------------------------------------------
async function downloadRiggedFbx(
  token: string,
  characterId: string
): Promise<string | null> {
  // Check character status
  const charResp = await fetch(`${MIXAMO_API}/characters/${characterId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Api-Key": MIXAMO_API_KEY,
    },
  });
  const charData = (await charResp.json()) as { status: string; name: string };
  log("download", `Character "${charData.name}" status: ${charData.status}`);

  if (charData.status !== "ready") {
    log("download", `Character not ready (${charData.status}), skipping download`);
    return null;
  }

  // Save the skeleton for reference
  const skelResp = await fetch(
    `${MIXAMO_API}/characters/${characterId}/assets/rigged/skeleton.json`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-Key": MIXAMO_API_KEY,
      },
    }
  );
  if (skelResp.ok) {
    const skeleton = await skelResp.json();
    writeFileSync(join(OUTPUT_DIR, "rigged-skeleton.json"), JSON.stringify(skeleton, null, 2));
    log("download", "Skeleton saved");
  }

  // Request FBX export
  log("download", "Requesting FBX export...");
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

  const exportData = (await exportResp.json()) as Record<string, unknown>;
  writeFileSync(join(OUTPUT_DIR, "export-response.json"), JSON.stringify(exportData, null, 2));
  log("download", `Export response: ${JSON.stringify(exportData).slice(0, 200)}`);

  // The export endpoint may return a job to poll or a direct URL
  if (exportResp.ok || exportResp.status === 202) {
    const jobId = (exportData.uuid as string) || characterId;

    // Poll for export completion
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const monResp = await fetch(`${MIXAMO_API}/characters/${jobId}/monitor`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Api-Key": MIXAMO_API_KEY,
        },
      });

      const monData = (await monResp.json()) as {
        status: string;
        job_result: string;
        message: string;
      };

      if (monData.status === "completed") {
        log("download", "Export job completed");

        // job_result might contain a download URL
        if (monData.job_result && monData.job_result.startsWith("http")) {
          log("download", "Downloading FBX from job_result URL...");
          const dlResp = await fetch(monData.job_result);
          if (dlResp.ok) {
            const fbxData = new Uint8Array(await dlResp.arrayBuffer());
            const fbxPath = join(OUTPUT_DIR, "rigged.fbx");
            writeFileSync(fbxPath, fbxData);
            log("download", `Rigged FBX saved: ${(fbxData.length / 1024).toFixed(0)} KB`);
            return fbxPath;
          }
        }

        writeFileSync(join(OUTPUT_DIR, "export-monitor-final.json"), JSON.stringify(monData, null, 2));
        break;
      }

      if (monData.status === "failed") {
        log("download", `Export failed: ${monData.message}`);
        break;
      }

      process.stdout.write(".");
      await sleep(3000);
    }
  }

  log("download", "FBX export via REST did not produce a download. Skeleton JSON saved.");
  return null;
}

// ---------------------------------------------------------------------------
// Step 14: Convert rigged FBX → GLB
// ---------------------------------------------------------------------------
async function convertFbxToGlb(fbxPath: string): Promise<string> {
  const glbPath = join(OUTPUT_DIR, "rigged.glb");
  log("convert", `FBX → GLB: ${basename(fbxPath)} → rigged.glb`);

  const script = `
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=sys.argv[-2])
bpy.ops.export_scene.gltf(
    filepath=sys.argv[-1],
    export_format='GLB',
    use_selection=False,
)
print("[convert] GLB export complete")
`;

  const scriptPath = join(OUTPUT_DIR, "_fbx2glb.py");
  writeFileSync(scriptPath, script);

  const result = await $`${BLENDER_BIN} --background --python ${scriptPath} -- ${fbxPath} ${glbPath} 2>&1`.text();

  if (!existsSync(glbPath)) {
    console.error("[convert] Blender output:", result);
    throw new Error("FBX→GLB conversion failed");
  }

  const size = readFileSync(glbPath).length;
  log("convert", `GLB written: ${(size / 1024).toFixed(0)} KB`);
  return glbPath;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Mixamo Vision-Rig Pipeline ===");
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log("");

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set. Run: set -a; source .env; set +a");
  }

  // Step 1: Find input
  const inputGlb = findInputGlb();
  log("input", inputGlb);

  // Step 2: Auth
  const token = await getAuthToken();
  log("auth", `Token: ${token.slice(0, 30)}...`);

  // Step 3: GLB → FBX
  const fbxPath = await convertGlbToFbx(inputGlb);

  // Step 4: Launch browser
  const { browser, page } = await launchMixamoBrowser(token);

  // Set up request interception to capture the PUT /rig payload and character UUID
  let rigPayload: unknown = null;
  let characterId = "";

  page.on("request", (req) => {
    if (req.url().includes("/rig") && req.method() === "PUT") {
      const postData = req.postData();
      if (postData) {
        try {
          rigPayload = JSON.parse(postData);
          log("intercept", "Captured PUT /rig payload");
        } catch {
          rigPayload = postData;
        }
      }
      // Extract character UUID from the URL: /characters/{uuid}/rig
      const match = req.url().match(/\/characters\/([^/]+)\/rig/);
      if (match && !characterId) {
        characterId = match[1];
        log("intercept", `Captured character UUID from rig URL: ${characterId}`);
      }
    }
  });

  let visionAttempts = 0;

  try {
    // Step 5: Upload via browser UI and wait for marker screen
    const uploadCharId = await uploadAndWaitForMarkerScreen(page, fbxPath);
    if (uploadCharId) characterId = uploadCharId;

    // Step 8: Screenshot dialog area for Vision LLM
    const { screenshot, width: pageWidth, height: pageHeight, offsetX, offsetY } = await screenshotForVision(page);

    // Step 9: Vision LLM landmark detection with retry
    let landmarks: MixamoLandmarks | null = null;

    for (let attempt = 0; attempt <= MAX_VISION_RETRIES; attempt++) {
      visionAttempts = attempt + 1;

      const result = await detectLandmarks(
        screenshot,
        attempt,
        pageWidth,
        pageHeight
      );

      writeFileSync(
        join(OUTPUT_DIR, `vision-response-${attempt}.json`),
        JSON.stringify(result.rawResponse, null, 2)
      );
      writeFileSync(
        join(OUTPUT_DIR, `landmarks-${attempt}.json`),
        JSON.stringify(result.landmarks, null, 2)
      );

      log("vision", `Confidence: ${result.confidence}`);

      const errors = validateLandmarks(
        result.landmarks,
        pageWidth,
        pageHeight
      );

      if (errors.length === 0) {
        log("vision", "Landmarks validated successfully");
        landmarks = result.landmarks;
        break;
      }

      log("vision", `Validation errors: ${errors.join("; ")}`);
      if (attempt < MAX_VISION_RETRIES) {
        log("vision", "Retrying with adjusted prompt...");
      }
    }

    if (!landmarks) {
      throw new Error("Vision LLM failed to produce valid landmarks after all retries");
    }

    // Step 10: Place markers (Vision LLM coords are dialog-relative, add offsets for page-absolute)
    await placeMarkers(page, landmarks, offsetX, offsetY);

    // Step 11: Submit rig
    await submitRig(page);

    // Save intercepted rig payload
    if (rigPayload) {
      writeFileSync(
        join(OUTPUT_DIR, "intercepted-rig-payload.json"),
        JSON.stringify(rigPayload, null, 2)
      );
      log("intercept", "Rig payload saved to intercepted-rig-payload.json");
    }

    // Wait for the rig job to be queued
    await sleep(2000);

  } finally {
    if (!process.env.MIXAMO_KEEP_BROWSER) {
      await browser.close();
      log("browser", "Browser closed");
    } else {
      log("browser", "Keeping browser open (MIXAMO_KEEP_BROWSER is set)");
    }
  }

  // Step 12: Poll rigging completion via REST (if we have a character ID)
  if (characterId) {
    log("rig", `Polling for rigging completion (character: ${characterId})...`);
    await pollUntilComplete(token, characterId, "rig", 180_000);
    console.log("");
  } else {
    log("rig", "No character UUID captured — cannot poll via REST. Waiting 30s for rigging...");
    await sleep(30_000);
  }

  // Step 13: Download rigged FBX
  const riggedFbxPath = characterId
    ? await downloadRiggedFbx(token, characterId)
    : null;

  // Step 14: Convert to GLB
  let riggedGlbPath: string | null = null;
  if (riggedFbxPath && existsSync(riggedFbxPath)) {
    riggedGlbPath = await convertFbxToGlb(riggedFbxPath);
  }

  // Write run metadata
  const metadata = {
    input: inputGlb,
    characterId,
    outputDir: OUTPUT_DIR,
    timestamp: new Date().toISOString(),
    visionModel: GEMINI_VISION_MODEL,
    visionAttempts,
    rigPayloadCaptured: rigPayload !== null,
    riggedFbxPath,
    riggedGlbPath,
  };
  writeFileSync(join(OUTPUT_DIR, "run-metadata.json"), JSON.stringify(metadata, null, 2));

  console.log("");
  console.log("=== Pipeline complete ===");
  console.log(`Character ID: ${characterId}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  if (riggedGlbPath) {
    console.log(`Rigged GLB: ${riggedGlbPath}`);
  }
  if (rigPayload) {
    console.log("PUT /rig payload captured — check intercepted-rig-payload.json");
  }
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
