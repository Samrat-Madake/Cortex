// Dual-path notification with per-camera channel routing.
//
// Path A (Direct): alert / admin_command → immediate channel send
// Path B (Subagent): summary / identify → LLM formats then delivers
//
// The notification target is determined by the session key stored
// when the user started the watch (from whatever channel they used).
//
// Each send method returns a DeliveryResult for tracking success/failure + latency.

import { randomUUID } from "node:crypto";

type SendMessageFn = (channel: string, to: string, text: string, mediaUrl?: string) => Promise<void>;
type SubagentRunFn = (params: {
  sessionKey: string;
  message: string;
  deliver: boolean;
  idempotencyKey: string;
}) => Promise<{ runId: string }>;
type ParseSessionKeyFn = (sessionKey: string) => { channel: string; to: string } | null;

export interface NotifierDeps {
  sendMessage: SendMessageFn;
  subagentRun: SubagentRunFn;
  parseSessionKey: ParseSessionKeyFn;
  logger: {
    info: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
}

/** Delivery outcome returned by every send method. */
export interface DeliveryResult {
  delivered: boolean;
  delivery_ms: number;
  delivery_error?: string;
}

export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  /** Path A: immediate direct send for safety alerts */
  async sendAlert(message: string, sourceId?: string, sessionKey?: string, keyframePath?: string): Promise<DeliveryResult> {
    const start = Date.now();
    const text = sourceId ? `🚨 [${sourceId}] ${message}` : `🚨 ${message}`;
    if (!sessionKey) {
      this.deps.logger.error(`[notifier:direct] no sessionKey for ${sourceId} — cannot route alert`);
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: "no sessionKey" };
    }
    const target = this.deps.parseSessionKey(sessionKey);
    if (!target) {
      this.deps.logger.error(`[notifier:direct] cannot parse sessionKey: ${sessionKey}`);
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: `cannot parse sessionKey: ${sessionKey}` };
    }
    try {
      await this.deps.sendMessage(target.channel, target.to, text, keyframePath);
      const ms = Date.now() - start;
      this.deps.logger.info(`[notifier:direct] sent to ${target.channel}:${target.to}: ${text.slice(0, 80)}`);
      return { delivered: true, delivery_ms: ms };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[notifier:direct] failed: ${errMsg}`);
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: errMsg };
    }
  }

  /** Path B: subagent formats and delivers summaries; fallback to direct with image */
  async sendSummary(message: string, sourceId?: string, sessionKey?: string, keyframePath?: string): Promise<DeliveryResult> {
    const start = Date.now();
    const text = sourceId ? `📷 [${sourceId}] ${message}` : `📷 ${message}`;
    if (!sessionKey) {
      this.deps.logger.error(`[notifier:subagent] no sessionKey for ${sourceId} — cannot route summary`);
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: "no sessionKey" };
    }
    try {
      const { runId } = await this.deps.subagentRun({
        sessionKey,
        message: `ReflectWorld notification — relay to user concisely:\n${text}`,
        deliver: true,
        idempotencyKey: `reflectworld:summary:${randomUUID()}`,
      });
      this.deps.logger.info(`[notifier:subagent] dispatched summary (runId=${runId}): ${text.slice(0, 80)}`);
      // Subagent handles delivery; send keyframe as a direct follow-up if available
      if (keyframePath) {
        const target = this.deps.parseSessionKey(sessionKey);
        if (target) {
          await this.deps.sendMessage(target.channel, target.to, "", keyframePath).catch(() => {});
        }
      }
      return { delivered: true, delivery_ms: Date.now() - start };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[notifier:subagent] failed, falling back to direct: ${errMsg}`);
      // Fallback to direct send with image
      const target = this.deps.parseSessionKey(sessionKey);
      if (target) {
        try {
          await this.deps.sendMessage(target.channel, target.to, text, keyframePath);
          return { delivered: true, delivery_ms: Date.now() - start };
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.deps.logger.error(`[notifier:direct] fallback failed: ${fallbackMsg}`);
          return { delivered: false, delivery_ms: Date.now() - start, delivery_error: `subagent: ${errMsg}; fallback: ${fallbackMsg}` };
        }
      }
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: errMsg };
    }
  }

  /** Path B: subagent formats and delivers identification results */
  async sendIdentify(message: string, sourceId?: string, sessionKey?: string, keyframePath?: string): Promise<DeliveryResult> {
    const start = Date.now();
    const text = sourceId ? `🔍 [${sourceId}] ${message}` : `🔍 ${message}`;
    if (!sessionKey) {
      this.deps.logger.error(`[notifier:subagent] no sessionKey for ${sourceId} — cannot route identify`);
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: "no sessionKey" };
    }
    try {
      const { runId } = await this.deps.subagentRun({
        sessionKey,
        message: `ReflectWorld identification result — relay to user concisely:\n${text}`,
        deliver: true,
        idempotencyKey: `reflectworld:identify:${randomUUID()}`,
      });
      this.deps.logger.info(`[notifier:subagent] dispatched identify (runId=${runId}): ${text.slice(0, 80)}`);
      if (keyframePath) {
        const target = this.deps.parseSessionKey(sessionKey);
        if (target) {
          await this.deps.sendMessage(target.channel, target.to, "", keyframePath).catch(() => {});
        }
      }
      return { delivered: true, delivery_ms: Date.now() - start };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[notifier:subagent] failed, falling back to direct: ${errMsg}`);
      const target = this.deps.parseSessionKey(sessionKey);
      if (target) {
        try {
          await this.deps.sendMessage(target.channel, target.to, text, keyframePath);
          return { delivered: true, delivery_ms: Date.now() - start };
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.deps.logger.error(`[notifier:direct] fallback failed: ${fallbackMsg}`);
          return { delivered: false, delivery_ms: Date.now() - start, delivery_error: `subagent: ${errMsg}; fallback: ${fallbackMsg}` };
        }
      }
      return { delivered: false, delivery_ms: Date.now() - start, delivery_error: errMsg };
    }
  }
}
