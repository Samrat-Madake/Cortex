/**
 * Minimal OpenClaw host — implements OpenClawPluginApi,
 * loads plugins, and exposes registered tools.
 */
import type {
  OpenClawPluginApi,
  AnyAgentTool,
  PluginRuntime,
  PluginLogger,
  PluginService,
  ToolFactory,
} from "@reflectworld/shared";
import { resolveReflectWorldStateDir } from "@reflectworld/shared";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PluginModule {
  id: string;
  name: string;
  description?: string;
  register(api: OpenClawPluginApi): void | Promise<void>;
}

export interface HostOptions {
  homeDir?: string;
  stateDir?: string;
  /** When true, plugins use stateDir directly instead of stateDir/<pluginId>. */
  flatStateDir?: boolean;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

const createLogger = (name: string): PluginLogger => ({
  info: (msg, ...args) => console.log(`[${name}]`, msg, ...args),
  warn: (msg, ...args) => console.warn(`[${name}]`, msg, ...args),
  error: (msg, ...args) => console.error(`[${name}]`, msg, ...args),
  debug: (msg, ...args) => console.debug(`[${name}]`, msg, ...args),
});

export class MiniHost {
  private tools = new Map<string, AnyAgentTool>();
  private services = new Map<string, PluginService>();
  private readonly stateDir: string;
  private readonly flatStateDir: boolean;
  private readonly pluginConfigs: Record<string, Record<string, unknown>>;
  private readonly logger = createLogger("host");

  constructor(options?: HostOptions) {
    this.stateDir = options?.stateDir ?? resolveReflectWorldStateDir();
    this.flatStateDir = options?.flatStateDir ?? false;
    this.pluginConfigs = options?.pluginConfigs ?? {};
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
  }

  /** Load and register a plugin module. */
  async loadPlugin(plugin: PluginModule): Promise<void> {
    const pluginStateDir = this.flatStateDir ? this.stateDir : join(this.stateDir, plugin.id);
    if (!existsSync(pluginStateDir)) mkdirSync(pluginStateDir, { recursive: true });

    const runtime: PluginRuntime = {
      system: { enqueueSystemEvent: (text) => this.logger.info(`[system-event] ${text}`) },
      logging: { getChildLogger: (name) => createLogger(`${plugin.id}:${name}`) },
      state: { resolveStateDir: () => pluginStateDir },
      config: { loadConfig: () => this.pluginConfigs[plugin.id] ?? {} },
      channel: {
        discord: { sendMessageDiscord: async () => this.logger.warn("[mini-host] Discord send not available") },
        telegram: { sendMessageTelegram: async () => this.logger.warn("[mini-host] Telegram send not available") },
        slack: { sendMessageSlack: async () => this.logger.warn("[mini-host] Slack send not available") },
      },
      subagent: { run: async () => ({ runId: "mini-host-noop" }) },
    };

    const api: OpenClawPluginApi = {
      id: plugin.id,
      name: plugin.name,
      runtime,
      logger: createLogger(plugin.id),
      pluginConfig: this.pluginConfigs[plugin.id],
      registerTool: (toolOrFactory: AnyAgentTool | ToolFactory) => {
        if (typeof toolOrFactory === "function") {
          // ToolFactory — invoke with no session context in standalone mode
          const tool = toolOrFactory(undefined as any);
          this.tools.set(tool.name, tool);
          this.logger.info(`Registered tool: ${tool.name}`);
        } else {
          this.tools.set(toolOrFactory.name, toolOrFactory);
          this.logger.info(`Registered tool: ${toolOrFactory.name}`);
        }
      },
      registerChannel: () => {},
      registerHttpRoute: () => {},
      registerService: (svc) => {
        this.services.set(svc.id, svc);
        this.logger.info(`Registered service: ${svc.id}`);
      },
      on: () => {},
    };

    await plugin.register(api);
    this.logger.info(`Loaded plugin: ${plugin.name} (${plugin.id})`);
  }

  /** Call a registered tool by name. */
  async callTool(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return tool.execute(toolCallId, params);
  }

  /** List all registered tools. */
  listTools(): { name: string; description: string }[] {
    return [...this.tools.values()].map(t => ({ name: t.name, description: t.description }));
  }

  /** Service startup status for health reporting. */
  private serviceStatus = new Map<string, "pending" | "starting" | "running" | "failed">();
  private serviceErrors = new Map<string, string>();

  /** Get startup status for all services. */
  getServiceStatus(): Record<string, { status: string; error?: string }> {
    const result: Record<string, { status: string; error?: string }> = {};
    for (const [id] of this.services) {
      const status = this.serviceStatus.get(id) ?? "pending";
      const error = this.serviceErrors.get(id);
      result[id] = error ? { status, error } : { status };
    }
    return result;
  }

  /** Overall health: "starting" if any pending/starting, "ready" if all running, "degraded" if any failed. */
  getHealthStatus(): "starting" | "ready" | "degraded" {
    let hasStarting = false;
    let hasFailed = false;
    for (const [id] of this.services) {
      const s = this.serviceStatus.get(id) ?? "pending";
      if (s === "pending" || s === "starting") hasStarting = true;
      if (s === "failed") hasFailed = true;
    }
    if (hasStarting) return "starting";
    if (hasFailed) return "degraded";
    return "ready";
  }

  /** Start a single service by id. */
  async startService(id: string): Promise<void> {
    const svc = this.services.get(id);
    if (!svc) throw new Error(`Service not found: ${id}`);
    this.serviceStatus.set(id, "starting");
    try {
      await svc.start();
      this.serviceStatus.set(id, "running");
      this.serviceErrors.delete(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.serviceStatus.set(id, "failed");
      this.serviceErrors.set(id, msg);
      throw err;
    }
  }

  /** Start all registered services. */
  async startServices(opts?: {
    exclude?: string[];
    continueOnError?: boolean;
  }): Promise<void> {
    const exclude = new Set(opts?.exclude ?? []);
    for (const [id] of this.services) {
      if (exclude.has(id)) continue;
      try {
        await this.startService(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Service ${id} failed to start: ${msg}`);
        if (!opts?.continueOnError) throw err;
      }
    }
  }

  /** Stop all registered services (error-isolated: all services attempted). */
  async stopServices(): Promise<void> {
    const services = [...this.services.values()].reverse();
    const errors: Array<{ id: string; error: Error }> = [];
    for (const svc of services) {
      try {
        await svc.stop?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push({ id: svc.id, error });
        this.logger.error(`Service ${svc.id} stop failed: ${error.message}`);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map((e) => e.error),
        `${errors.length} service(s) failed to stop: ${errors.map((e) => e.id).join(", ")}`,
      );
    }
  }
}
