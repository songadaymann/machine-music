/**
 * Mixamo API Intercept Script
 *
 * Opens Mixamo in a real browser so you can:
 * 1. Log in with your Adobe account
 * 2. Upload a character
 * 3. Place the 7 markers (chin, wrists, elbows, knees, groin)
 * 4. Hit "Next" to trigger auto-rigging
 *
 * The script intercepts ALL requests to mixamo.com/api and logs them
 * so we can see exactly what payload the marker step sends.
 *
 * Usage:
 *   bun run client/retargeting-lab/mixamo-intercept.ts
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const OUTPUT_DIR = join(
  "output",
  "retargeting-lab",
  `mixamo-intercept-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

mkdirSync(OUTPUT_DIR, { recursive: true });

interface CapturedRequest {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: string | null;
  postDataJSON: unknown | null;
}

interface CapturedResponse {
  timestamp: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  bodyJSON: unknown | null;
}

const capturedRequests: CapturedRequest[] = [];
const capturedResponses: CapturedResponse[] = [];

async function main() {
  console.log("=== Mixamo API Intercept ===");
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log("");
  console.log("This will open a browser window. Do the following:");
  console.log("  1. Log in to Mixamo with your Adobe account");
  console.log("  2. Click 'Upload Character' and upload a GLB/FBX");
  console.log("  3. Place all 7 markers (chin, wrists, elbows, knees, groin)");
  console.log('  4. Click "Next" to start auto-rigging');
  console.log("  5. Wait for rigging to complete");
  console.log("  6. Close the browser window when done");
  console.log("");
  console.log("All API calls to mixamo.com will be captured.");
  console.log("");

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-size=1400,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  // Intercept all requests
  page.on("request", (request) => {
    const url = request.url();

    // Capture all mixamo API calls
    if (url.includes("mixamo.com")) {
      let postDataJSON: unknown | null = null;
      const postData = request.postData() ?? null;

      if (postData) {
        try {
          postDataJSON = JSON.parse(postData);
        } catch {
          // Not JSON, keep raw
        }
      }

      const entry: CapturedRequest = {
        timestamp: new Date().toISOString(),
        method: request.method(),
        url,
        headers: request.headers(),
        postData,
        postDataJSON,
      };

      capturedRequests.push(entry);

      // Log to console in real-time
      const shortUrl = url.replace("https://www.mixamo.com", "");
      console.log(`>> ${request.method()} ${shortUrl}`);
      if (postDataJSON) {
        console.log(`   Body: ${JSON.stringify(postDataJSON, null, 2).slice(0, 500)}`);
      } else if (postData && postData.length < 500) {
        console.log(`   Body: ${postData}`);
      } else if (postData) {
        console.log(`   Body: [${postData.length} bytes]`);
      }
    }
  });

  // Intercept all responses
  page.on("response", async (response) => {
    const url = response.url();

    if (url.includes("mixamo.com/api")) {
      let body: string | null = null;
      let bodyJSON: unknown | null = null;

      try {
        body = await response.text();
        bodyJSON = JSON.parse(body);
      } catch {
        // Response may not be text/JSON
      }

      const entry: CapturedResponse = {
        timestamp: new Date().toISOString(),
        url,
        status: response.status(),
        headers: response.headers(),
        body: body && body.length < 10000 ? body : body ? `[${body.length} bytes]` : null,
        bodyJSON,
      };

      capturedResponses.push(entry);

      const shortUrl = url.replace("https://www.mixamo.com", "");
      console.log(`<< ${response.status()} ${shortUrl}`);
      if (bodyJSON) {
        console.log(`   Response: ${JSON.stringify(bodyJSON, null, 2).slice(0, 500)}`);
      }
    }
  });

  // Also capture the auth token from localStorage after login
  let authToken: string | null = null;

  // Poll for auth token
  const tokenPoller = setInterval(async () => {
    try {
      authToken = await page.evaluate(() => {
        return localStorage.getItem("access_token");
      });
      if (authToken) {
        console.log("");
        console.log("=== Auth token captured! ===");
        console.log(`Token: ${authToken.slice(0, 40)}...`);
        console.log("");
        clearInterval(tokenPoller);
      }
    } catch {
      // Page might not be ready yet
    }
  }, 2000);

  await page.goto("https://www.mixamo.com/", { waitUntil: "domcontentloaded" });

  console.log("Browser open. Waiting for you to complete the flow...");
  console.log("");

  // Wait for the browser to be closed by the user
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });

  clearInterval(tokenPoller);

  // Write captured data
  console.log("");
  console.log("=== Browser closed. Writing captured data... ===");

  writeFileSync(
    join(OUTPUT_DIR, "requests.json"),
    JSON.stringify(capturedRequests, null, 2)
  );

  writeFileSync(
    join(OUTPUT_DIR, "responses.json"),
    JSON.stringify(capturedResponses, null, 2)
  );

  if (authToken) {
    writeFileSync(join(OUTPUT_DIR, "auth-token.txt"), authToken);
  }

  // Write a human-readable summary
  const summary = buildSummary();
  writeFileSync(join(OUTPUT_DIR, "summary.md"), summary);

  console.log("");
  console.log(`Captured ${capturedRequests.length} requests, ${capturedResponses.length} API responses`);
  console.log(`Written to: ${OUTPUT_DIR}/`);
  console.log("  - requests.json   (all requests to mixamo.com)");
  console.log("  - responses.json  (all API responses)");
  console.log("  - summary.md      (human-readable summary)");
  if (authToken) {
    console.log("  - auth-token.txt  (bearer token)");
  }
}

function buildSummary(): string {
  const lines: string[] = [
    "# Mixamo API Intercept Summary",
    "",
    `Captured: ${new Date().toISOString()}`,
    "",
    `Total requests to mixamo.com: ${capturedRequests.length}`,
    `Total API responses: ${capturedResponses.length}`,
    "",
    "## API Calls (chronological)",
    "",
  ];

  for (const req of capturedRequests) {
    // Only show API calls, skip static assets
    if (!req.url.includes("/api/")) continue;

    lines.push(`### ${req.method} ${req.url.replace("https://www.mixamo.com", "")}`);
    lines.push("");
    lines.push(`Time: ${req.timestamp}`);
    lines.push("");

    if (req.postDataJSON) {
      lines.push("**Request body:**");
      lines.push("```json");
      lines.push(JSON.stringify(req.postDataJSON, null, 2));
      lines.push("```");
    } else if (req.postData) {
      lines.push(`**Request body:** [${req.postData.length} bytes]`);
    }

    // Find matching response
    const resp = capturedResponses.find(
      (r) => r.url === req.url && r.timestamp >= req.timestamp
    );

    if (resp) {
      lines.push("");
      lines.push(`**Response:** ${resp.status}`);
      if (resp.bodyJSON) {
        lines.push("```json");
        lines.push(JSON.stringify(resp.bodyJSON, null, 2).slice(0, 2000));
        lines.push("```");
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
