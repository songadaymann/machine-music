// API routes for The Music Place

import { Hono } from "hono";
import { state } from "./state";
import { validateStrudelCode } from "./validator";

const api = new Hono();

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

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          state.removeSSEListener(listener);
        }
      }, 30_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

export { api };
