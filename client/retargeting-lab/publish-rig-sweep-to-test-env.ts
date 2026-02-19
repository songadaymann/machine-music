/**
 * Retargeting Lab utility:
 * - Publishes rig-sweep output GLBs into public/generated-avatars/retargeting-lab.
 * - Writes a manifest consumed by test-rig.html model picker.
 *
 * Usage:
 *   bun run client/retargeting-lab/publish-rig-sweep-to-test-env.ts
 *
 * Optional env vars:
 *   RIG_SWEEP_DIR=output/retargeting-lab/rig-sweep-...
 */

import { existsSync } from "fs";
import { copyFile, link, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

interface SampleRunResult {
  sampleId: string;
  outputGlbPath: string;
  status: "ok" | "error" | "dry_run";
}

interface VariantRunSummary {
  variantId: string;
  description?: string;
  results: SampleRunResult[];
}

interface RigSweepSummary {
  generatedAt: string;
  refineBatchDir: string;
  configPath: string;
  variantCount: number;
  sampleCount: number;
  variants: VariantRunSummary[];
}

interface ManifestModel {
  id: string;
  label: string;
  variantId: string;
  sampleId: string;
  url: string;
}

interface ViewerManifest {
  generatedAt: string;
  sourceSweepDir: string;
  sourceSummaryPath: string;
  modelCount: number;
  models: ManifestModel[];
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function findLatestSweepDir(rootDir: string): Promise<string | null> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rig-sweep-"))
    .map((entry) => join(rootDir, entry.name))
    .sort()
    .reverse();
  return dirs[0] ?? null;
}

async function publishOne(srcPath: string, dstPath: string): Promise<"linked" | "copied"> {
  try {
    await link(srcPath, dstPath);
    return "linked";
  } catch {
    await copyFile(srcPath, dstPath);
    return "copied";
  }
}

async function main() {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sweepRoot = join(repoRoot, "output", "retargeting-lab");
  const requestedSweepRaw = process.env.RIG_SWEEP_DIR?.trim();
  const sweepDir = requestedSweepRaw
    ? (requestedSweepRaw.startsWith("/") ? requestedSweepRaw : resolve(repoRoot, requestedSweepRaw))
    : await findLatestSweepDir(sweepRoot);

  if (!sweepDir) {
    throw new Error(`No rig sweep directory found in ${sweepRoot}`);
  }

  const summaryPath = join(sweepDir, "rig-sweep-summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`Missing summary JSON: ${summaryPath}`);
  }

  const summaryRaw = await readFile(summaryPath, "utf8");
  const summary = JSON.parse(summaryRaw) as RigSweepSummary;
  const variants = Array.isArray(summary.variants) ? summary.variants : [];

  const publishDir = join(repoRoot, "public", "generated-avatars", "retargeting-lab");
  await rm(publishDir, { recursive: true, force: true });
  await mkdir(publishDir, { recursive: true });

  const models: ManifestModel[] = [];
  let linkedCount = 0;
  let copiedCount = 0;

  for (const variant of variants) {
    const variantId = sanitizeSegment(variant.variantId || "variant");
    const results = Array.isArray(variant.results) ? variant.results : [];
    for (const result of results) {
      if (result.status !== "ok") continue;
      if (!result.outputGlbPath || !existsSync(result.outputGlbPath)) continue;

      const sampleId = sanitizeSegment(result.sampleId || "sample");
      const modelId = `${variantId}--${sampleId}`;
      const fileName = `${modelId}.glb`;
      const targetPath = join(publishDir, fileName);
      const mode = await publishOne(result.outputGlbPath, targetPath);
      if (mode === "linked") linkedCount++;
      if (mode === "copied") copiedCount++;

      models.push({
        id: modelId,
        label: `${variantId} / ${sampleId}`,
        variantId,
        sampleId,
        url: `/generated-avatars/retargeting-lab/${fileName}`,
      });
    }
  }

  models.sort((a, b) => {
    if (a.variantId === b.variantId) return a.sampleId.localeCompare(b.sampleId);
    return a.variantId.localeCompare(b.variantId);
  });

  const manifest: ViewerManifest = {
    generatedAt: new Date().toISOString(),
    sourceSweepDir: sweepDir,
    sourceSummaryPath: summaryPath,
    modelCount: models.length,
    models,
  };

  const manifestPath = join(publishDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("=== Retargeting Lab Publish ===");
  console.log(`Sweep:        ${sweepDir}`);
  console.log(`Publish dir:  ${publishDir}`);
  console.log(`Manifest:     ${manifestPath}`);
  console.log(`Models:       ${models.length}`);
  console.log(`Hard-linked:  ${linkedCount}`);
  console.log(`Copied:       ${copiedCount}`);
  console.log(`Viewer URL:   http://localhost:5555/retargeting-lab/test-rig.html`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

