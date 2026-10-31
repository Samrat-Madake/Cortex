// packages/percept/src/providers/model-router.ts
import type {
  AnyProvider, DetectorProvider, ReidProvider, PoseProvider, ModelType, ProviderRuntime,
} from "./types.js";
import type { ModelId } from "../models/model-manifest.js";
import { LEVEL_REQUIREMENTS } from "../models/model-manifest.js";
import { writeStderr } from "@reflectworld/shared";

/**
 * Central registry and router for model providers.
 *
 * Responsibilities:
 * - Register named provider instances
 * - Route capability requests to the best available provider (with fallback)
 * - Manage provider lifecycle (initialize/dispose all)
 * - Report available capabilities and max perception level
 */
export interface ProviderStatus {
  name: string;
  type: ModelType;
  runtime: ProviderRuntime;
  ready: boolean;
  modelId?: ModelId;
}

export class ModelRouter {
  private providers = new Map<string, AnyProvider>();
  private routing = new Map<string, string[]>();

  /** Register a provider instance by its name. */
  register(provider: AnyProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Set the routing for a capability: ordered list of provider names (first ready wins). */
  setRouting(capability: string, providerNames: string[]): void {
    this.routing.set(capability, providerNames);
  }

  /** Resolve the best available DetectorProvider for a capability. */
  getDetector(capability: string): DetectorProvider | undefined {
    return this.resolve(capability, "detector") as DetectorProvider | undefined;
  }

  /** Resolve the best available ReidProvider for a capability. */
  getReidProvider(capability: string): ReidProvider | undefined {
    return this.resolve(capability, "reid") as ReidProvider | undefined;
  }

  /** Resolve the best available PoseProvider for a capability. */
  getPoseProvider(capability: string): PoseProvider | undefined {
    return this.resolve(capability, "pose") as PoseProvider | undefined;
  }

  /** Generic resolution: walk the fallback chain, return first ready provider of matching type. */
  private resolve(capability: string, expectedType: ModelType): AnyProvider | undefined {
    const chain = this.routing.get(capability);
    if (!chain) return undefined;

    for (const name of chain) {
      const provider = this.providers.get(name);
      if (provider && provider.type === expectedType && provider.isReady()) {
        return provider;
      }
    }
    return undefined;
  }

  /** Get all capabilities that have at least one ready provider. */
  getAvailableCapabilities(): string[] {
    const caps: string[] = [];
    for (const [capability, chain] of this.routing) {
      for (const name of chain) {
        const p = this.providers.get(name);
        if (p?.isReady()) {
          caps.push(capability);
          break;
        }
      }
    }
    return caps;
  }

  /** Check if a specific capability has a ready provider. */
  hasCapability(capability: string): boolean {
    return this.getAvailableCapabilities().includes(capability);
  }

  /** Compute max perception level from available capabilities. */
  getMaxLevel(): number {
    let maxLevel = 0;
    const caps = new Set(this.getAvailableCapabilities());
    for (const [levelStr, required] of Object.entries(LEVEL_REQUIREMENTS)) {
      const level = Number(levelStr);
      if (level === 0) continue;
      if (required.every((c) => caps.has(c))) {
        maxLevel = Math.max(maxLevel, level);
      }
    }
    return maxLevel;
  }

  /** Initialize all registered providers. Errors are logged but don't stop others. */
  async initializeAll(): Promise<void> {
    const entries = [...this.providers.entries()];
    const results = await Promise.allSettled(
      entries.map(([, p]) => p.initialize()),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        writeStderr(`[model-router] Failed to initialize provider "${entries[i]![0]}":`, result.reason);
      }
    }
  }

  /** Dispose all registered providers. */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.providers.values()].map((p) => p.dispose()),
    );
  }

  /** Get a provider by name (for direct access). */
  getProviderByName(name: string): AnyProvider | undefined {
    return this.providers.get(name);
  }

  /** Get a compact startup/reporting snapshot for all providers. */
  getProviderStatuses(): ProviderStatus[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      type: provider.type,
      runtime: provider.runtime,
      ready: provider.isReady(),
      modelId: (provider as unknown as { modelId?: ModelId }).modelId,
    }));
  }

  /** Get all registered provider names. */
  getRegisteredNames(): string[] {
    return [...this.providers.keys()];
  }
}
