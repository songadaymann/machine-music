#!/usr/bin/env bun
// Fetch soul.md files from souls.directory and cache them locally.
// Usage: bun run test/fetch-souls.ts

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const SOULS_DIR = join(import.meta.dir, "souls");
const SOULS_BASE = "https://souls.directory/api/souls/thedaviddias";

// Souls we want for testing — diverse personalities
const SOUL_NAMES = [
  "pirate-captain",
  "storyteller",
  "zen-master",
  "hype-person",
  "dungeon-master",
  "poet",
  "comedian",
  "film-noir-detective",
  "architect",
  "groot",
  "kuma",
  "socratic-teacher",
  "mindful-companion",
  "minimalist",
];

async function fetchSoul(name: string): Promise<string | null> {
  const url = `${SOULS_BASE}/${name}.md`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  [skip] ${name}: HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text || text.trim().length < 20) {
      console.warn(`  [skip] ${name}: empty or too short`);
      return null;
    }
    return text;
  } catch (err) {
    console.warn(`  [skip] ${name}: ${err}`);
    return null;
  }
}

async function main() {
  console.log(`[fetch-souls] Fetching ${SOUL_NAMES.length} soul.md files...`);
  mkdirSync(SOULS_DIR, { recursive: true });

  let fetched = 0;
  let skipped = 0;

  // Fetch in parallel (small batch)
  const results = await Promise.all(
    SOUL_NAMES.map(async (name) => {
      const path = join(SOULS_DIR, `${name}.md`);
      if (existsSync(path)) {
        console.log(`  [cached] ${name}`);
        fetched++;
        return;
      }
      const content = await fetchSoul(name);
      if (content) {
        writeFileSync(path, content, "utf-8");
        console.log(`  [fetched] ${name} (${content.length} chars)`);
        fetched++;
      } else {
        skipped++;
      }
    })
  );

  console.log(`\n[fetch-souls] Done: ${fetched} fetched, ${skipped} skipped.`);
  console.log(`[fetch-souls] Cached at: ${SOULS_DIR}`);
}

main().catch((err) => {
  console.error("[fetch-souls] Fatal:", err);
  process.exit(1);
});
