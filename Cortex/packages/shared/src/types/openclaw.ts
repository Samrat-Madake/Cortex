// Minimal OpenClaw Plugin SDK type stubs.
// Replace with official types when openclaw publishes npm package.

export interface OpenClawPluginApi {
  id: string;
  name: string;
  runtime: PluginRuntime;
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: AnyAgentTool): void;
  registerTool(factory: ToolFactory): void;
  registerChannel(registration: { plugin: ChannelPlugin }): void;
  registerHttpRoute(params: {
    path: string;
    handler: HttpRouteHandler;
  }): void;
  registerService(service: PluginService): void;
  on(hookName: string, handler: (...args: unknown[]) => void): void;
}

/** Factory function that receives session context and returns a tool. */
export type ToolFactory = (ctx: ToolContext) => AnyAgentTool;

/** Context passed to ToolFactory by the OpenClaw runtime. */
export interface ToolContext {
  /** Session key identifying the originating channel + user (e.g. "discord:direct:123"). */
  sessionKey?: string;
}

export interface PluginRuntime {
  system: {
    enqueueSystemEvent(
      text: string,
      options?: { sessionKey?: string },
    ): void;
    requestHeartbeatNow?(opts?: {
      reason?: string;
      coalesceMs?: number;
    }): void;
  };
  logging: {
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(): string;
  };
  config: {
    loadConfig(): Record<string, unknown>;
  };
  channel: {
    discord: {
      sendMessageDiscord(to: string, text: string, opts?: Record<string, unknown>): Promise<void>;
    };
    telegram: {
      sendMessageTelegram(to: string, text: string, opts?: Record<string, unknown>): Promise<void>;
    };
    slack: {
      sendMessageSlack(to: string, text: string, opts?: Record<string, unknown>): Promise<void>;
    };
  };
  subagent: {
    run(params: Record<string, unknown>): Promise<{ runId: string }>;
  };
}

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

export interface AnyAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<string>;
}

export interface ChannelPlugin {
  id: string;
  meta: { name: string; description?: string };
  capabilities: Record<string, boolean>;
  config: ChannelConfigAdapter;
  gateway?: ChannelGatewayAdapter;
  outbound?: ChannelOutboundAdapter;
}

export interface ChannelConfigAdapter {
  resolveAccountConfig(config: Record<string, unknown>): unknown;
}

export interface ChannelGatewayAdapter {
  startAccount(ctx: GatewayContext): Promise<void>;
  stopAccount?(ctx: GatewayContext): Promise<void>;
}

export interface GatewayContext {
  account: unknown;
  config: unknown;
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  log: PluginLogger;
}

export interface ChannelOutboundAdapter {
  sendText?(
    ctx: unknown,
    text: string,
  ): Promise<{ messageId: string }>;
  sendMedia?(
    ctx: unknown,
    media: unknown,
  ): Promise<{ messageId: string }>;
}

export interface HttpRouteHandler {
  (req: unknown, res: unknown): void | Promise<void>;
}

export interface PluginService {
  id: string;
  start(): Promise<void>;
  stop?(): Promise<void>;
}
