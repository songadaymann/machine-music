#!/usr/bin/env bun
// Admin runtime reset utility
// Usage:
//   bun run test/admin-reset.ts
//   API_URL=https://synthmob.fly.dev/api bun run test/admin-reset.ts

const DEFAULT_API = "https://synthmob.fly.dev/api";

function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) return trimmed;
  return `${trimmed}/api`;
}

async function main() {
  const apiBase = normalizeApiBase(process.env.API_URL || DEFAULT_API);
  const adminKey = process.env.RESET_ADMIN_KEY || process.env.ACTIVITY_ADMIN_KEY;

  if (!adminKey) {
    console.error(
      "RESET_ADMIN_KEY (or ACTIVITY_ADMIN_KEY) is required in environment."
    );
    process.exit(1);
  }

  const resetUrl = `${apiBase}/admin/reset`;
  console.log(`[reset] POST ${resetUrl}`);

  const resetRes = await fetch(resetUrl, {
    method: "POST",
    headers: {
      "x-admin-key": adminKey,
    },
  });

  const resetText = await resetRes.text();
  let resetData: unknown = null;
  try {
    resetData = JSON.parse(resetText);
  } catch {
    resetData = resetText;
  }

  if (!resetRes.ok) {
    console.error(`[reset] failed (${resetRes.status})`);
    console.error(resetData);
    process.exit(1);
  }

  const parsed = resetData as {
    clearedSlots?: number;
    clearedAgents?: number;
    clearedCooldowns?: number;
    clearedActivity?: number;
    epoch_started?: string;
  };

  console.log(
    `[reset] ok cleared slots=${parsed.clearedSlots ?? 0} ` +
      `agents=${parsed.clearedAgents ?? 0} cooldowns=${parsed.clearedCooldowns ?? 0} ` +
      `activity=${parsed.clearedActivity ?? 0}`
  );
  if (parsed.epoch_started) {
    console.log(`[reset] epoch_started=${parsed.epoch_started}`);
  }

  const compRes = await fetch(`${apiBase}/composition`);
  if (!compRes.ok) {
    console.warn(`[reset] composition check failed (${compRes.status})`);
    return;
  }
  const compData = (await compRes.json()) as { slots?: Array<{ code: string | null }> };
  const activeSlots = Array.isArray(compData.slots)
    ? compData.slots.filter((s) => !!s.code).length
    : 0;
  console.log(`[reset] composition active_slots=${activeSlots}`);
}

main().catch((err) => {
  console.error("[reset] error:", err);
  process.exit(1);
});
