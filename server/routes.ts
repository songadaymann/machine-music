// API routes for SynthMob

import { Hono } from "hono";
import { randomUUID, createHash } from "crypto";
import { posix as pathPosix } from "path";
import { avatarGenerationService, type AvatarOrder } from "./avatar-generation";
import { worldObjectGenerationService, type WorldObjectOrder } from "./world-object-generation";
import { state, type Agent, type BotActivityEntry, type SessionType, VALID_INSTRUMENT_TYPES, type InstrumentType } from "./state";
import { MAX_CODE_CHARS, validateStrudelCode, validateSpatialPattern, validateVisualOutput, validateWorldOutput, validateGameOutput } from "./validator";
import { getWayfindingActionCatalog, isWayfindingAction, getArenaConfig } from "./wayfinding";
import { WayfindingReducer } from "./wayfinding-runtime";
import { isValidKey, isValidScale, VALID_SCALES, MIN_BPM, MAX_BPM } from "./music-theory";
import { generateNonce, consumeNonce, buildSignMessage, recoverAddress, createSession, getSessionAddress } from "./wallet-auth";
import { checkContentSafety } from "./content-safety";
import { verifyPayment, isPaymentConfigured, MIN_PROMPT_WEI, MIN_STORM_WEI } from "./payment";

const api = new Hono();

const ACTIVITY_RESULTS = new Set<BotActivityEntry["result"]>([
  "intent",
  "travel",
  "thinking",
  "submitting",
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
const MAX_ACTIVITY_PATTERN = MAX_CODE_CHARS;
const MAX_ACTIVITY_RESULT_DETAIL = 600;
const MAX_WORLD_OBJECT_PROMPT = 600;
const MAX_WORLD_OBJECT_TEXTURE_PROMPT = 600;
const MAX_AVATAR_PROMPT = 600;
const MAX_AVATAR_TEXTURE_PROMPT = 600;
const MAX_AVATAR_GLB_URL = 4096;
const MIN_AVATAR_HEIGHT = 0.8;
const MAX_AVATAR_HEIGHT = 3.2;
const DEFAULT_AVATAR_HEIGHT = 1.7;
const MAX_JAM_ID = 120;
const MAX_JAM_SPOT_ID = 120;
const MAX_JAM_PATTERN = MAX_CODE_CHARS;
let avatarProgressBridgeAttached = false;

if (!avatarProgressBridgeAttached) {
  avatarGenerationService.addListener((order) => {
    state.broadcast("avatar_generating", toAvatarOrderResponse(order));
  });
  avatarProgressBridgeAttached = true;
}

function getAdminKey(): string | null {
  const resetKey = process.env.RESET_ADMIN_KEY;
  if (typeof resetKey === "string" && resetKey.length > 0) {
    return resetKey;
  }
  const activityKey = process.env.ACTIVITY_ADMIN_KEY;
  if (typeof activityKey === "string" && activityKey.length > 0) {
    return activityKey;
  }
  return null;
}

function hasValidAdminKey(providedAdminKey: string | undefined): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  return providedAdminKey === adminKey;
}

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

function parseAvatarHeight(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return null;
  if (parsed < MIN_AVATAR_HEIGHT || parsed > MAX_AVATAR_HEIGHT) return null;
  return Math.round(parsed * 100) / 100;
}

function parseJamPattern(value: unknown): { ok: true; pattern: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, pattern: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "invalid_pattern" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, pattern: null };
  }
  if (trimmed.length > MAX_JAM_PATTERN) {
    return { ok: false, error: "pattern_too_long" };
  }
  const validation = validateStrudelCode(trimmed, "wild");
  if (!validation.valid) {
    return { ok: false, error: "validation_failed" };
  }
  return { ok: true, pattern: trimmed };
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

function getAgentFromAuthHeader(authHeader: string | undefined): Agent | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  return state.getAgentByToken(token);
}

function getAgentAndTouch(authHeader: string | undefined, activity?: string): Agent | null {
  const agent = getAgentFromAuthHeader(authHeader);
  if (agent) {
    state.touchPresence(agent.id, activity);
  }
  return agent;
}

function toWorldObjectOrderResponse(order: WorldObjectOrder) {
  return {
    order_id: order.id,
    bot_name: order.agentName,
    status: order.status,
    progress: order.progress,
    prompt: order.prompt,
    texture_prompt: order.texturePrompt,
    error: order.error,
    glb_url: order.storedGlbUrl,
    meshy_refined_glb_url: order.meshyRefinedGlbUrl,
    meshy_preview_task_id: order.meshyPreviewTaskId,
    meshy_refine_task_id: order.meshyRefineTaskId,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    completed_at: order.completedAt,
  };
}

function toAvatarOrderResponse(order: AvatarOrder) {
  return {
    order_id: order.id,
    bot_name: order.agentName,
    status: order.status,
    progress: order.progress,
    prompt: order.prompt,
    texture_prompt: order.texturePrompt,
    avatar_height: order.avatarHeightMeters,
    error: order.error,
    glb_url: order.storedGlbUrl,
    meshy_rigged_glb_url: order.meshyRiggedGlbUrl,
    meshy_refined_glb_url: order.meshyRefinedGlbUrl,
    meshy_preview_task_id: order.meshyPreviewTaskId,
    meshy_refine_task_id: order.meshyRefineTaskId,
    meshy_rig_task_id: order.meshyRigTaskId,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    completed_at: order.completedAt,
  };
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
  state.touchPresence(agent.id, "idle");
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

// --- Read Sound Lookup ---

api.get("/sounds", (c) => {
  const { sampleBanks, soundLookup } = state.getContext();
  return c.json({
    sampleBanks,
    soundLookup,
  });
});

// --- Ambient jam sessions ---

api.get("/jams", (c) => {
  return c.json(state.getJamSnapshot());
});

api.post("/jam/start", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { spot_id?: string; pattern?: string };
  try {
    body = await c.req.json<{ spot_id?: string; pattern?: string }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const spotId = body.spot_id?.trim();
  if (spotId !== undefined && spotId.length > 0 && !isNonEmptyBoundedString(spotId, MAX_JAM_SPOT_ID)) {
    return c.json({ error: "invalid_spot_id" }, 400);
  }

  const parsedPattern = parseJamPattern(body.pattern);
  if (parsedPattern.ok === false) {
    return c.json({ error: parsedPattern.error }, 400);
  }

  const result = state.startJam(agent, {
    spotId: spotId && spotId.length > 0 ? spotId : null,
    pattern: parsedPattern.pattern,
  });
  if (result.success === false) {
    if (result.error === "invalid_spot") {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getJamSnapshot(),
  });
});

api.post("/jam/join", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { jam_id?: string; pattern?: string };
  try {
    body = await c.req.json<{ jam_id?: string; pattern?: string }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const jamId = body.jam_id?.trim();
  if (!isNonEmptyBoundedString(jamId, MAX_JAM_ID)) {
    return c.json({ error: "jam_id_required" }, 400);
  }

  const parsedPattern = parseJamPattern(body.pattern);
  if (parsedPattern.ok === false) {
    return c.json({ error: parsedPattern.error }, 400);
  }

  const result = state.joinJam(agent, { jamId, pattern: parsedPattern.pattern });
  if (result.success === false) {
    if (result.error === "jam_not_found") {
      return c.json({ error: result.error }, 404);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getJamSnapshot(),
  });
});

api.post("/jam/leave", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { jam_id?: string };
  try {
    body = await c.req.json<{ jam_id?: string }>();
  } catch {
    body = {};
  }

  const jamId = body.jam_id?.trim();
  if (jamId !== undefined && jamId.length > 0 && !isNonEmptyBoundedString(jamId, MAX_JAM_ID)) {
    return c.json({ error: "invalid_jam_id" }, 400);
  }

  const result = state.leaveJam(agent, { jamId: jamId && jamId.length > 0 ? jamId : null });
  if (result.success === false) {
    if (result.error === "jam_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_in_jam") {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    jam_id: result.jamId,
    snapshot: state.getJamSnapshot(),
  });
});

api.post("/jam/pattern", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { jam_id?: string; pattern?: string | null };
  try {
    body = await c.req.json<{ jam_id?: string; pattern?: string | null }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const jamId = body.jam_id?.trim();
  if (!isNonEmptyBoundedString(jamId, MAX_JAM_ID)) {
    return c.json({ error: "jam_id_required" }, 400);
  }

  const parsedPattern = parseJamPattern(body.pattern);
  if (parsedPattern.ok === false) {
    return c.json({ error: parsedPattern.error }, 400);
  }

  const result = state.updateJamPattern(agent, { jamId, pattern: parsedPattern.pattern });
  if (result.success === false) {
    if (result.error === "jam_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_in_jam") {
      return c.json({ error: result.error }, 403);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getJamSnapshot(),
  });
});

// --- Creative sessions ---

const MAX_SESSION_ID = 120;
const MAX_SESSION_TITLE = 80;
const MAX_SESSION_PATTERN = MAX_CODE_CHARS;
const SESSION_TYPES = new Set<SessionType>(["music", "visual", "world", "game"]);

type ParsedSessionOutput = {
  ok: true;
  pattern: string | null;
  output: Record<string, unknown> | null;
} | {
  ok: false;
  error: string;
  details?: string[];
};

function parseMusicPattern(value: unknown): ParsedSessionOutput {
  if (value === undefined || value === null) {
    return { ok: true, pattern: null, output: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "invalid_pattern" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, pattern: null, output: null };
  }
  if (trimmed.length > MAX_SESSION_PATTERN) {
    return { ok: false, error: "pattern_too_long" };
  }
  const validation = validateStrudelCode(trimmed, "wild");
  if (!validation.valid) {
    return { ok: false, error: "validation_failed", details: validation.errors };
  }
  return { ok: true, pattern: trimmed, output: null };
}

function parseStructuredOutput(
  outputValue: unknown,
  validator: (o: unknown) => { valid: boolean; errors: string[]; warnings: string[] }
): ParsedSessionOutput {
  if (outputValue === undefined || outputValue === null) {
    return { ok: true, pattern: null, output: null };
  }
  if (typeof outputValue !== "object" || Array.isArray(outputValue)) {
    return { ok: false, error: "invalid_output", details: ["output must be a JSON object"] };
  }
  const result = validator(outputValue);
  if (!result.valid) {
    return { ok: false, error: "validation_failed", details: result.errors };
  }
  return { ok: true, pattern: null, output: outputValue as Record<string, unknown> };
}

function parseSessionOutput(
  type: SessionType,
  body: { pattern?: unknown; output?: unknown }
): ParsedSessionOutput {
  switch (type) {
    case "music":
      return parseMusicPattern(body.pattern);
    case "visual":
      return parseStructuredOutput(body.output, validateVisualOutput);
    case "world":
      return parseStructuredOutput(body.output, validateWorldOutput);
    case "game":
      return parseStructuredOutput(body.output, validateGameOutput);
    default:
      return { ok: false, error: "unsupported_session_type" };
  }
}

api.get("/sessions", (c) => {
  return c.json(state.getSessionSnapshot());
});

api.post("/session/start", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { type?: string; title?: string; pattern?: string; output?: unknown; position?: { x?: number; z?: number } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sessionType: SessionType = SESSION_TYPES.has(body.type as SessionType) ? (body.type as SessionType) : "music";

  if (body.title !== undefined && typeof body.title === "string" && body.title.length > MAX_SESSION_TITLE) {
    return c.json({ error: "title_too_long" }, 400);
  }

  const parsed = parseSessionOutput(sessionType, body);
  if (parsed.ok === false) {
    return c.json({ error: parsed.error, details: parsed.details }, 400);
  }

  const result = state.startSession(agent, {
    type: sessionType,
    title: body.title ?? null,
    pattern: parsed.pattern,
    output: parsed.output,
    position: body.position ?? null,
  });
  if (result.success === false) {
    if (result.error === "max_sessions_reached") {
      return c.json({ error: result.error }, 429);
    }
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getSessionSnapshot(),
  });
});

api.post("/session/join", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { session_id?: string; pattern?: string; output?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sessionId = body.session_id?.trim();
  if (!isNonEmptyBoundedString(sessionId, MAX_SESSION_ID)) {
    return c.json({ error: "session_id_required" }, 400);
  }

  // Look up session type for validation
  const sessionType = state.getSessionType(sessionId);
  if (!sessionType) {
    return c.json({ error: "session_not_found" }, 404);
  }

  const parsed = parseSessionOutput(sessionType, body);
  if (parsed.ok === false) {
    return c.json({ error: parsed.error, details: parsed.details }, 400);
  }

  const result = state.joinSession(agent, { sessionId, pattern: parsed.pattern, output: parsed.output });
  if (result.success === false) {
    if (result.error === "session_not_found") {
      return c.json({ error: result.error }, 404);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getSessionSnapshot(),
  });
});

api.post("/session/leave", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { session_id?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const sessionId = body.session_id?.trim();
  if (sessionId !== undefined && sessionId.length > 0 && !isNonEmptyBoundedString(sessionId, MAX_SESSION_ID)) {
    return c.json({ error: "invalid_session_id" }, 400);
  }

  const result = state.leaveSession(agent, { sessionId: sessionId && sessionId.length > 0 ? sessionId : null });
  if (result.success === false) {
    if (result.error === "session_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_in_session") {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    session_id: result.sessionId,
    snapshot: state.getSessionSnapshot(),
  });
});

api.post("/session/output", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { session_id?: string; pattern?: string | null; output?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sessionId = body.session_id?.trim();
  if (!isNonEmptyBoundedString(sessionId, MAX_SESSION_ID)) {
    return c.json({ error: "session_id_required" }, 400);
  }

  // Look up session type for validation
  const sessionType = state.getSessionType(sessionId);
  if (!sessionType) {
    return c.json({ error: "session_not_found" }, 404);
  }

  const parsed = parseSessionOutput(sessionType, body);
  if (parsed.ok === false) {
    return c.json({ error: parsed.error, details: parsed.details }, 400);
  }

  const result = state.updateSessionOutput(agent, { sessionId, pattern: parsed.pattern, output: parsed.output });
  if (result.success === false) {
    if (result.error === "session_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_in_session") {
      return c.json({ error: result.error }, 403);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    session: result.session,
    snapshot: state.getSessionSnapshot(),
  });
});

// --- Shared world state ---

api.get("/world", (c) => {
  return c.json(state.getWorldSnapshot());
});

api.post("/world", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "world");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { output?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // If output is missing/null/empty, clear this agent's contribution
  if (!body.output || (typeof body.output === "object" && Object.keys(body.output as object).length === 0)) {
    const snapshot = state.clearWorldContribution(agent.id);
    return c.json({ ok: true, snapshot });
  }

  const parsed = parseStructuredOutput(body.output, validateWorldOutput);
  if (parsed.ok === false) {
    return c.json({ error: parsed.error, details: parsed.details }, 400);
  }

  const result = state.writeWorld(agent, parsed.output!);
  return c.json({ ok: true, snapshot: result.snapshot });
});

// --- World catalog ---

api.get("/world/catalog", async (c) => {
  try {
    const manifestPath = "./public/catalog/manifest.json";
    const file = Bun.file(manifestPath);
    if (await file.exists()) {
      const manifest = await file.json();
      return c.json(manifest);
    }
    return c.json({ items: {} });
  } catch {
    return c.json({ items: {} });
  }
});

// --- World object generation (Meshy) ---

api.post("/world/generate", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { prompt?: string; texture_prompt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return c.json({ error: "prompt_required" }, 400);
  }
  if (prompt.length > MAX_WORLD_OBJECT_PROMPT) {
    return c.json({ error: "prompt_too_long", max: MAX_WORLD_OBJECT_PROMPT }, 400);
  }

  const texturePrompt = body.texture_prompt?.trim() || null;
  if (texturePrompt && texturePrompt.length > MAX_WORLD_OBJECT_TEXTURE_PROMPT) {
    return c.json({ error: "texture_prompt_too_long", max: MAX_WORLD_OBJECT_TEXTURE_PROMPT }, 400);
  }

  if (!worldObjectGenerationService.isConfigured()) {
    return c.json({
      error: "meshy_not_configured",
      details: "Set MESHY_API_KEY to use /api/world/generate",
    }, 503);
  }

  const active = worldObjectGenerationService.getActiveOrderForAgent(agent.id);
  if (active) {
    return c.json({
      error: "generation_in_progress",
      active_order: toWorldObjectOrderResponse(active),
    }, 409);
  }

  try {
    const order = worldObjectGenerationService.createOrder({
      agentId: agent.id,
      agentName: agent.name,
      prompt,
      texturePrompt: texturePrompt ?? undefined,
    });
    return c.json(toWorldObjectOrderResponse(order), 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation_failed";
    if (message === "generation_in_progress") {
      return c.json({ error: message }, 409);
    }
    if (message === "global_generation_limit") {
      return c.json({ error: message, details: "Too many concurrent generations, try again later" }, 429);
    }
    if (message === "meshy_not_configured") {
      return c.json({ error: message }, 503);
    }
    return c.json({ error: "generation_failed", details: message }, 500);
  }
});

api.get("/world/generate/orders", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const orders = worldObjectGenerationService
    .getOrdersForAgent(agent.id)
    .slice(0, 20)
    .map((order) => toWorldObjectOrderResponse(order));

  return c.json({ orders });
});

api.get("/world/generate/:id", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const orderId = c.req.param("id");
  if (!isNonEmptyBoundedString(orderId, 128)) {
    return c.json({ error: "invalid_order_id" }, 400);
  }

  const order = worldObjectGenerationService.getOrder(orderId);
  if (!order) {
    return c.json({ error: "order_not_found" }, 404);
  }
  if (order.agentId !== agent.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  return c.json(toWorldObjectOrderResponse(order));
});

// --- Spatial music placements ---

api.get("/music/placements", (c) => {
  return c.json(state.getMusicPlacementSnapshot());
});

api.post("/music/place", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "placing_music");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { instrument_type?: string; pattern?: string; position?: { x?: number; z?: number } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Validate instrument type
  const instrumentType = body.instrument_type?.trim();
  if (!instrumentType || !VALID_INSTRUMENT_TYPES.has(instrumentType as InstrumentType)) {
    return c.json({
      error: "invalid_instrument_type",
      details: `Must be one of: ${Array.from(VALID_INSTRUMENT_TYPES).join(", ")}`,
    }, 400);
  }

  // Validate pattern
  const pattern = body.pattern?.trim();
  if (!pattern) {
    return c.json({ error: "pattern_required" }, 400);
  }
  const validation = validateSpatialPattern(pattern);
  if (!validation.valid) {
    return c.json({ error: "validation_failed", details: validation.errors }, 400);
  }

  // Validate position
  const posX = Number(body.position?.x);
  const posZ = Number(body.position?.z);
  if (!Number.isFinite(posX) || !Number.isFinite(posZ)) {
    return c.json({ error: "invalid_position", details: "position.x and position.z must be finite numbers" }, 400);
  }

  const result = state.placeMusic(agent, instrumentType as InstrumentType, pattern, { x: posX, z: posZ });
  if (result.success === false) {
    if (result.error === "cooldown") {
      return c.json({ error: "cooldown", retry_after: result.retryAfter }, 429);
    }
    return c.json({ error: result.error }, 400);
  }

  const cooldownRemaining = state.getMusicPlacementCooldownRemaining(agent.id);
  return c.json({
    ok: true,
    placement: result.placement,
    cooldown_until: cooldownRemaining
      ? new Date(Date.now() + cooldownRemaining * 1000).toISOString()
      : null,
    warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
  });
});

api.put("/music/placement/:id", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "updating_music");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const placementId = c.req.param("id");

  let body: { pattern?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const pattern = body.pattern?.trim();
  if (!pattern) {
    return c.json({ error: "pattern_required" }, 400);
  }
  const validation = validateSpatialPattern(pattern);
  if (!validation.valid) {
    return c.json({ error: "validation_failed", details: validation.errors }, 400);
  }

  const result = state.updateMusicPlacement(agent, placementId, pattern);
  if (result.success === false) {
    if (result.error === "placement_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_owner") {
      return c.json({ error: result.error }, 403);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    placement: result.placement,
    warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
  });
});

api.delete("/music/placement/:id", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "removing_music");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const placementId = c.req.param("id");

  const result = state.removeMusicPlacement(agent, placementId);
  if (result.success === false) {
    if (result.error === "placement_not_found") {
      return c.json({ error: result.error }, 404);
    }
    if (result.error === "not_owner") {
      return c.json({ error: result.error }, 403);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({ ok: true });
});

// --- Wayfinding (continuous-space position tracking) ---

api.get("/wayfinding/graph", (c) => {
  return c.json({
    error: "endpoint_removed",
    hint: "Use GET /wayfinding/arena. The graph-based system has been replaced with continuous-space positioning.",
  }, 410);
});

api.get("/wayfinding/arena", (c) => {
  return c.json(getArenaConfig());
});

api.get("/wayfinding/actions", (c) => {
  return c.json({
    schemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    actions: getWayfindingActionCatalog(),
  });
});

api.get("/wayfinding/state", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(state.getWayfindingState(agent));
});

api.post("/wayfinding/action", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Backward compat: detect removed action types
  if (typeof body === "object" && body !== null && "type" in body && typeof (body as Record<string, unknown>).type === "string") {
    const actionType = (body as Record<string, unknown>).type as string;
    if (WayfindingReducer.isRemovedActionType(actionType)) {
      return c.json({
        error: "action_type_removed",
        removed_type: actionType,
        hint: "Use MOVE_TO with {x, z} coordinates. See GET /api/wayfinding/actions for the current catalog.",
      }, 410);
    }
  }

  if (!isWayfindingAction(body)) {
    return c.json({ error: "invalid_wayfinding_action" }, 400);
  }

  const result = state.submitWayfindingAction(agent, body);
  if (!result.accepted) {
    return c.json(
      {
        error: "wayfinding_action_rejected",
        reason_code: result.reasonCode,
        state: result.state,
      },
      400
    );
  }

  return c.json({
    ok: true,
    applied: { type: body.type },
    state: result.state,
  });
});

// --- Claim or Overwrite a Slot ---

api.post("/slot/:id", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "composing");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
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
  if (result.success === false) {
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
  const agent = getAgentAndTouch(c.req.header("Authorization"), "idle");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
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
    code_limit: MAX_CODE_CHARS,
  });
});

// --- Agent Directory & Messaging ---

api.get("/agents/online", (c) => {
  return c.json(state.getOnlineAgents());
});

api.get("/agents/messages", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  const messages = agent
    ? state.getMessages(agent.id)
    : state.getMessages();
  return c.json(messages);
});

api.post("/agents/messages", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "messaging");
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { content?: string; to?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const content = body.content?.trim();
  if (!content || content.length === 0) {
    return c.json({ error: "content_required" }, 400);
  }
  if (content.length > 500) {
    return c.json({ error: "content_too_long", max: 500 }, 400);
  }

  let toAgentId: string | null = null;
  if (body.to) {
    const toTrimmed = body.to.trim();
    const byName = state.getAgentByName(toTrimmed);
    if (byName) {
      toAgentId = byName.id;
    } else {
      const byId = state.getAgentById(toTrimmed);
      if (byId) {
        toAgentId = byId.id;
      } else {
        return c.json({ error: "recipient_not_found" }, 404);
      }
    }
    if (toAgentId === agent.id) {
      return c.json({ error: "cannot_message_self" }, 400);
    }
  }

  const message = state.addMessage(agent, content, toAgentId);
  return c.json({ ok: true, message }, 201);
});

// --- Human chat ---

const MAX_HUMAN_MESSAGE = 280;

function hashIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const raw =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

api.post("/human/message", async (c) => {
  let body: { content?: string; to?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const content = body.content?.trim();
  if (!content || content.length === 0) {
    return c.json({ error: "content_required" }, 400);
  }
  if (content.length > MAX_HUMAN_MESSAGE) {
    return c.json({ error: "content_too_long", max: MAX_HUMAN_MESSAGE }, 400);
  }

  const ipHash = hashIp(c);
  if (!state.checkHumanRateLimit(ipHash)) {
    return c.json({ error: "rate_limited", retry_after: 5 }, 429);
  }

  // Resolve @mention target
  let toAgentId: string | null = null;
  const toField = body.to?.trim();
  if (toField) {
    const byName = state.getAgentByName(toField);
    if (byName) {
      toAgentId = byName.id;
    } else {
      const byId = state.getAgentById(toField);
      if (byId) {
        toAgentId = byId.id;
      }
      // If target not found, still send as broadcast — don't fail
    }
  }

  const message = state.addHumanMessage(content, ipHash, toAgentId);
  return c.json({ ok: true, message }, 201);
});

// --- Storm (broadcast to all agents) ---

const MAX_STORM_MESSAGE = 280;

api.post("/human/storm", async (c) => {
  // Requires wallet session
  const sessionToken = c.req.header("X-Session-Token");
  if (!sessionToken) {
    return c.json({ error: "wallet_session_required" }, 401);
  }

  const walletAddress = getSessionAddress(sessionToken);
  if (!walletAddress) {
    return c.json({ error: "invalid_session" }, 401);
  }

  let body: { content?: string; tx_hash?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const content = body.content?.trim();
  if (!content || content.length === 0) {
    return c.json({ error: "content_required" }, 400);
  }
  if (content.length > MAX_STORM_MESSAGE) {
    return c.json({ error: "content_too_long", max: MAX_STORM_MESSAGE }, 400);
  }

  const ipHash = hashIp(c);

  // Rate limit: 1 storm per hour per IP
  if (!state.checkStormRateLimit(ipHash)) {
    return c.json({ error: "rate_limited", retry_after: 3600 }, 429);
  }

  // Content safety check (fail-open)
  const safety = await checkContentSafety(content);
  if (!safety.safe) {
    return c.json({ error: "content_unsafe", reason: safety.reason }, 400);
  }

  // Payment verification (5 ETH)
  const txHash = body.tx_hash?.trim();
  if (!txHash) {
    return c.json({ error: "tx_hash_required" }, 400);
  }

  if (!isPaymentConfigured()) {
    return c.json({ error: "payments_not_configured", details: "Set PROTOCOL_ADDRESS to enable storms" }, 503);
  }

  const payment = await verifyPayment(txHash, walletAddress, MIN_STORM_WEI);
  if (!payment.valid) {
    return c.json({ error: "payment_invalid", details: payment.error }, 402);
  }

  const message = state.addStormMessage(content, ipHash);
  return c.json({ ok: true, message }, 201);
});

// --- World Ritual (periodic BPM & key voting) ---

api.get("/ritual", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  const view = state.getRitualView(agent?.id);
  if (!view) {
    return c.json({ phase: "idle", ritual: null });
  }
  return c.json({ phase: view.phase, ritual: view });
});

api.post("/ritual/nominate", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "ritual");
  if (!agent) return c.json({ error: "unauthorized" }, 401);

  let body: { bpm?: number; key?: string; scale?: string; reasoning?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Validate BPM if provided
  if (body.bpm !== undefined) {
    if (typeof body.bpm !== "number" || !Number.isInteger(body.bpm) || body.bpm < MIN_BPM || body.bpm > MAX_BPM) {
      return c.json({ error: "invalid_bpm", details: `Integer ${MIN_BPM}-${MAX_BPM}` }, 400);
    }
  }

  // Validate key if provided
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || !isValidKey(body.key)) {
      return c.json({ error: "invalid_key", details: "One of: C, C#, D, D#, E, F, F#, G, G#, A, A#, B" }, 400);
    }
  }

  // Validate scale if provided (defaults to pentatonic in ritual runtime)
  if (body.scale !== undefined && !isValidScale(body.scale)) {
    return c.json({ error: "invalid_scale", details: `One of: ${VALID_SCALES.join(", ")}` }, 400);
  }

  if (body.bpm === undefined && body.key === undefined) {
    return c.json({ error: "bpm_or_key_required" }, 400);
  }

  const reasoning = (body.reasoning || "").trim().slice(0, 200);

  const result = state.submitRitualNomination(agent, body.bpm, body.key, body.scale, reasoning);
  if (!result.success) {
    if (result.error === "not_in_nominate_phase" || result.error === "already_nominated_bpm" || result.error === "already_nominated_key") {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({ ok: true, bpm_nomination_count: result.bpmNominationCount, key_nomination_count: result.keyNominationCount });
});

api.post("/ritual/vote", async (c) => {
  const agent = getAgentAndTouch(c.req.header("Authorization"), "ritual");
  if (!agent) return c.json({ error: "unauthorized" }, 401);

  let body: { bpm_candidate?: number; key_candidate?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (body.bpm_candidate !== undefined) {
    if (typeof body.bpm_candidate !== "number" || !Number.isInteger(body.bpm_candidate) || body.bpm_candidate < 1 || body.bpm_candidate > 3) {
      return c.json({ error: "invalid_bpm_candidate", details: "Integer 1-3" }, 400);
    }
  }

  if (body.key_candidate !== undefined) {
    if (typeof body.key_candidate !== "number" || !Number.isInteger(body.key_candidate) || body.key_candidate < 1 || body.key_candidate > 3) {
      return c.json({ error: "invalid_key_candidate", details: "Integer 1-3" }, 400);
    }
  }

  if (body.bpm_candidate === undefined && body.key_candidate === undefined) {
    return c.json({ error: "bpm_or_key_candidate_required" }, 400);
  }

  const result = state.submitRitualVote(agent, body.bpm_candidate, body.key_candidate);
  if (!result.success) {
    if (result.error === "not_in_vote_phase" || result.error === "already_voted_bpm" || result.error === "already_voted_key") {
      return c.json({ error: result.error }, 409);
    }
    if (result.error === "cannot_vote_own_bpm" || result.error === "cannot_vote_own_key") {
      return c.json({ error: result.error }, 403);
    }
    return c.json({ error: result.error }, 400);
  }

  return c.json({ ok: true, bpm_vote_counts: result.bpmVoteCounts, key_vote_counts: result.keyVoteCounts });
});

// --- Paid prompt to specific agent (Phase C) ---

const MAX_PROMPT_MESSAGE = 280;

api.post("/human/prompt", async (c) => {
  // Requires wallet session
  const sessionToken = c.req.header("X-Session-Token");
  if (!sessionToken) {
    return c.json({ error: "wallet_session_required" }, 401);
  }

  const walletAddress = getSessionAddress(sessionToken);
  if (!walletAddress) {
    return c.json({ error: "invalid_session" }, 401);
  }

  let body: { content?: string; to?: string; tx_hash?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const content = body.content?.trim();
  if (!content || content.length === 0) {
    return c.json({ error: "content_required" }, 400);
  }
  if (content.length > MAX_PROMPT_MESSAGE) {
    return c.json({ error: "content_too_long", max: MAX_PROMPT_MESSAGE }, 400);
  }

  // Resolve target agent
  const toField = body.to?.trim();
  if (!toField) {
    return c.json({ error: "to_required", details: "Specify target agent name or id" }, 400);
  }
  const toAgent = state.getAgentByName(toField) ?? state.getAgentById(toField);
  if (!toAgent) {
    return c.json({ error: "agent_not_found" }, 404);
  }

  // Content safety check (fail-open)
  const safety = await checkContentSafety(content);
  if (!safety.safe) {
    return c.json({ error: "content_unsafe", reason: safety.reason }, 400);
  }

  // Payment verification
  const txHash = body.tx_hash?.trim();
  if (!txHash) {
    return c.json({ error: "tx_hash_required" }, 400);
  }

  if (!isPaymentConfigured()) {
    return c.json({ error: "payments_not_configured", details: "Set PROTOCOL_ADDRESS to enable paid prompts" }, 503);
  }

  const payment = await verifyPayment(txHash, walletAddress, MIN_PROMPT_WEI);
  if (!payment.valid) {
    return c.json({ error: "payment_invalid", details: payment.error }, 402);
  }

  // Create directive for the agent
  const directive = state.addDirective(walletAddress, toAgent, content, txHash);

  // Also inject as a visible chat message so it appears in the social feed
  const ipHash = hashIp(c);
  state.addHumanMessage(content, ipHash, toAgent.id);

  return c.json({ ok: true, directive_id: directive.id, to: toAgent.name }, 201);
});

// --- Agent directive polling (Phase C) ---

api.get("/agents/directives", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const pending = state.getPendingDirectives(agent.id);

  // Mark as delivered on read (pull-based delivery)
  if (pending.length > 0) {
    state.markDirectivesDelivered(agent.id);
  }

  return c.json({
    directives: pending.map((d) => ({
      id: d.id,
      timestamp: d.timestamp,
      from_address: d.fromAddress,
      content: d.content,
    })),
  });
});

api.get("/agents/:id", (c) => {
  const agentId = c.req.param("id");
  let profile = state.getAgentPublicProfile(agentId);
  if (!profile) {
    const byName = state.getAgentByName(agentId);
    if (byName) {
      profile = state.getAgentPublicProfile(byName.id);
    }
  }
  if (!profile) {
    return c.json({ error: "agent_not_found" }, 404);
  }
  return c.json(profile);
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
  const providedAdminKey = c.req.header("x-admin-key");
  const isAdmin = hasValidAdminKey(providedAdminKey);

  if (!isAdmin) {
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

// --- Avatar generation + assignment ---

api.post("/avatar/generate", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { prompt?: string; texture_prompt?: string; avatar_height?: number | string };
  try {
    body = await c.req.json<{
      prompt?: string;
      texture_prompt?: string;
    }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return c.json({ error: "prompt_required" }, 400);
  }
  if (prompt.length > MAX_AVATAR_PROMPT) {
    return c.json({ error: "prompt_too_long", max: MAX_AVATAR_PROMPT }, 400);
  }

  const texturePrompt = body.texture_prompt?.trim() || null;
  if (texturePrompt && texturePrompt.length > MAX_AVATAR_TEXTURE_PROMPT) {
    return c.json(
      { error: "texture_prompt_too_long", max: MAX_AVATAR_TEXTURE_PROMPT },
      400
    );
  }
  const parsedAvatarHeight = parseAvatarHeight(body.avatar_height);
  if (body.avatar_height !== undefined && parsedAvatarHeight === null) {
    return c.json(
      {
        error: "invalid_avatar_height",
        details: `avatar_height must be between ${MIN_AVATAR_HEIGHT} and ${MAX_AVATAR_HEIGHT}`,
      },
      400
    );
  }
  const avatarHeight = parsedAvatarHeight ?? DEFAULT_AVATAR_HEIGHT;

  if (!avatarGenerationService.isConfigured()) {
    return c.json(
      {
        error: "meshy_not_configured",
        details: "Set MESHY_API_KEY to use /api/avatar/generate",
      },
      503
    );
  }

  const active = avatarGenerationService.getActiveOrderForAgent(agent.id);
  if (active) {
    return c.json(
      {
        error: "avatar_generation_in_progress",
        active_order: toAvatarOrderResponse(active),
      },
      409
    );
  }

  try {
    const order = avatarGenerationService.createOrder({
      agentId: agent.id,
      agentName: agent.name,
      prompt,
      texturePrompt: texturePrompt ?? undefined,
      avatarHeightMeters: avatarHeight,
    });
    return c.json(toAvatarOrderResponse(order), 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : "avatar_generation_failed";
    if (message === "avatar_generation_in_progress") {
      return c.json({ error: message }, 409);
    }
    if (message === "meshy_not_configured") {
      return c.json({ error: message }, 503);
    }
    return c.json({ error: "avatar_generation_failed", details: message }, 500);
  }
});

api.get("/avatar/order/:id", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const orderId = c.req.param("id");
  if (!isNonEmptyBoundedString(orderId, 128)) {
    return c.json({ error: "invalid_order_id" }, 400);
  }

  const order = avatarGenerationService.getOrder(orderId);
  if (!order) {
    return c.json({ error: "order_not_found" }, 404);
  }
  if (order.agentId !== agent.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  return c.json(toAvatarOrderResponse(order));
});

api.get("/avatar/orders", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const orders = avatarGenerationService
    .getOrdersForAgent(agent.id)
    .slice(0, 20)
    .map((order) => toAvatarOrderResponse(order));

  return c.json({ orders });
});

api.post("/avatar/assign", async (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: { order_id?: string; glb_url?: string; avatar_height?: number | string };
  try {
    body = await c.req.json<{
      order_id?: string;
      glb_url?: string;
    }>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const orderId = body.order_id?.trim();
  const glbUrlFromBody = body.glb_url?.trim();
  const parsedAvatarHeight = parseAvatarHeight(body.avatar_height);
  if (body.avatar_height !== undefined && parsedAvatarHeight === null) {
    return c.json(
      {
        error: "invalid_avatar_height",
        details: `avatar_height must be between ${MIN_AVATAR_HEIGHT} and ${MAX_AVATAR_HEIGHT}`,
      },
      400
    );
  }

  if (!orderId && !glbUrlFromBody) {
    return c.json({ error: "order_id_or_glb_url_required" }, 400);
  }
  if (orderId && glbUrlFromBody) {
    return c.json({ error: "provide_only_one_of_order_id_or_glb_url" }, 400);
  }

  let finalGlbUrl: string | null = null;
  let sourceOrderId: string | null = null;
  let finalAvatarHeight: number | null = parsedAvatarHeight ?? null;

  if (orderId) {
    const order = avatarGenerationService.getOrder(orderId);
    if (!order) {
      return c.json({ error: "order_not_found" }, 404);
    }
    if (order.agentId !== agent.id) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (order.status !== "complete" || !order.storedGlbUrl) {
      return c.json({ error: "order_not_ready", status: order.status }, 409);
    }
    finalGlbUrl = order.storedGlbUrl;
    sourceOrderId = order.id;
    if (finalAvatarHeight === null) {
      finalAvatarHeight = order.avatarHeightMeters;
    }
  } else if (glbUrlFromBody) {
    if (glbUrlFromBody.length > MAX_AVATAR_GLB_URL) {
      return c.json({ error: "glb_url_too_long", max: MAX_AVATAR_GLB_URL }, 400);
    }
    if (
      !glbUrlFromBody.startsWith("/generated-avatars/") &&
      !glbUrlFromBody.startsWith("http://") &&
      !glbUrlFromBody.startsWith("https://")
    ) {
      return c.json({ error: "invalid_glb_url" }, 400);
    }
    finalGlbUrl = glbUrlFromBody;
  }

  if (!finalGlbUrl) {
    return c.json({ error: "invalid_glb_url" }, 400);
  }

  const assignment = state.setAgentAvatar(
    agent,
    finalGlbUrl,
    sourceOrderId ?? undefined,
    finalAvatarHeight ?? undefined
  );
  return c.json({
    ok: true,
    assignment: {
      bot_name: assignment.botName,
      glb_url: assignment.avatarGlbUrl,
      avatar_height: assignment.avatarHeight,
      assigned_at: assignment.assignedAt,
      source_order_id: assignment.sourceOrderId,
    },
  });
});

api.get("/avatar/me", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const assignment = state.getAgentAvatarAssignment(agent.id);
  const activeOrder = avatarGenerationService.getActiveOrderForAgent(agent.id);
  const latestOrder = avatarGenerationService.getOrdersForAgent(agent.id)[0] ?? null;

  return c.json({
    bot_name: agent.name,
    assignment: assignment
      ? {
          glb_url: assignment.avatarGlbUrl,
          avatar_height: assignment.avatarHeight,
          assigned_at: assignment.assignedAt,
          source_order_id: assignment.sourceOrderId,
        }
      : null,
    active_order: activeOrder ? toAvatarOrderResponse(activeOrder) : null,
    latest_order: latestOrder ? toAvatarOrderResponse(latestOrder) : null,
  });
});

api.delete("/avatar/assign", (c) => {
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const removed = state.clearAgentAvatar(agent.id);
  return c.json({ ok: true, removed });
});

// --- Wallet config (public, returns non-secret project ID) ---

api.get("/config/wallet", (c) => {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID || process.env.WALLETCONNECT_PROJECTID || null;
  return c.json({ projectId });
});

// --- Wallet auth (B3) ---

api.get("/auth/nonce", (c) => {
  const nonce = generateNonce();
  return c.json({ nonce });
});

api.post("/auth/verify", async (c) => {
  let body: { address?: string; signature?: string; nonce?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const address = body.address?.trim();
  const signature = body.signature?.trim();
  const nonce = body.nonce?.trim();

  if (!address || !signature || !nonce) {
    return c.json({ error: "missing_fields", details: "address, signature, and nonce are required" }, 400);
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "invalid_address" }, 400);
  }

  if (!consumeNonce(nonce)) {
    return c.json({ error: "invalid_nonce", details: "Nonce expired, already used, or not found" }, 400);
  }

  const message = buildSignMessage(nonce);
  let recovered: string;
  try {
    recovered = recoverAddress(message, signature);
  } catch {
    return c.json({ error: "invalid_signature" }, 400);
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return c.json({ error: "signature_mismatch" }, 401);
  }

  const token = createSession(recovered);
  return c.json({ token, address: recovered });
});

// --- Agent ownership claim (B4) ---

api.post("/agents/:id/claim", async (c) => {
  // Requires both agent auth (Bearer token) and wallet session (X-Session-Token)
  const agent = getAgentFromAuthHeader(c.req.header("Authorization"));
  if (!agent) {
    return c.json({ error: "unauthorized", details: "Valid agent Bearer token required" }, 401);
  }

  const sessionToken = c.req.header("X-Session-Token");
  if (!sessionToken) {
    return c.json({ error: "wallet_session_required", details: "X-Session-Token header required" }, 401);
  }

  const walletAddress = getSessionAddress(sessionToken);
  if (!walletAddress) {
    return c.json({ error: "invalid_session", details: "Wallet session expired or invalid" }, 401);
  }

  // Verify the route param matches the authenticated agent
  const targetId = c.req.param("id");
  if (targetId !== agent.id) {
    return c.json({ error: "forbidden", details: "Can only claim your own agent" }, 403);
  }

  // Check existing ownership
  if (agent.ownerAddress && agent.ownerAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return c.json({
      error: "already_owned",
      details: "Agent is already owned by a different wallet",
      owner: agent.ownerAddress,
    }, 409);
  }

  // Set ownership
  agent.ownerAddress = walletAddress.toLowerCase();
  return c.json({
    ok: true,
    agent_id: agent.id,
    agent_name: agent.name,
    owner_address: agent.ownerAddress,
  });
});

// --- Admin reset ---

api.post("/admin/reset", (c) => {
  const providedAdminKey = c.req.header("x-admin-key");
  const adminKeyConfigured = getAdminKey() !== null;
  if (!adminKeyConfigured) {
    return c.json(
      {
        error: "admin_key_not_configured",
        details: "Set RESET_ADMIN_KEY (or ACTIVITY_ADMIN_KEY) to enable /api/admin/reset",
      },
      503
    );
  }
  if (!hasValidAdminKey(providedAdminKey)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const reset = state.resetRuntimeState();
  return c.json({
    ok: true,
    ...reset,
    epoch_started: state.getContext().epochStarted,
  });
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

      // Send initial music placement snapshot
      try {
        const musicSnapshot = state.getMusicPlacementSnapshot();
        controller.enqueue(
          encoder.encode(`event: music_placement_snapshot\ndata: ${JSON.stringify(musicSnapshot)}\n\n`)
        );
      } catch { /* ignore */ }

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
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",       // Disable proxy buffering (Fly/nginx)
    },
  });
});

// --- Skills API ---

const SKILLS_DIR = ".claude/skills";

function stripFrontmatter(content: string): { name: string; description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: content };
  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim() ?? "",
    description: descMatch?.[1]?.trim() ?? "",
    body: body.trimStart(),
  };
}

api.get("/skills", async (c) => {
  try {
    const glob = new Bun.Glob("*/SKILL.md");
    const skills: Array<{ name: string; description: string; files: string[] }> = [];
    for await (const path of glob.scan({ cwd: SKILLS_DIR })) {
      const dirName = path.split("/")[0] ?? path;
      const content = await Bun.file(`${SKILLS_DIR}/${path}`).text();
      const { name, description } = stripFrontmatter(content);
      // Find auxiliary files in this skill directory
      const files = ["SKILL.md"];
      const auxGlob = new Bun.Glob("*.md");
      for await (const auxPath of auxGlob.scan({ cwd: `${SKILLS_DIR}/${dirName}` })) {
        if (auxPath !== "SKILL.md") files.push(auxPath);
      }
      // Check references/ subdirectory
      const refGlob = new Bun.Glob("references/*.md");
      for await (const refPath of refGlob.scan({ cwd: `${SKILLS_DIR}/${dirName}` })) {
        files.push(refPath);
      }
      skills.push({ name: name || dirName, description, files });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return c.json(skills);
  } catch {
    return c.json([], 500);
  }
});

api.get("/skills/:name", async (c) => {
  const skillName = c.req.param("name").trim();
  const rawFileParam = (c.req.query("file") || "SKILL").trim();

  // Skill directory guard
  if (!/^[a-zA-Z0-9._-]+$/.test(skillName)) {
    return c.json({ error: "Invalid skill name or file" }, 400);
  }
  if (!rawFileParam || rawFileParam.includes("\\")) {
    return c.json({ error: "Invalid skill name or file" }, 400);
  }

  // Allow nested markdown paths (for example references/strudel-patterns.md)
  // while preventing traversal outside the skill directory.
  const normalizedFileParam = pathPosix.normalize(rawFileParam);
  if (
    normalizedFileParam === "." ||
    normalizedFileParam === ".." ||
    normalizedFileParam.startsWith("../") ||
    normalizedFileParam.startsWith("/") ||
    normalizedFileParam.includes("/../")
  ) {
    return c.json({ error: "Invalid skill name or file" }, 400);
  }

  // Resolve file path — allow "SKILL" or "SKILL.md", "getting-started",
  // or nested refs like "references/strudel-patterns".
  const fileName = normalizedFileParam.endsWith(".md")
    ? normalizedFileParam
    : `${normalizedFileParam}.md`;
  if (!/^[a-zA-Z0-9._/-]+\.md$/.test(fileName)) {
    return c.json({ error: "Invalid skill name or file" }, 400);
  }

  const filePath = `${SKILLS_DIR}/${skillName}/${fileName}`;
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return c.json({ error: "Skill or file not found" }, 404);
    }
    const raw = await file.text();
    const { name, body } = stripFrontmatter(raw);
    return c.json({ name: name || skillName, file: fileName, content: body || raw });
  } catch {
    return c.json({ error: "Skill or file not found" }, 404);
  }
});

export { api };
