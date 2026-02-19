import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

const MESHY_BASE_URL = "https://api.meshy.ai";
const GENERATED_AVATAR_DIR_URL = new URL("../public/generated-avatars/", import.meta.url);
const GENERATED_AVATAR_DIR = fileURLToPath(GENERATED_AVATAR_DIR_URL);

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180; // 15 minutes
const DEFAULT_AVATAR_HEIGHT_METERS = 1.7;
const MIN_AVATAR_HEIGHT_METERS = 0.8;
const MAX_AVATAR_HEIGHT_METERS = 3.2;

type MeshyTaskStatus = "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type AvatarOrderStatus =
  | "queued"
  | "generating_preview"
  | "generating_texture"
  | "rigging"
  | "downloading"
  | "complete"
  | "failed";

export interface AvatarOrder {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  texturePrompt: string | null;
  avatarHeightMeters: number;
  status: AvatarOrderStatus;
  progress: number;
  error: string | null;
  meshyPreviewTaskId: string | null;
  meshyRefineTaskId: string | null;
  meshyRigTaskId: string | null;
  meshyRefinedGlbUrl: string | null;
  meshyRiggedGlbUrl: string | null;
  storedGlbUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AvatarOrderCreateInput {
  agentId: string;
  agentName: string;
  prompt: string;
  texturePrompt?: string;
  avatarHeightMeters?: number;
}

interface MeshyTaskCreateResponse {
  result?: string;
}

interface MeshyTask {
  id?: string;
  status?: string;
  progress?: number;
  model_urls?: Record<string, unknown>;
  result?: Record<string, unknown>;
  task_error?: {
    message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function normalizeTaskStatus(value: unknown): MeshyTaskStatus | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  if (
    upper === "PENDING" ||
    upper === "IN_PROGRESS" ||
    upper === "SUCCEEDED" ||
    upper === "FAILED" ||
    upper === "CANCELED"
  ) {
    return upper;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAvatarHeightMeters(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AVATAR_HEIGHT_METERS;
  }
  if (value < MIN_AVATAR_HEIGHT_METERS) return MIN_AVATAR_HEIGHT_METERS;
  if (value > MAX_AVATAR_HEIGHT_METERS) return MAX_AVATAR_HEIGHT_METERS;
  return Math.round(value * 100) / 100;
}

function getMeshyApiKey(): string | null {
  const key = process.env.MESHY_API_KEY;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

class AvatarGenerationService {
  private orders: Map<string, AvatarOrder> = new Map();
  private activeByAgentId: Map<string, string> = new Map();
  private listeners: Set<(order: AvatarOrder) => void> = new Set();

  isConfigured(): boolean {
    return getMeshyApiKey() !== null;
  }

  addListener(listener: (order: AvatarOrder) => void) {
    this.listeners.add(listener);
  }

  removeListener(listener: (order: AvatarOrder) => void) {
    this.listeners.delete(listener);
  }

  getOrder(orderId: string): AvatarOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    return { ...order };
  }

  getOrdersForAgent(agentId: string): AvatarOrder[] {
    return Array.from(this.orders.values())
      .filter((order) => order.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((order) => ({ ...order }));
  }

  getActiveOrderForAgent(agentId: string): AvatarOrder | null {
    const activeOrderId = this.activeByAgentId.get(agentId);
    if (!activeOrderId) return null;
    return this.getOrder(activeOrderId);
  }

  createOrder(input: AvatarOrderCreateInput): AvatarOrder {
    if (!this.isConfigured()) {
      throw new Error("meshy_not_configured");
    }
    if (this.activeByAgentId.has(input.agentId)) {
      throw new Error("avatar_generation_in_progress");
    }

    const avatarHeightMeters = normalizeAvatarHeightMeters(input.avatarHeightMeters);
    const nowIso = new Date().toISOString();
    const order: AvatarOrder = {
      id: randomUUID(),
      agentId: input.agentId,
      agentName: input.agentName,
      prompt: input.prompt,
      texturePrompt: input.texturePrompt ?? null,
      avatarHeightMeters,
      status: "queued",
      progress: 0,
      error: null,
      meshyPreviewTaskId: null,
      meshyRefineTaskId: null,
      meshyRigTaskId: null,
      meshyRefinedGlbUrl: null,
      meshyRiggedGlbUrl: null,
      storedGlbUrl: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };

    this.orders.set(order.id, order);
    this.activeByAgentId.set(order.agentId, order.id);
    this.emit(order);

    void this.processOrder(order.id);

    return { ...order };
  }

  private emit(order: AvatarOrder) {
    for (const listener of this.listeners) {
      try {
        listener({ ...order });
      } catch {
        // Keep the pipeline resilient even if one subscriber fails.
      }
    }
  }

  private updateOrder(orderId: string, patch: Partial<AvatarOrder>) {
    const current = this.orders.get(orderId);
    if (!current) return;
    Object.assign(current, patch);
    current.updatedAt = new Date().toISOString();
    this.emit(current);
  }

  private async processOrder(orderId: string) {
    const order = this.orders.get(orderId);
    if (!order) return;

    try {
      this.updateOrder(order.id, { status: "generating_preview", progress: 5, error: null });

      const previewTaskId = await this.createTextPreviewTask(order.prompt);
      this.updateOrder(order.id, { meshyPreviewTaskId: previewTaskId });

      await this.pollTask({
        path: `/openapi/v2/text-to-3d/${previewTaskId}`,
        orderId: order.id,
        status: "generating_preview",
        progressMin: 5,
        progressMax: 35,
      });

      this.updateOrder(order.id, { status: "generating_texture", progress: 36 });

      const refineTaskId = await this.createTextRefineTask(previewTaskId, order.texturePrompt);
      this.updateOrder(order.id, { meshyRefineTaskId: refineTaskId });

      const refineTask = await this.pollTask({
        path: `/openapi/v2/text-to-3d/${refineTaskId}`,
        orderId: order.id,
        status: "generating_texture",
        progressMin: 36,
        progressMax: 70,
      });

      const refinedGlbUrl =
        this.extractModelGlbUrl(refineTask) ?? this.extractModelGlbUrl(await this.getTextTask(refineTaskId));
      if (!refinedGlbUrl) {
        throw new Error("refine_task_missing_glb_url");
      }
      this.updateOrder(order.id, { meshyRefinedGlbUrl: refinedGlbUrl, status: "rigging", progress: 71 });

      const rigTaskId = await this.createRiggingTask(refineTaskId, order.avatarHeightMeters);
      this.updateOrder(order.id, { meshyRigTaskId: rigTaskId });

      const rigTask = await this.pollTask({
        path: `/openapi/v1/rigging/${rigTaskId}`,
        orderId: order.id,
        status: "rigging",
        progressMin: 71,
        progressMax: 94,
      });

      const riggedGlbUrl = this.extractRiggedGlbUrl(rigTask);
      if (!riggedGlbUrl) {
        throw new Error("rig_task_missing_glb_url");
      }

      this.updateOrder(order.id, {
        meshyRiggedGlbUrl: riggedGlbUrl,
        status: "downloading",
        progress: 95,
      });

      const storedGlbUrl = await this.downloadRiggedGlb(order.id, riggedGlbUrl);
      this.updateOrder(order.id, {
        status: "complete",
        progress: 100,
        storedGlbUrl,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.slice(0, 1000)
          : "avatar_generation_failed";
      this.updateOrder(order.id, {
        status: "failed",
        error: message,
      });
    } finally {
      this.activeByAgentId.delete(order.agentId);
    }
  }

  private async createTextPreviewTask(prompt: string): Promise<string> {
    const response = await this.meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v2/text-to-3d", {
      mode: "preview",
      prompt,
      ai_model: "meshy-6",
      pose_mode: "t-pose",
      topology: "triangle",
      target_polycount: 10000,
      should_remesh: true,
    });
    const taskId = asNonEmptyString(response.result);
    if (!taskId) throw new Error("meshy_preview_task_create_failed");
    return taskId;
  }

  private async createTextRefineTask(previewTaskId: string, texturePrompt: string | null): Promise<string> {
    const payload: Record<string, unknown> = {
      mode: "refine",
      preview_task_id: previewTaskId,
      enable_pbr: true,
    };
    if (texturePrompt) {
      payload.texture_prompt = texturePrompt;
    }
    const response = await this.meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v2/text-to-3d", payload);
    const taskId = asNonEmptyString(response.result);
    if (!taskId) throw new Error("meshy_refine_task_create_failed");
    return taskId;
  }

  private async getTextTask(taskId: string): Promise<MeshyTask> {
    return this.meshyRequest<MeshyTask>("GET", `/openapi/v2/text-to-3d/${taskId}`);
  }

  private async createRiggingTask(inputTaskId: string, avatarHeightMeters: number): Promise<string> {
    const response = await this.meshyRequest<MeshyTaskCreateResponse>("POST", "/openapi/v1/rigging", {
      input_task_id: inputTaskId,
      height_meters: normalizeAvatarHeightMeters(avatarHeightMeters),
    });
    const taskId = asNonEmptyString(response.result);
    if (!taskId) throw new Error("meshy_rig_task_create_failed");
    return taskId;
  }

  private extractModelGlbUrl(task: MeshyTask): string | null {
    if (!isRecord(task.model_urls)) return null;
    return asNonEmptyString(task.model_urls.glb);
  }

  private extractRiggedGlbUrl(task: MeshyTask): string | null {
    if (!isRecord(task.result)) return null;
    const direct = asNonEmptyString(task.result.rigged_character_glb_url);
    if (direct) return direct;
    if (isRecord(task.result.basic_animations)) {
      const basicAnimGlb = asNonEmptyString(task.result.basic_animations.walking_glb_url);
      if (basicAnimGlb) return basicAnimGlb;
    }
    return null;
  }

  private extractTaskError(task: MeshyTask): string | null {
    if (!isRecord(task.task_error)) return null;
    return asNonEmptyString(task.task_error.message);
  }

  private async pollTask(params: {
    path: string;
    orderId: string;
    status: AvatarOrderStatus;
    progressMin: number;
    progressMax: number;
  }): Promise<MeshyTask> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const task = await this.meshyRequest<MeshyTask>("GET", params.path);
      const status = normalizeTaskStatus(task.status);
      const progressValue =
        typeof task.progress === "number"
          ? clampProgress(task.progress)
          : attempt === 0
            ? 0
            : 50;
      const mappedProgress =
        params.progressMin + Math.round((params.progressMax - params.progressMin) * (progressValue / 100));
      this.updateOrder(params.orderId, {
        status: params.status,
        progress: clampProgress(mappedProgress),
      });

      if (status === "SUCCEEDED") {
        return task;
      }
      if (status === "FAILED" || status === "CANCELED") {
        throw new Error(this.extractTaskError(task) ?? `meshy_task_${status.toLowerCase()}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("meshy_task_timeout");
  }

  private async downloadRiggedGlb(orderId: string, sourceUrl: string): Promise<string> {
    await mkdir(GENERATED_AVATAR_DIR, { recursive: true });

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`avatar_download_failed_${response.status}:${text.slice(0, 300)}`);
    }

    const bytes = await response.arrayBuffer();
    const filename = `${orderId}.glb`;
    const outputPath = join(GENERATED_AVATAR_DIR, filename);
    await writeFile(outputPath, Buffer.from(bytes));
    return `/generated-avatars/${filename}`;
  }

  private async meshyRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const apiKey = getMeshyApiKey();
    if (!apiKey) {
      throw new Error("meshy_not_configured");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    let payload: string | undefined;
    if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${MESHY_BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`meshy_http_${response.status}:${text.slice(0, 500)}`);
    }

    return response.json() as Promise<T>;
  }
}

export const avatarGenerationService = new AvatarGenerationService();
