import type { IncomingMessage, ServerResponse } from "node:http";
import { monitorBus } from "@reflectworld/shared";
import {
  VALID_CONFIG_KEYS,
  validateConfigValue,
} from "./dashboard-common.js";
import type {
  DashboardSessionScope,
  RuntimeConfig,
  RuntimeConfigKey,
} from "./dashboard-common.js";

export interface DashboardRuntimeConfigControllerOptions {
  sessionEnabled: () => boolean;
  requireDashboardSession: (
    req: IncomingMessage,
    res: ServerResponse,
    body?: Record<string, unknown>,
    url?: URL,
  ) => DashboardSessionScope | null;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readRequestBuffer: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
}

export class DashboardRuntimeConfigController {
  private readonly config: RuntimeConfig = {
    vlm_model: "auto",
    analysis_level: "auto",
    capture_mode: "stream",
    sampling_rate: "1",
    audio_model: "moonshine-tiny",
  };

  constructor(private readonly options: DashboardRuntimeConfigControllerOptions) {}

  getConfig(): Readonly<RuntimeConfig> {
    return this.config;
  }

  setValue(key: RuntimeConfigKey, value: string): void {
    if (VALID_CONFIG_KEYS.has(key)) {
      this.config[key] = value;
    }
  }

  handleGet(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(this.config));
  }

  async handlePost(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      const raw = await this.options.readRequestBuffer(req, 1024 * 1024);
      const payload = JSON.parse(raw.toString("utf8") || "{}") as { key?: string; value?: string } & Record<string, unknown>;
      const scope = this.options.requireDashboardSession(req, res, payload, url);
      if (this.options.sessionEnabled() && !scope) return;
      if (this.options.sessionEnabled() && !scope?.isAdmin) {
        this.options.sendJson(res, 403, { error: "Admin session is required" });
        return;
      }

      const key = payload.key as RuntimeConfigKey | undefined;
      const value = payload.value;

      if (!key || !VALID_CONFIG_KEYS.has(key as RuntimeConfigKey)) {
        this.options.sendJson(res, 400, { error: `Invalid key. Must be one of: ${[...VALID_CONFIG_KEYS].join(", ")}` });
        return;
      }
      if (typeof value !== "string") {
        this.options.sendJson(res, 400, { error: "value must be a string" });
        return;
      }

      const validationError = validateConfigValue(key as RuntimeConfigKey, value);
      if (validationError) {
        this.options.sendJson(res, 400, { error: validationError });
        return;
      }

      const previous = this.config[key as RuntimeConfigKey];
      this.config[key as RuntimeConfigKey] = value;

      monitorBus.publish("system:config_changed" as import("@reflectworld/shared").MonitorEventType, {
        key,
        value,
        previous,
      });

      this.options.sendJson(res, 200, { ok: true, key, value, previous });
    } catch {
      this.options.sendJson(res, 400, { error: "Invalid JSON body" });
    }
  }

  handleOptions(res: ServerResponse): void {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
  }
}
