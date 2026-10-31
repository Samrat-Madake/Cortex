export type RuntimeHealthStatus = "ok" | "degraded" | "down" | "unknown" | "disabled";

export type RuntimeHealthComponent =
  | "chat"
  | "detector"
  | "embedder"
  | "live_agent"
  | "memory"
  | "memory_search"
  | "pipeline"
  | "preview"
  | "reid"
  | "source"
  | "stt"
  | "vlm";

export interface RuntimeHealthScope {
  user_id?: string;
  session_id?: string;
  source_id?: string;
}

export interface RuntimeHealthObservation {
  producer: string;
  producer_epoch: string;
  sequence: number;
  component: RuntimeHealthComponent;
  operation: string;
  status: RuntimeHealthStatus;
  observed_at: number;
  scope?: RuntimeHealthScope;
  code?: string;
  latency_ms?: number;
  retrying?: boolean;
}

export type RuntimeHealthObservationInput = Omit<
  RuntimeHealthObservation,
  "producer" | "producer_epoch" | "sequence" | "observed_at"
> & { observed_at?: number };

export interface RuntimeHealthReporter {
  observe(input: RuntimeHealthObservationInput): void;
}

export type RuntimeHealthObserver = (observation: RuntimeHealthObservation) => void;

const observers = new Set<RuntimeHealthObserver>();
const pendingObservations: RuntimeHealthObservation[] = [];
const MAX_PENDING_OBSERVATIONS = 512;
let dispatchScheduled = false;

/**
 * Subscribe to process-local health observations. Producers remain no-op when
 * no Dashboard observer is installed, and observer failures never escape.
 */
export function subscribeRuntimeHealth(observer: RuntimeHealthObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function createRuntimeHealthReporter(producer: string): RuntimeHealthReporter {
  const producerEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let sequence = 0;
  return {
    observe(input) {
      try {
        if (observers.size === 0) return;
        const observation: RuntimeHealthObservation = {
          ...input,
          producer,
          producer_epoch: producerEpoch,
          sequence: ++sequence,
          observed_at: input.observed_at ?? Date.now(),
        };
        if (pendingObservations.length >= MAX_PENDING_OBSERVATIONS) pendingObservations.shift();
        pendingObservations.push(observation);
        scheduleDispatch();
      } catch {
        // Telemetry enqueue failures must never affect the observed operation.
      }
    },
  };
}

function scheduleDispatch(): void {
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  queueMicrotask(() => {
    dispatchScheduled = false;
    const batch = pendingObservations.splice(0);
    for (const observation of batch) {
      for (const observer of observers) {
        try {
          observer(observation);
        } catch {
          // Health reporting must never affect the observed operation.
        }
      }
    }
    if (pendingObservations.length > 0) scheduleDispatch();
  });
}
