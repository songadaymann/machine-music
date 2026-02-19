/**
 * Retargeting Lab utility:
 * - Runs config-driven autorig variants on refine-only Meshy outputs.
 * - Evaluates rig structure and Mixamo clip target-name coverage.
 * - Produces a markdown + JSON report for variable comparison.
 *
 * Usage:
 *   set -a; source .env
 *   bun run client/retargeting-lab/run-rig-sweep.ts
 *
 * Optional env vars:
 *   MESHY_REFINEMENT_BATCH_DIR=output/retargeting-lab/meshy-refine-batch-...
 *   RIG_SWEEP_CONFIG=client/retargeting-lab/rig-sweep.config.json
 *   BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender
 *   RIG_SWEEP_DRY_RUN=1
 *   RIG_SWEEP_LIMIT_VARIANTS=2
 *   RIG_SWEEP_LIMIT_SAMPLES=3
 */

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

interface SweepVariant {
  id: string;
  description?: string;
  autorigConfig: Record<string, unknown>;
}

interface RigSweepConfig {
  schemaVersion?: string;
  description?: string;
  requiredBonesCore?: string[];
  animationClips?: string[];
  variants: SweepVariant[];
}

interface SampleInput {
  id: string;
  refineGlbPath: string;
}

interface GlbRigAnalysis {
  nodeNames: string[];
  skinJointNames: string[];
  skins: number;
  animations: number;
  nonUniformScaleNodes: number;
  negativeScaleNodes: number;
}

interface ClipCoverage {
  clip: string;
  targetCount: number;
  matchedCount: number;
  coverage: number | null;
}

interface SampleRunResult {
  sampleId: string;
  inputGlbPath: string;
  outputGlbPath: string;
  status: "ok" | "error" | "dry_run";
  error?: string;
  durationMs: number;
  hasSkin: boolean;
  skinJointCount: number;
  requiredCoreCoverage: number | null;
  missingRequiredCore: string[];
  clipCoverage: ClipCoverage[];
  nonUniformScaleNodes: number;
  negativeScaleNodes: number;
}

interface VariantRunSummary {
  variantId: string;
  description?: string;
  configPath: string;
  outputDir: string;
  results: SampleRunResult[];
  okCount: number;
  totalCount: number;
  avgRequiredCoreCoverage: number | null;
  avgIdleCoverage: number | null;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLimit(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function findLatestRefineBatchDir(rootDir: string): Promise<string | null> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("meshy-refine-batch-"))
    .map((e) => join(rootDir, e.name))
    .sort()
    .reverse();
  return dirs[0] ?? null;
}

async function discoverSamples(batchDir: string): Promise<SampleInput[]> {
  const entries = await readdir(batchDir, { withFileTypes: true });
  const samples: SampleInput[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sampleDir = join(batchDir, entry.name);
    const files = await readdir(sampleDir, { withFileTypes: true });
    const refineFile = files.find((f) => f.isFile() && f.name.endsWith("-refine.glb"));
    if (!refineFile) continue;
    samples.push({
      id: entry.name,
      refineGlbPath: join(sampleDir, refineFile.name),
    });
  }

  return samples.sort((a, b) => a.id.localeCompare(b.id));
}

function parseGlb(path: string): Record<string, unknown> {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error(`Invalid GLB file: ${path}`);
  }

  let offset = 12;
  let gltfJson: Record<string, unknown> | null = null;
  const decoder = new TextDecoder("utf-8");

  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) break;

    if (chunkType == 0x4e4f534a) {
      const jsonText = decoder.decode(bytes.subarray(chunkStart, chunkEnd));
      gltfJson = JSON.parse(jsonText) as Record<string, unknown>;
      break;
    }
    offset = chunkEnd;
  }

  if (!gltfJson) throw new Error(`No JSON chunk found in GLB: ${path}`);
  return gltfJson;
}

function analyzeRigGlb(path: string): GlbRigAnalysis {
  const gltf = parseGlb(path);
  const nodes = Array.isArray(gltf.nodes) ? (gltf.nodes as Record<string, unknown>[]) : [];
  const skins = Array.isArray(gltf.skins) ? (gltf.skins as Record<string, unknown>[]) : [];
  const animations = Array.isArray(gltf.animations) ? (gltf.animations as Record<string, unknown>[]) : [];

  const nodeNames = nodes
    .map((n) => (typeof n.name === "string" ? n.name : null))
    .filter((n): n is string => !!n);

  const skinJointNamesSet = new Set<string>();
  for (const skin of skins) {
    const joints = Array.isArray(skin.joints) ? skin.joints : [];
    for (const jointIndex of joints) {
      if (typeof jointIndex !== "number") continue;
      const node = nodes[jointIndex];
      const name = node && typeof node.name === "string" ? node.name : null;
      if (name) skinJointNamesSet.add(name);
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
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) continue;
    if (Math.abs(sx - sy) > 1e-5 || Math.abs(sy - sz) > 1e-5) nonUniformScaleNodes++;
    if (sx < 0 || sy < 0 || sz < 0) negativeScaleNodes++;
  }

  return {
    nodeNames,
    skinJointNames: [...skinJointNamesSet].sort(),
    skins: skins.length,
    animations: animations.length,
    nonUniformScaleNodes,
    negativeScaleNodes,
  };
}

function extractClipTargetNames(path: string): Set<string> {
  const gltf = parseGlb(path);
  const nodes = Array.isArray(gltf.nodes) ? (gltf.nodes as Record<string, unknown>[]) : [];
  const animations = Array.isArray(gltf.animations) ? (gltf.animations as Record<string, unknown>[]) : [];
  const names = new Set<string>();

  for (const anim of animations) {
    const channels = Array.isArray(anim.channels) ? (anim.channels as Record<string, unknown>[]) : [];
    for (const channel of channels) {
      const target = isRecord(channel.target) ? channel.target : null;
      if (!target) continue;
      const nodeIndex = target.node;
      if (typeof nodeIndex !== "number") continue;
      const node = nodes[nodeIndex];
      const nodeName = node && typeof node.name === "string" ? node.name : null;
      if (nodeName) names.add(nodeName);
    }
  }

  return names;
}

function coverageRatio(expectedNames: Set<string>, availableNames: Set<string>): { matched: number; total: number; ratio: number | null } {
  const total = expectedNames.size;
  if (total === 0) return { matched: 0, total: 0, ratio: null };
  let matched = 0;
  for (const name of expectedNames) {
    if (availableNames.has(name)) matched++;
  }
  return { matched, total, ratio: matched / total };
}

function resolveBlenderBin(repoRoot: string): string {
  const candidates = [
    process.env.BLENDER_BIN?.trim(),
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "blender",
  ].filter((v): v is string => !!v && v.length > 0);

  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { cwd: repoRoot, encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Could not find a working Blender binary. Set BLENDER_BIN and retry.");
}

function runProcess(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

function pct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function avg(values: Array<number | null>): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

function buildReportMarkdown(
  sweepDir: string,
  refineBatchDir: string,
  configPath: string,
  blenderBin: string,
  variants: VariantRunSummary[]
): string {
  const lines: string[] = [];
  lines.push("# Rig Sweep Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Sweep dir: ${sweepDir}`);
  lines.push(`Refine batch: ${refineBatchDir}`);
  lines.push(`Config: ${configPath}`);
  lines.push(`Blender: ${blenderBin}`);
  lines.push("");

  lines.push("## Variant Summary");
  lines.push("");
  lines.push("| variant | ok / total | avg required core | avg idle target coverage |");
  lines.push("|---|---:|---:|---:|");
  for (const variant of variants) {
    lines.push(
      `| ${variant.variantId} | ${variant.okCount}/${variant.totalCount} | ${pct(variant.avgRequiredCoreCoverage)} | ${pct(variant.avgIdleCoverage)} |`
    );
  }
  lines.push("");

  for (const variant of variants) {
    lines.push(`## ${variant.variantId}`);
    if (variant.description) lines.push(`- ${variant.description}`);
    lines.push(`- config: \`${variant.configPath}\``);
    lines.push("");
    lines.push("| sample | status | has skin | skin joints | required core | idle coverage | non-uniform scale | negative scale |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
    for (const result of variant.results) {
      const idle = result.clipCoverage.find((c) => c.clip === "idle");
      lines.push(
        `| ${result.sampleId} | ${result.status} | ${result.hasSkin ? "yes" : "no"} | ${result.skinJointCount} | ${pct(result.requiredCoreCoverage)} | ${pct(idle?.coverage ?? null)} | ${result.nonUniformScaleNodes} | ${result.negativeScaleNodes} |`
      );
    }
    lines.push("");

    const failures = variant.results.filter((r) => r.status !== "ok");
    if (failures.length > 0) {
      lines.push("Failures:");
      for (const f of failures) {
        lines.push(`- ${f.sampleId}: ${f.error ?? "unknown error"}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dryRun = process.env.RIG_SWEEP_DRY_RUN === "1";

  const requestedBatch = process.env.MESHY_REFINEMENT_BATCH_DIR?.trim();
  const refineRoot = join(repoRoot, "output", "retargeting-lab");
  const refineBatchDir = requestedBatch
    ? requestedBatch.startsWith("/")
      ? requestedBatch
      : resolve(repoRoot, requestedBatch)
    : await findLatestRefineBatchDir(refineRoot);
  if (!refineBatchDir) {
    throw new Error("No refine batch directory found. Run generate-meshy-refine-batch.ts first.");
  }

  const configPathRaw = process.env.RIG_SWEEP_CONFIG?.trim() || "client/retargeting-lab/rig-sweep.config.json";
  const configPath = configPathRaw.startsWith("/") ? configPathRaw : resolve(repoRoot, configPathRaw);
  const config = JSON.parse(await readFile(configPath, "utf8")) as RigSweepConfig;
  if (!Array.isArray(config.variants) || config.variants.length === 0) {
    throw new Error("No variants defined in rig sweep config.");
  }

  const samplesAll = await discoverSamples(refineBatchDir);
  if (samplesAll.length === 0) {
    throw new Error(`No refine sample GLBs found in ${refineBatchDir}`);
  }

  const limitVariants = parseLimit("RIG_SWEEP_LIMIT_VARIANTS");
  const limitSamples = parseLimit("RIG_SWEEP_LIMIT_SAMPLES");
  const variants = (limitVariants ? config.variants.slice(0, limitVariants) : config.variants).map((v) => ({
    id: sanitizeSegment(v.id),
    description: v.description,
    autorigConfig: isRecord(v.autorigConfig) ? v.autorigConfig : {},
  }));
  const samples = limitSamples ? samplesAll.slice(0, limitSamples) : samplesAll;

  const sweepDir = join(refineRoot, `rig-sweep-${nowStamp()}`);
  await mkdir(sweepDir, { recursive: true });

  const blenderBin = dryRun ? "dry-run" : resolveBlenderBin(repoRoot);
  console.log("=== Rig Sweep (Retargeting Lab) ===");
  console.log(`Refine batch: ${refineBatchDir}`);
  console.log(`Config:       ${configPath}`);
  console.log(`Output:       ${sweepDir}`);
  console.log(`Dry run:      ${dryRun ? "yes" : "no"}`);
  console.log(`Blender:      ${blenderBin}`);
  console.log(`Variants:     ${variants.length}`);
  console.log(`Samples:      ${samples.length}`);

  const requiredCore = config.requiredBonesCore ?? [];
  const requiredCoreSet = new Set(requiredCore);
  const clipNames = (config.animationClips ?? ["idle.glb", "walk.glb"]).map((n) => n.replace(/\.glb$/i, ""));
  const clipTargets = new Map<string, Set<string>>();
  for (const clipName of clipNames) {
    const clipPath = join(repoRoot, "public", "animations", `${clipName}.glb`);
    if (!(await pathExists(clipPath))) {
      console.warn(`clip not found, skipping coverage: ${clipPath}`);
      continue;
    }
    clipTargets.set(clipName, extractClipTargetNames(clipPath));
  }

  const variantSummaries: VariantRunSummary[] = [];

  for (const variant of variants) {
    const variantDir = join(sweepDir, "variants", variant.id);
    await mkdir(variantDir, { recursive: true });
    const variantConfigPath = join(variantDir, "autorig-config.json");
    await writeFile(variantConfigPath, JSON.stringify(variant.autorigConfig, null, 2));

    console.log(`\n[variant] ${variant.id}`);
    const results: SampleRunResult[] = [];
    for (const sample of samples) {
      const sampleDir = join(variantDir, sample.id);
      await mkdir(sampleDir, { recursive: true });
      const outputGlbPath = join(sampleDir, `${sample.id}-rigged.glb`);
      const logPath = join(sampleDir, "blender.log");
      console.log(`  - sample: ${sample.id}`);

      if (dryRun) {
        results.push({
          sampleId: sample.id,
          inputGlbPath: sample.refineGlbPath,
          outputGlbPath,
          status: "dry_run",
          durationMs: 0,
          hasSkin: false,
          skinJointCount: 0,
          requiredCoreCoverage: null,
          missingRequiredCore: [...requiredCore],
          clipCoverage: [],
          nonUniformScaleNodes: 0,
          negativeScaleNodes: 0,
        });
        continue;
      }

      const autorigScript = join(repoRoot, "scripts", "blender-autorig.py");
      const args = ["--background", "--python", autorigScript, "--", sample.refineGlbPath, outputGlbPath, variantConfigPath];
      const proc = await runProcess(blenderBin, args, repoRoot);
      const logText = [
        `cmd: ${blenderBin} ${args.join(" ")}`,
        `exit: ${proc.code}`,
        `duration_ms: ${proc.durationMs}`,
        "",
        "----- stdout -----",
        proc.stdout,
        "",
        "----- stderr -----",
        proc.stderr,
      ].join("\n");
      await writeFile(logPath, logText);

      if (proc.code !== 0) {
        results.push({
          sampleId: sample.id,
          inputGlbPath: sample.refineGlbPath,
          outputGlbPath,
          status: "error",
          error: `blender_exit_${proc.code}`,
          durationMs: proc.durationMs,
          hasSkin: false,
          skinJointCount: 0,
          requiredCoreCoverage: null,
          missingRequiredCore: [...requiredCore],
          clipCoverage: [],
          nonUniformScaleNodes: 0,
          negativeScaleNodes: 0,
        });
        continue;
      }

      if (!(await pathExists(outputGlbPath))) {
        results.push({
          sampleId: sample.id,
          inputGlbPath: sample.refineGlbPath,
          outputGlbPath,
          status: "error",
          error: "no_output_glb",
          durationMs: proc.durationMs,
          hasSkin: false,
          skinJointCount: 0,
          requiredCoreCoverage: null,
          missingRequiredCore: [...requiredCore],
          clipCoverage: [],
          nonUniformScaleNodes: 0,
          negativeScaleNodes: 0,
        });
        continue;
      }

      const rig = analyzeRigGlb(outputGlbPath);
      const availableNames = new Set([...rig.nodeNames, ...rig.skinJointNames]);
      const coreCoverage = coverageRatio(requiredCoreSet, availableNames);
      const missingRequired = [...requiredCoreSet].filter((name) => !availableNames.has(name));

      const coverage: ClipCoverage[] = [];
      for (const [clip, targets] of clipTargets.entries()) {
        const c = coverageRatio(targets, availableNames);
        coverage.push({
          clip,
          targetCount: c.total,
          matchedCount: c.matched,
          coverage: c.ratio,
        });
      }
      coverage.sort((a, b) => a.clip.localeCompare(b.clip));

      const sampleResult: SampleRunResult = {
        sampleId: sample.id,
        inputGlbPath: sample.refineGlbPath,
        outputGlbPath,
        status: "ok",
        durationMs: proc.durationMs,
        hasSkin: rig.skins > 0 && rig.skinJointNames.length > 0,
        skinJointCount: rig.skinJointNames.length,
        requiredCoreCoverage: coreCoverage.ratio,
        missingRequiredCore: missingRequired,
        clipCoverage: coverage,
        nonUniformScaleNodes: rig.nonUniformScaleNodes,
        negativeScaleNodes: rig.negativeScaleNodes,
      };
      results.push(sampleResult);
    }

    const ok = results.filter((r) => r.status === "ok");
    const avgCore = avg(ok.map((r) => r.requiredCoreCoverage));
    const avgIdle = avg(
      ok.map((r) => {
        const idle = r.clipCoverage.find((c) => c.clip === "idle");
        return idle?.coverage ?? null;
      })
    );
    variantSummaries.push({
      variantId: variant.id,
      description: variant.description,
      configPath: variantConfigPath,
      outputDir: variantDir,
      results,
      okCount: ok.length,
      totalCount: results.length,
      avgRequiredCoreCoverage: avgCore,
      avgIdleCoverage: avgIdle,
    });
  }

  const reportMd = buildReportMarkdown(sweepDir, refineBatchDir, configPath, blenderBin, variantSummaries);
  const reportPath = join(sweepDir, "rig-sweep-report.md");
  const summaryPath = join(sweepDir, "rig-sweep-summary.json");
  await writeFile(reportPath, reportMd);
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dryRun,
        refineBatchDir,
        configPath,
        blenderBin,
        variantCount: variantSummaries.length,
        sampleCount: samples.length,
        variants: variantSummaries,
      },
      null,
      2
    )
  );

  console.log("\n=== Rig sweep complete ===");
  console.log(`Summary: ${summaryPath}`);
  console.log(`Report:  ${reportPath}`);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
