// API routes for The Music Place

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { state, type BotActivityEntry } from "./state";
import { validateStrudelCode } from "./validator";

const api = new Hono();

const ACTIVITY_RESULTS = new Set<BotActivityEntry["result"]>([
  "claimed",
  "rejected",
  "cooldown",
  "error",
]);

const MAX_ACTIVITY_NAME = 64;
const MAX_ACTIVITY_MODEL = 64;
const MAX_ACTIVITY_PERSONALITY = 600;
const MAX_ACTIVITY_STRATEGY = 64;
const MAX_ACTIVITY_SLOT_TYPE = 32;
const MAX_ACTIVITY_REASONING = 2000;
const MAX_ACTIVITY_PATTERN = 280;
const MAX_ACTIVITY_RESULT_DETAIL = 600;

function isBoundedString(value: unknown, maxLen: number): value is string {
  return typeof value === "string" && value.length <= maxLen;
}

function isNonEmptyBoundedString(value: unknown, maxLen: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLen
  );
}

function validateActivityPayload(body: Partial<BotActivityEntry>): string | null {
  if (!isNonEmptyBoundedString(body.model, MAX_ACTIVITY_MODEL)) {
    return "invalid_model";
  }
  if (!isNonEmptyBoundedString(body.personality, MAX_ACTIVITY_PERSONALITY)) {
    return "invalid_personality";
  }
  if (!isNonEmptyBoundedString(body.strategy, MAX_ACTIVITY_STRATEGY)) {
    return "invalid_strategy";
  }
  if (!Number.isInteger(body.targetSlot) || body.targetSlot! < 0 || body.targetSlot! > 8) {
    return "invalid_target_slot";
  }
  if (!isNonEmptyBoundedString(body.targetSlotType, MAX_ACTIVITY_SLOT_TYPE)) {
    return "invalid_target_slot_type";
  }
  if (!isNonEmptyBoundedString(body.reasoning, MAX_ACTIVITY_REASONING)) {
    return "invalid_reasoning";
  }
  if (!isBoundedString(body.pattern, MAX_ACTIVITY_PATTERN)) {
    return "invalid_pattern";
  }
  if (!ACTIVITY_RESULTS.has(body.result as BotActivityEntry["result"])) {
    return "invalid_result";
  }
  if (
    body.resultDetail !== undefined &&
    !isBoundedString(body.resultDetail, MAX_ACTIVITY_RESULT_DETAIL)
  ) {
    return "invalid_result_detail";
  }
  if (
    body.previousHolder !== undefined &&
    body.previousHolder !== null &&
    !isBoundedString(body.previousHolder, MAX_ACTIVITY_NAME)
  ) {
    return "invalid_previous_holder";
  }
  if (
    body.retryAttempt !== undefined &&
    (!Number.isInteger(body.retryAttempt) || body.retryAttempt < 0 || body.retryAttempt > 9)
  ) {
    return "invalid_retry_attempt";
  }
  return null;
}

// --- Agent Registration ---

api.post("/agents", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body?.name?.trim();

  if (!name) {
    return c.json({ error: "name_required" }, 400);
  }

  // Validate name format: max 20 chars, alphanumeric + hyphens/underscores/dots
  if (!/^[a-zA-Z0-9._-]{1,20}$/.test(name)) {
    return c.json(
      {
        error: "invalid_name",
        details: "Max 20 characters, alphanumeric plus hyphens, underscores, dots",
      },
      400
    );
  }

  if (state.agentNameExists(name)) {
    return c.json({ error: "name_taken" }, 409);
  }

  const agent = state.registerAgent(name);
  return c.json({ id: agent.id, name: agent.name, token: agent.token }, 201);
});

// --- Read Composition ---

api.get("/composition", (c) => {
  return c.json(state.getComposition());
});

// --- Read Musical Context ---

api.get("/context", (c) => {
  return c.json(state.getContext());
});

// --- Claim or Overwrite a Slot ---

api.post("/slot/:id", async (c) => {
  // Auth
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = state.getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid_token" }, 401);
  }

  // Parse slot ID
  const slotId = parseInt(c.req.param("id"), 10);
  if (isNaN(slotId) || slotId < 1 || slotId > 8) {
    return c.json({ error: "invalid_slot", details: "Slot must be 1-8" }, 400);
  }

  // Parse body
  const body = await c.req.json<{ code?: string }>();
  const code = body?.code;
  if (typeof code !== "string") {
    return c.json({ error: "code_required" }, 400);
  }

  // Get slot for type info
  const slot = state.getSlot(slotId);
  if (!slot) {
    return c.json({ error: "invalid_slot" }, 400);
  }

  // Validate code
  const validation = validateStrudelCode(code, slot.type);
  if (!validation.valid) {
    return c.json(
      { error: "validation_failed", details: validation.errors },
      400
    );
  }

  // Attempt write
  const result = state.writeSlot(slotId, code, agent);
  if (!result.success) {
    if (result.error === "cooldown") {
      return c.json({ error: "cooldown", retry_after: result.retryAfter }, 429);
    }
    return c.json({ error: result.error }, 400);
  }

  // Cooldown info
  const cooldownRemaining = state.getCooldownRemaining(agent.id);

  return c.json({
    slot: slotId,
    status: "claimed",
    cooldown_until: cooldownRemaining
      ? new Date(Date.now() + cooldownRemaining * 1000).toISOString()
      : null,
    warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
  });
});

// --- Agent Status ---

api.get("/agents/status", (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = state.getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid_token" }, 401);
  }

  const slotsHeld = state.slots
    .filter((s) => s.agent?.id === agent.id)
    .map((s) => s.id);

  const cooldownRemaining = state.getCooldownRemaining(agent.id);

  return c.json({
    id: agent.id,
    name: agent.name,
    slots_held: slotsHeld,
    total_placements: agent.totalPlacements,
    cooldown_remaining: cooldownRemaining,
    reputation: agent.reputation,
    tier: "newcomer", // Phase 1: everyone is newcomer
    cooldown_seconds: 60,
    code_limit: 280,
  });
});

// --- Leaderboard ---

api.get("/leaderboard", (c) => {
  const agents = Array.from(state.agents.values());
  const leaderboard = agents
    .map((a) => ({
      name: a.name,
      slots_held: state.slots.filter((s) => s.agent?.id === a.id).length,
      total_placements: a.totalPlacements,
      reputation: a.reputation,
    }))
    .sort((a, b) => b.slots_held - a.slots_held || b.reputation - a.reputation);

  return c.json(leaderboard);
});

// --- Bot Activity Log (for dashboard) ---

api.post("/activity", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = state.getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid_token" }, 401);
  }

  const body = await c.req.json<Partial<BotActivityEntry>>();
  const validationError = validateActivityPayload(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  if (
    body.botName !== undefined &&
    !isNonEmptyBoundedString(body.botName, MAX_ACTIVITY_NAME)
  ) {
    return c.json({ error: "invalid_bot_name" }, 400);
  }
  if (body.botName && body.botName !== agent.name) {
    return c.json({ error: "bot_name_mismatch" }, 403);
  }

  const entry: BotActivityEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    botName: agent.name,
    model: body.model!,
    personality: body.personality!,
    strategy: body.strategy!,
    targetSlot: body.targetSlot!,
    targetSlotType: body.targetSlotType!,
    reasoning: body.reasoning!,
    pattern: body.pattern!,
    result: body.result!,
    resultDetail: body.resultDetail,
    previousHolder: body.previousHolder,
    retryAttempt: body.retryAttempt,
  };

  state.addBotActivity(entry);
  return c.json({ ok: true, id: entry.id }, 201);
});

api.get("/activity", (c) => {
  return c.json(state.getBotActivity());
});

api.delete("/activity", (c) => {
  const adminKey = process.env.ACTIVITY_ADMIN_KEY;
  const providedAdminKey = c.req.header("x-admin-key");
  const hasValidAdminKey =
    typeof adminKey === "string" &&
    adminKey.length > 0 &&
    providedAdminKey === adminKey;

  if (!hasValidAdminKey) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const token = authHeader.slice(7);
    const agent = state.getAgentByToken(token);
    if (!agent) {
      return c.json({ error: "invalid_token" }, 401);
    }
  }

  state.clearBotActivity();
  return c.json({ ok: true });
});

// --- SSE Stream ---

api.get("/stream", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ message: "connected" })}\n\n`)
      );

      // SSE listener
      const listener = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Stream closed
          state.removeSSEListener(listener);
        }
      };

      state.addSSEListener(listener);

      // Heartbeat every 15s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          state.removeSSEListener(listener);
        }
      }, 15_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",       // Disable proxy buffering (Fly/nginx)
    },
  });
});

export { api };
