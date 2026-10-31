import type {
  MonitorEvent,
  RuntimeHealthObservation,
  RuntimeHealthScope,
  RuntimeHealthStatus,
} from "@reflectworld/shared";

const MAX_RECENT_ERRORS = 50;
const RECENT_ERROR_TTL_MS = 60 * 60_000;
const STATUS_HEARTBEAT_MS = 60_000;
const MAX_LIFECYCLE_TOMBSTONES = 1_000;
const LIFECYCLE_TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

export interface DashboardComponentStatus {
  status_key: string;
  component: string;
  operation: string;
  capability: string;
  summary: string;
  status: RuntimeHealthStatus;
  observed_at: number;
  failure_count: number;
  code?: string;
  scope?: RuntimeHealthScope;
}

export interface DashboardOperationError extends DashboardComponentStatus {
  error_id: string;
}

export interface DashboardRuntimeHealthSnapshot {
  component_statuses: DashboardComponentStatus[];
  recent_operation_errors: DashboardOperationError[];
}

export interface DashboardRuntimeHealthRegistryOptions {
  publish: (event: MonitorEvent) => void;
}

type ProducerOrder = {
  epoch: string;
  sequence: number;
  observedAt: number;
  retiredEpochs: Set<string>;
};

export class DashboardRuntimeHealthRegistry {
  private readonly statuses = new Map<string, DashboardComponentStatus>();
  private readonly recentErrors: DashboardOperationError[] = [];
  private readonly producerOrders = new Map<string, ProducerOrder>();
  private readonly inactiveSources = new Map<string, number>();
  private readonly removedSessions = new Map<string, number>();

  constructor(private readonly options: DashboardRuntimeHealthRegistryOptions) {}

  observe(observation: RuntimeHealthObservation): void {
    if (!this.acceptLifecycle(observation)) return;
    if (!this.acceptOrder(observation)) return;
    const statusKey = buildStatusKey(observation);
    const previous = this.statuses.get(statusKey);
    if (previous && observation.observed_at < previous.observed_at) return;
    if (
      previous &&
      previous.status === observation.status &&
      previous.code === observation.code &&
      observation.observed_at - previous.observed_at < STATUS_HEARTBEAT_MS
    ) return;
    const capability = capabilityFor(observation.component, observation.operation);
    const status: DashboardComponentStatus = {
      status_key: statusKey,
      component: observation.component,
      operation: observation.operation,
      capability,
      summary: summaryFor(capability, observation.status),
      status: observation.status,
      observed_at: observation.observed_at,
      failure_count: observation.status === "degraded" || observation.status === "down"
        ? (previous?.failure_count ?? 0) + 1
        : 0,
      ...(observation.code ? { code: observation.code } : {}),
      ...(observation.scope ? { scope: { ...observation.scope } } : {}),
    };
    this.statuses.set(statusKey, status);
    this.publish("system:component_status", status, observation.scope);

    if (observation.status === "degraded" || observation.status === "down") {
      const error: DashboardOperationError = {
        ...status,
        error_id: `${statusKey}:${observation.observed_at}:${observation.sequence}`,
      };
      this.recentErrors.unshift(error);
      this.pruneErrors(observation.observed_at);
      this.publish("system:operation_error", error, observation.scope);
    }
  }

  snapshot(isVisible: (scope?: RuntimeHealthScope) => boolean): DashboardRuntimeHealthSnapshot {
    const now = Date.now();
    this.pruneErrors(now);
    return {
      component_statuses: Array.from(this.statuses.values())
        .filter((status) => isVisible(status.scope))
        .sort((a, b) => b.observed_at - a.observed_at),
      recent_operation_errors: this.recentErrors.filter((error) => isVisible(error.scope)),
    };
  }

  purgeSource(sourceId: string, removedAt = Date.now()): void {
    recordLifecycleTombstone(this.inactiveSources, sourceId, removedAt);
    for (const [key, status] of this.statuses) {
      if (status.scope?.source_id === sourceId) this.statuses.delete(key);
    }
    for (let index = this.recentErrors.length - 1; index >= 0; index--) {
      if (this.recentErrors[index]?.scope?.source_id === sourceId) this.recentErrors.splice(index, 1);
    }
  }

  activateSource(sourceId: string): void {
    this.inactiveSources.delete(sourceId);
  }

  deactivateSource(sourceId: string, observedAt = Date.now()): void {
    recordLifecycleTombstone(this.inactiveSources, sourceId, observedAt);
    for (const [key, current] of this.statuses) {
      if (current.scope?.source_id !== sourceId) continue;
      const status: DashboardComponentStatus = {
        ...current,
        status: "disabled",
        summary: summaryFor(current.capability, "disabled"),
        observed_at: observedAt,
        failure_count: 0,
        code: undefined,
      };
      this.statuses.set(key, status);
      this.publish("system:component_status", status, status.scope);
    }
    this.removeSourceErrors(sourceId);
  }

  purgeSession(sessionId: string, removedAt = Date.now()): void {
    recordLifecycleTombstone(this.removedSessions, sessionId, removedAt);
    for (const [key, status] of this.statuses) {
      if (status.scope?.session_id === sessionId) this.statuses.delete(key);
    }
    for (let index = this.recentErrors.length - 1; index >= 0; index--) {
      if (this.recentErrors[index]?.scope?.session_id === sessionId) this.recentErrors.splice(index, 1);
    }
  }

  activateSession(sessionId: string): void {
    this.removedSessions.delete(sessionId);
  }

  private acceptOrder(observation: RuntimeHealthObservation): boolean {
    const previous = this.producerOrders.get(observation.producer);
    if (previous?.epoch === observation.producer_epoch && observation.sequence <= previous.sequence) return false;
    if (previous?.retiredEpochs.has(observation.producer_epoch)) return false;
    if (previous && previous.epoch !== observation.producer_epoch && observation.observed_at < previous.observedAt) return false;
    const retiredEpochs = previous?.retiredEpochs ?? new Set<string>();
    if (previous && previous.epoch !== observation.producer_epoch) retiredEpochs.add(previous.epoch);
    this.producerOrders.set(observation.producer, {
      epoch: observation.producer_epoch,
      sequence: observation.sequence,
      observedAt: observation.observed_at,
      retiredEpochs,
    });
    return true;
  }

  private acceptLifecycle(observation: RuntimeHealthObservation): boolean {
    const sourceId = observation.scope?.source_id;
    if (sourceId && this.inactiveSources.has(sourceId)) return false;
    const sessionId = observation.scope?.session_id;
    if (sessionId && this.removedSessions.has(sessionId)) return false;
    return true;
  }

  private removeSourceErrors(sourceId: string): void {
    for (let index = this.recentErrors.length - 1; index >= 0; index--) {
      if (this.recentErrors[index]?.scope?.source_id === sourceId) this.recentErrors.splice(index, 1);
    }
  }

  private publish(type: "system:component_status" | "system:operation_error", value: DashboardComponentStatus | DashboardOperationError, scope?: RuntimeHealthScope): void {
    const data: Record<string, unknown> = {
      ...value,
      ...(scope?.user_id ? { user_id: scope.user_id } : {}),
      ...(scope?.session_id ? { session_id: scope.session_id } : {}),
      ...(scope?.source_id ? { source_id: scope.source_id } : {}),
    };
    try {
      this.options.publish({
        type,
        timestamp: value.observed_at,
        camera_id: scope?.source_id,
        data,
      });
    } catch {
      // Dashboard telemetry must not affect the producer being observed.
    }
  }

  private pruneErrors(now: number): void {
    const cutoff = now - RECENT_ERROR_TTL_MS;
    for (let index = this.recentErrors.length - 1; index >= 0; index--) {
      if ((this.recentErrors[index]?.observed_at ?? 0) < cutoff) this.recentErrors.splice(index, 1);
    }
    if (this.recentErrors.length > MAX_RECENT_ERRORS) this.recentErrors.length = MAX_RECENT_ERRORS;
  }
}

function recordLifecycleTombstone(tombstones: Map<string, number>, id: string, removedAt: number): void {
  tombstones.delete(id);
  tombstones.set(id, removedAt);
  const cutoff = removedAt - LIFECYCLE_TOMBSTONE_TTL_MS;
  for (const [key, timestamp] of tombstones) {
    if (timestamp < cutoff) tombstones.delete(key);
  }
  while (tombstones.size > MAX_LIFECYCLE_TOMBSTONES) {
    const oldest = tombstones.keys().next().value as string | undefined;
    if (!oldest) break;
    tombstones.delete(oldest);
  }
}

export function parseRuntimeHealthObservation(value: unknown): RuntimeHealthObservation | null {
  if (!isRecord(value)) return null;
  const components = new Set([
    "chat", "detector", "embedder", "live_agent", "memory", "memory_search",
    "pipeline", "preview", "reid", "source", "stt", "vlm",
  ]);
  const statuses = new Set(["ok", "degraded", "down", "unknown", "disabled"]);
  if (typeof value.producer !== "string" || !value.producer || value.producer.length > 80) return null;
  if (typeof value.producer_epoch !== "string" || !value.producer_epoch || value.producer_epoch.length > 80) return null;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  if (typeof value.component !== "string" || !components.has(value.component)) return null;
  if (typeof value.operation !== "string" || !value.operation || value.operation.length > 80) return null;
  if (typeof value.status !== "string" || !statuses.has(value.status)) return null;
  if (typeof value.observed_at !== "number" || !Number.isFinite(value.observed_at)) return null;
  const rawScope = isRecord(value.scope) ? value.scope : undefined;
  const scope = rawScope ? {
    ...scopeField("user_id", rawScope.user_id),
    ...scopeField("session_id", rawScope.session_id),
    ...scopeField("source_id", rawScope.source_id),
  } : undefined;
  return {
    producer: value.producer,
    producer_epoch: value.producer_epoch,
    sequence: value.sequence,
    component: value.component as RuntimeHealthObservation["component"],
    operation: value.operation,
    status: value.status as RuntimeHealthStatus,
    observed_at: value.observed_at,
    ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
    ...(typeof value.code === "string" && value.code.length <= 80 ? { code: value.code } : {}),
    ...(typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms) && value.latency_ms >= 0 ? { latency_ms: value.latency_ms } : {}),
    ...(typeof value.retrying === "boolean" ? { retrying: value.retrying } : {}),
  };
}

function scopeField<K extends keyof RuntimeHealthScope>(key: K, value: unknown): Pick<RuntimeHealthScope, K> | Record<string, never> {
  if (typeof value !== "string") return {};
  const normalized = value.trim().slice(0, 160);
  return normalized ? { [key]: normalized } as Pick<RuntimeHealthScope, K> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildStatusKey(observation: RuntimeHealthObservation): string {
  const scope = observation.scope;
  return [
    observation.component,
    observation.operation,
    scope?.user_id ? `user=${scope.user_id}` : "",
    scope?.session_id ? `session=${scope.session_id}` : "",
    scope?.source_id ? `source=${scope.source_id}` : "",
  ].filter(Boolean).join("|");
}

function capabilityFor(component: string, operation: string): string {
  if (component === "embedder" || component === "memory_search") return "Memory Search";
  if (component === "memory") return operation.includes("search") ? "Memory Search" : operation.includes("get") ? "Memory Access" : "Memory Updates";
  if (component === "vlm" || component === "pipeline") return "Video Analysis";
  if (component === "stt") return "Speech Recognition";
  if (component === "detector") return "Object Detection";
  if (component === "reid") return "Identity Recognition";
  if (component === "source") return "Video Stream";
  if (component === "preview") return "Video Preview";
  if (component === "live_agent") return "Voice Interaction";
  return "Chat";
}

function summaryFor(capability: string, status: RuntimeHealthStatus): string {
  const verb = capability === "Memory Updates" ? "are" : "is";
  if (status === "ok") return `${capability} ${verb} working normally.`;
  if (status === "disabled") return `${capability} ${verb} not enabled.`;
  if (status === "unknown") return `${capability} has not reported recently.`;
  const impact: Record<string, string> = {
    "Memory Search": "Chat may miss older events.",
    "Memory Access": "Saved details may be unavailable.",
    "Memory Updates": "New observations may not be saved.",
    "Video Analysis": "New video moments may be delayed or unavailable.",
    "Speech Recognition": "Spoken dialogue may be missing.",
    "Object Detection": "Visible subjects may be missing.",
    "Identity Recognition": "People may not be recognized consistently.",
    "Video Stream": "The live video may be unavailable.",
    "Video Preview": "Video previews may be unavailable.",
    "Voice Interaction": "Voice questions may be unavailable.",
    "Chat": "Questions may not receive a complete answer.",
  };
  return `${capability} encountered an error. ${impact[capability] ?? "Some features may be unavailable."}`;
}
