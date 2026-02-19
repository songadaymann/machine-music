import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath } from "url";

const MESHY_BASE_URL = "https://api.meshy.ai";
const GENERATED_DIR_URL = new URL(
  "../public/generated-world-objects/",
  import.meta.url
);
const GENERATED_DIR = fileURLToPath(GENERATED_DIR_URL);

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 180; // 15 minutes
const MAX_ACTIVE_PER_AGENT = 1;
const MAX_GLOBAL_CONCURRENT = 5;

type MeshyTaskStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export type WorldObjectOrderStatus =
  | "queued"
  | "generating_preview"
  | "generating_texture"
  | "downloading"
  | "complete"
  | "failed";

export interface WorldObjectOrder {
  id: string;
  agentId: string;
  agentName: string;
  prompt: string;
  texturePrompt: string | null;
  status: WorldObjectOrderStatus;
  progress: number;
  error: string | null;
  meshyPreviewTaskId: string | null;
  meshyRefineTaskId: string | null;
  meshyRefinedGlbUrl: string | null;
  storedGlbUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorldObjectOrderCreateInput {
  agentId: string;
  agentName: string;
  prompt: string;
  texturePrompt?: string;
}

interface MeshyTaskCreateResponse {
  result?: string;
}

interface MeshyTask {
  id?: string;
  status?: string;
  progress?: number;
  model_urls?: Record<string, unknown>;
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

function getMeshyApiKey(): string | null {
  const key = process.env.MESHY_API_KEY;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

class WorldObjectGenerationService {
  private orders: Map<string, WorldObjectOrder> = new Map();
  private activeByAgentId: Map<string, string> = new Map();
  private globalActiveCount = 0;
  private listeners: Set<(order: WorldObjectOrder) => void> = new Set();

  isConfigured(): boolean {
    return getMeshyApiKey() !== null;
  }

  addListener(listener: (order: WorldObjectOrder) => void) {
    this.listeners.add(listener);
  }

  removeListener(listener: (order: WorldObjectOrder) => void) {
    this.listeners.delete(listener);
  }

  getOrder(orderId: string): WorldObjectOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    return { ...order };
  }

  getOrdersForAgent(agentId: string): WorldObjectOrder[] {
    return Array.from(this.orders.values())
      .filter((order) => order.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((order) => ({ ...order }));
  }

  getActiveOrderForAgent(agentId: string): WorldObjectOrder | null {
    const activeOrderId = this.activeByAgentId.get(agentId);
    if (!activeOrderId) return null;
    return this.getOrder(activeOrderId);
  }

  getGlobalActiveCount(): number {
    return this.globalActiveCount;
  }

  createOrder(input: WorldObjectOrderCreateInput): WorldObjectOrder {
    if (!this.isConfigured()) {
      throw new Error("meshy_not_configured");
    }
    if (this.activeByAgentId.has(input.agentId)) {
      throw new Error("generation_in_progress");
    }
    if (this.globalActiveCount >= MAX_GLOBAL_CONCURRENT) {
      throw new Error("global_generation_limit");
    }

    const nowIso = new Date().toISOString();
    const order: WorldObjectOrder = {
      id: randomUUID(),
      agentId: input.agentId,
      agentName: input.agentName,
      prompt: input.prompt,
      texturePrompt: input.texturePrompt ?? null,
      status: "queued",
      progress: 0,
      error: null,
      meshyPreviewTaskId: null,
      meshyRefineTaskId: null,
      meshyRefinedGlbUrl: null,
      storedGlbUrl: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };

    this.orders.set(order.id, order);
    this.activeByAgentId.set(order.agentId, order.id);
    this.globalActiveCount++;
    this.emit(order);

    void this.processOrder(order.id);

    return { ...order };
  }

  private emit(order: WorldObjectOrder) {
    for (const listener of this.listeners) {
      try {
        listener({ ...order });
      } catch {
        // Keep the pipeline resilient
      }
    }
  }

  private updateOrder(orderId: string, patch: Partial<WorldObjectOrder>) {
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
      // Step 1: Preview generation
      this.updateOrder(order.id, {
        status: "generating_preview",
        progress: 5,
        error: null,
      });

      const previewTaskId = await this.createTextPreviewTask(order.prompt);
      this.updateOrder(order.id, { meshyPreviewTaskId: previewTaskId });

      await this.pollTask({
        path: `/openapi/v2/text-to-3d/${previewTaskId}`,
        orderId: order.id,
        status: "generating_preview",
        progressMin: 5,
        progressMax: 40,
      });

      // Step 2: Refine (texture)
      this.updateOrder(order.id, {
        status: "generating_texture",
        progress: 41,
      });

      const refineTaskId = await this.createTextRefineTask(
        previewTaskId,
        order.texturePrompt
      );
      this.updateOrder(order.id, { meshyRefineTaskId: refineTaskId });

      const refineTask = await this.pollTask({
        path: `/openapi/v2/text-to-3d/${refineTaskId}`,
        orderId: order.id,
        status: "generating_texture",
        progressMin: 41,
        progressMax: 85,
      });

      const refinedGlbUrl =
        this.extractModelGlbUrl(refineTask) ??
        this.extractModelGlbUrl(await this.getTextTask(refineTaskId));
      if (!refinedGlbUrl) {
        throw new Error("refine_task_missing_glb_url");
      }
      this.updateOrder(order.id, {
        meshyRefinedGlbUrl: refinedGlbUrl,
        status: "downloading",
        progress: 90,
      });

      // Step 3: Download (no rigging for world objects)
      const storedGlbUrl = await this.downloadGlb(order.id, refinedGlbUrl);
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
          : "world_object_generation_failed";
      this.updateOrder(order.id, {
        status: "failed",
        error: message,
      });
    } finally {
      this.activeByAgentId.delete(order.agentId);
      this.globalActiveCount = Math.max(0, this.globalActiveCount - 1);
    }
  }

  private async createTextPreviewTask(prompt: string): Promise<string> {
    const response = await this.meshyRequest<MeshyTaskCreateResponse>(
      "POST",
      "/openapi/v2/text-to-3d",
      {
        mode: "preview",
        prompt,
        ai_model: "meshy-6",
        topology: "triangle",
        target_polycount: 10000,
      }
    );
    const taskId = asNonEmptyString(response.result);
    if (!taskId) throw new Error("meshy_preview_task_create_failed");
    return taskId;
  }

  private async createTextRefineTask(
    previewTaskId: string,
    texturePrompt: string | null
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      mode: "refine",
      preview_task_id: previewTaskId,
      enable_pbr: true,
    };
    if (texturePrompt) {
      payload.texture_prompt = texturePrompt;
    }
    const response = await this.meshyRequest<MeshyTaskCreateResponse>(
      "POST",
      "/openapi/v2/text-to-3d",
      payload
    );
    const taskId = asNonEmptyString(response.result);
    if (!taskId) throw new Error("meshy_refine_task_create_failed");
    return taskId;
  }

  private async getTextTask(taskId: string): Promise<MeshyTask> {
    return this.meshyRequest<MeshyTask>(
      "GET",
      `/openapi/v2/text-to-3d/${taskId}`
    );
  }

  private extractModelGlbUrl(task: MeshyTask): string | null {
    if (!isRecord(task.model_urls)) return null;
    return asNonEmptyString(task.model_urls.glb);
  }

  private extractTaskError(task: MeshyTask): string | null {
    if (!isRecord(task.task_error)) return null;
    return asNonEmptyString(task.task_error.message);
  }

  private async pollTask(params: {
    path: string;
    orderId: string;
    status: WorldObjectOrderStatus;
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
        params.progressMin +
        Math.round(
          (params.progressMax - params.progressMin) * (progressValue / 100)
        );
      this.updateOrder(params.orderId, {
        status: params.status,
        progress: clampProgress(mappedProgress),
      });

      if (status === "SUCCEEDED") {
        return task;
      }
      if (status === "FAILED" || status === "CANCELED") {
        throw new Error(
          this.extractTaskError(task) ?? `meshy_task_${status.toLowerCase()}`
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("meshy_task_timeout");
  }

  private async downloadGlb(
    orderId: string,
    sourceUrl: string
  ): Promise<string> {
    await mkdir(GENERATED_DIR, { recursive: true });

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `object_download_failed_${response.status}:${text.slice(0, 300)}`
      );
    }

    const bytes = await response.arrayBuffer();
    const filename = `${orderId}.glb`;
    const outputPath = join(GENERATED_DIR, filename);
    await writeFile(outputPath, Buffer.from(bytes));
    return `/generated-world-objects/${filename}`;
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

export const worldObjectGenerationService =
  new WorldObjectGenerationService();
