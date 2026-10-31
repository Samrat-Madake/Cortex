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
  stateDir?: string;
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
  private readonly pluginConfigs: Record<string, Record<string, unknown>>;
  private readonly logger = createLogger("host");

  constructor(options?: HostOptions) {
    this.stateDir = options?.stateDir ?? resolveReflectWorldStateDir();
    this.pluginConfigs = options?.pluginConfigs ?? {};
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
  }

  /** Load and register a plugin module. */
  async loadPlugin(plugin: PluginModule): Promise<void> {
    const pluginStateDir = join(this.stateDir, plugin.id);
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

  /** Start all registered services. */
  async startServices(): Promise<void> {
    for (const [, svc] of this.services) {
      await svc.start();
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
