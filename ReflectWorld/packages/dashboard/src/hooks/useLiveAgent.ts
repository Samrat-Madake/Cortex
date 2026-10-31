import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DashboardSession } from "../session";
import { dashboardAuthHeaders, withDashboardQuery } from "../session";
import type { ChatMessage } from "../components/chat/ChatPanel";

export type LiveAgentState = "disabled" | "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface LiveAgentControls {
  enabled: boolean;
  hotkey: string;
  state: LiveAgentState;
  error: string | null;
  toggle: () => void;
  interactive: boolean;
  audioLevel: number;
}

interface LiveAgentConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  hotkey?: string;
  language?: string;
}

type LiveAgentServerMessage =
  | { type: "ready"; hotkey: string }
  | { type: "status"; status: "connecting" | "listening" | "thinking" | "speaking" | "idle"; message?: string }
  | { type: "input_transcript"; text: string; final?: boolean }
  | { type: "assistant_delta"; text: string }
  | { type: "audio"; data: string; sample_rate: number }
  | { type: "done" }
  | { type: "error"; error: string };

interface UseLiveAgentOptions {
  session: DashboardSession;
  cameraId: string | null;
  history: ChatMessage[];
  onUserTranscript: (text: string, final: boolean, turnId: number) => void;
  onAssistantText: (text: string, final: boolean, turnId: number) => void;
  onError: (message: string, turnId: number) => void;
  onVoicePending: (turnId: number) => void;
  onVoiceDiscard: (turnId: number) => void;
}

const INPUT_SAMPLE_RATE = 16_000;
const DEFAULT_HOTKEY = "F8";
const VOICE_RESPONSE_TIMEOUT_MS = 30_000;

interface LiveAgentMachine {
  state: LiveAgentState;
  error: string | null;
  active: boolean;
  pendingStart: boolean;
}

type LiveAgentAction =
  | { type: "disabled" }
  | { type: "probe_start" }
  | { type: "ready" }
  | { type: "start_requested" }
  | { type: "start_pending" }
  | { type: "listening" }
  | { type: "stop_requested" }
  | { type: "speaking" }
  | { type: "done" }
  | { type: "server_idle" }
  | { type: "error"; error: string }
  | { type: "clear_error" };

const initialMachine: LiveAgentMachine = {
  state: "disabled",
  error: null,
  active: false,
  pendingStart: false,
};

function liveAgentReducer(machine: LiveAgentMachine, action: LiveAgentAction): LiveAgentMachine {
  switch (action.type) {
    case "disabled":
      return { state: "disabled", error: null, active: false, pendingStart: false };
    case "probe_start":
      return { state: "connecting", error: null, active: false, pendingStart: false };
    case "ready":
      if (machine.pendingStart) return { state: "connecting", error: null, active: false, pendingStart: true };
      if (machine.active) return machine;
      return { state: "idle", error: null, active: false, pendingStart: false };
    case "start_requested":
      return { state: "connecting", error: null, active: true, pendingStart: false };
    case "start_pending":
      return { state: "connecting", error: null, active: true, pendingStart: true };
    case "listening":
      return { state: "listening", error: null, active: true, pendingStart: false };
    case "stop_requested":
      return { state: "thinking", error: null, active: false, pendingStart: false };
    case "speaking":
      return { ...machine, state: "speaking", error: null };
    case "done":
      return { state: "idle", error: null, active: false, pendingStart: false };
    case "server_idle":
      if (machine.active || machine.pendingStart) return machine;
      return { state: "idle", error: null, active: false, pendingStart: false };
    case "error":
      return { state: "error", error: action.error, active: false, pendingStart: false };
    case "clear_error":
      return { ...machine, error: null };
  }
}

export function useLiveAgent({
  session,
  cameraId,
  history,
  onUserTranscript,
  onAssistantText,
  onError,
  onVoicePending,
  onVoiceDiscard,
}: UseLiveAgentOptions): LiveAgentControls {
  const [config, setConfig] = useState<LiveAgentConfig>({ enabled: false });
  const [machine, dispatch] = useReducer(liveAgentReducer, initialMachine);
  const [audioLevel, setAudioLevel] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const startedRef = useRef(false);
  const readyRef = useRef(false);
  const pendingStartRef = useRef(false);
  const probingRef = useRef(false);
  const turnCounterRef = useRef(0);
  const currentTurnIdRef = useRef(0);
  const inputTranscriptSeenRef = useRef(false);
  const turnTimeoutRef = useRef<number | null>(null);
  const smoothedAudioLevelRef = useRef(0);
  const lastAudioLevelUpdateRef = useRef(0);
  const cameraIdRef = useRef(cameraId);
  const historyRef = useRef(history);
  const onUserTranscriptRef = useRef(onUserTranscript);
  const onAssistantTextRef = useRef(onAssistantText);
  const onErrorRef = useRef(onError);
  const onVoicePendingRef = useRef(onVoicePending);
  const onVoiceDiscardRef = useRef(onVoiceDiscard);

  useEffect(() => {
    cameraIdRef.current = cameraId;
  }, [cameraId]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    onUserTranscriptRef.current = onUserTranscript;
    onAssistantTextRef.current = onAssistantText;
    onErrorRef.current = onError;
    onVoicePendingRef.current = onVoicePending;
    onVoiceDiscardRef.current = onVoiceDiscard;
  }, [onAssistantText, onError, onUserTranscript, onVoiceDiscard, onVoicePending]);

  useEffect(() => {
    let cancelled = false;
    void fetch(withDashboardQuery("/api/dashboard/live-agent/config", session), {
      headers: dashboardAuthHeaders(session),
    })
      .then(response => response.json())
      .then((data: LiveAgentConfig) => {
        if (cancelled) return;
        const enabled = data.enabled === true;
        setConfig({ ...data, enabled });
        dispatch(enabled ? { type: "probe_start" } : { type: "disabled" });
      })
      .catch(() => {
        if (cancelled) return;
        setConfig({ enabled: false });
        dispatch({ type: "disabled" });
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    void captureCtxRef.current?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach(track => track.stop());
    processorRef.current = null;
    sourceRef.current = null;
    captureCtxRef.current = null;
    streamRef.current = null;
    smoothedAudioLevelRef.current = 0;
    lastAudioLevelUpdateRef.current = 0;
    setAudioLevel(0);
  }, []);

  const updateAudioLevel = useCallback((input: Float32Array) => {
    const now = Date.now();
    if (now - lastAudioLevelUpdateRef.current < 48) return;
    lastAudioLevelUpdateRef.current = now;
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.abs(input[i] ?? 0);
      sum += sample * sample;
      if (sample > peak) peak = sample;
    }
    const rms = input.length > 0 ? Math.sqrt(sum / input.length) : 0;
    const rmsDb = amplitudeToDb(rms);
    const peakDb = amplitudeToDb(peak);
    const rmsLevel = decibelLevelFromDb(rmsDb, -58, -18);
    const peakLevel = decibelLevelFromDb(peakDb, -48, -12);
    const normalized = Math.max(rmsLevel, peakLevel * 0.72);
    const previous = smoothedAudioLevelRef.current;
    const attack = normalized > previous ? 0.62 : 0.18;
    const smoothed = previous * (1 - attack) + normalized * attack;
    smoothedAudioLevelRef.current = smoothed;
    setAudioLevel(smoothed);
  }, []);

  const clearTurnTimeout = useCallback(() => {
    if (turnTimeoutRef.current !== null) window.clearTimeout(turnTimeoutRef.current);
    turnTimeoutRef.current = null;
  }, []);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "close" }));
      ws.close();
    }
    wsRef.current = null;
    readyRef.current = false;
    pendingStartRef.current = false;
  }, []);

  useEffect(() => () => {
    stopCapture();
    clearTurnTimeout();
    closeSocket();
    void playbackCtxRef.current?.close().catch(() => undefined);
  }, [clearTurnTimeout, closeSocket, stopCapture]);

  const sendStart = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !readyRef.current) {
      pendingStartRef.current = true;
      dispatch({ type: "start_pending" });
      return;
    }
    pendingStartRef.current = false;
    ws.send(JSON.stringify({
      type: "start",
      ...(cameraIdRef.current ? { camera_id: cameraIdRef.current } : {}),
      history: historyRef.current.slice(-8),
    }));
  }, []);

  const handleServerMessage = useCallback((message: LiveAgentServerMessage) => {
    if (message.type === "ready") {
      readyRef.current = true;
      probingRef.current = false;
      dispatch({ type: "ready" });
      if (pendingStartRef.current) sendStart();
      return;
    }
    if (message.type === "status") {
      if (message.status === "idle" && (startedRef.current || pendingStartRef.current)) return;
      if (message.status === "idle") dispatch({ type: "server_idle" });
      else if (message.status === "listening") dispatch({ type: "listening" });
      else if (message.status === "thinking") dispatch({ type: "stop_requested" });
      else if (message.status === "speaking") dispatch({ type: "speaking" });
      else dispatch({ type: "probe_start" });
      return;
    }
    if (message.type === "input_transcript") {
      if (message.text.trim()) inputTranscriptSeenRef.current = true;
      onUserTranscriptRef.current(message.text, message.final === true, currentTurnIdRef.current);
      return;
    }
    if (message.type === "assistant_delta") {
      onAssistantTextRef.current(message.text, false, currentTurnIdRef.current);
      return;
    }
    if (message.type === "audio") {
      clearTurnTimeout();
      dispatch({ type: "speaking" });
      playPcmAudio(message.data, message.sample_rate, playbackCtxRef, nextPlaybackTimeRef);
      return;
    }
    if (message.type === "done") {
      clearTurnTimeout();
      if (!inputTranscriptSeenRef.current) onVoiceDiscardRef.current(currentTurnIdRef.current);
      onAssistantTextRef.current("", true, currentTurnIdRef.current);
      dispatch({ type: "done" });
      return;
    }
    if (message.type === "error") {
      clearTurnTimeout();
      probingRef.current = false;
      dispatch({ type: "error", error: message.error });
      onErrorRef.current(message.error, currentTurnIdRef.current);
    }
  }, [clearTurnTimeout, sendStart]);

  const ensureSocket = useCallback(() => {
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return existing;
    const path = withDashboardQuery("/ws/live-agent", session);
    const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${path}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    readyRef.current = false;
    ws.onopen = () => {
      if (probingRef.current) ws.send(JSON.stringify({ type: "probe" }));
      if (pendingStartRef.current) sendStart();
    };
    ws.onmessage = (event) => {
      try {
        handleServerMessage(JSON.parse(String(event.data)) as LiveAgentServerMessage);
      } catch {
        // Ignore malformed internal messages without disrupting recording.
      }
    };
    ws.onerror = () => {
      const message = "Voice connection failed";
      probingRef.current = false;
      dispatch({ type: "error", error: message });
      onErrorRef.current(message, currentTurnIdRef.current);
    };
    ws.onclose = () => {
      readyRef.current = false;
      wsRef.current = null;
      if (startedRef.current) {
        startedRef.current = false;
        pendingStartRef.current = false;
        stopCapture();
        const message = "Voice connection closed unexpectedly";
        dispatch({ type: "error", error: message });
        onErrorRef.current(message, currentTurnIdRef.current);
      } else if (probingRef.current) {
        probingRef.current = false;
        dispatch({ type: "error", error: "Voice connection closed during startup" });
      }
    };
    return ws;
  }, [handleServerMessage, sendStart, session, stopCapture]);

  useEffect(() => {
    if (!config.enabled) return;
    const existing = wsRef.current;
    if (readyRef.current && existing?.readyState === WebSocket.OPEN) {
      probingRef.current = false;
      dispatch({ type: "ready" });
      return;
    }
    probingRef.current = true;
    dispatch({ type: "probe_start" });
    ensureSocket();
  }, [config.enabled, ensureSocket]);

  const startCapture = useCallback(async () => {
    if (!config.enabled) return;
    if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      const message = "Voice input requires HTTPS or localhost.";
      dispatch({ type: "error", error: message });
      onErrorRef.current(message, currentTurnIdRef.current);
      return;
    }
    dispatch({ type: "start_requested" });
    ensureSocket();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    const captureCtx = new AudioContext();
    const source = captureCtx.createMediaStreamSource(stream);
    const processor = captureCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const ws = wsRef.current;
      if (!startedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      updateAudioLevel(input);
      const pcm = downsampleToPcm16(input, captureCtx.sampleRate, INPUT_SAMPLE_RATE);
      if (pcm.length === 0) return;
      ws.send(JSON.stringify({ type: "audio", data: pcm16ToBase64(pcm) }));
    };
    source.connect(processor);
    processor.connect(captureCtx.destination);
    streamRef.current = stream;
    captureCtxRef.current = captureCtx;
    sourceRef.current = source;
    processorRef.current = processor;
    turnCounterRef.current += 1;
    currentTurnIdRef.current = turnCounterRef.current;
    inputTranscriptSeenRef.current = false;
    startedRef.current = true;
    clearTurnTimeout();
    sendStart();
    dispatch({ type: "listening" });
  }, [clearTurnTimeout, config.enabled, ensureSocket, sendStart, updateAudioLevel]);

  const stopVoice = useCallback(() => {
    if (!startedRef.current) return;
    startedRef.current = false;
    pendingStartRef.current = false;
    if (!inputTranscriptSeenRef.current) onVoicePendingRef.current(currentTurnIdRef.current);
    stopCapture();
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    } else if (ws?.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    clearTurnTimeout();
    turnTimeoutRef.current = window.setTimeout(() => {
      if (inputTranscriptSeenRef.current) {
        onAssistantTextRef.current("Voice response timed out. Please try again.", true, currentTurnIdRef.current);
      } else {
        onVoiceDiscardRef.current(currentTurnIdRef.current);
      }
      dispatch({ type: "done" });
      pendingStartRef.current = false;
    }, VOICE_RESPONSE_TIMEOUT_MS);
    dispatch({ type: "stop_requested" });
  }, [clearTurnTimeout, stopCapture]);

  const toggle = useCallback(() => {
    if (!config.enabled) return;
    if (startedRef.current) {
      stopVoice();
      return;
    }
    if (machine.state !== "idle" && machine.state !== "error") return;
    void startCapture().catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to start voice input";
      dispatch({ type: "error", error: message });
      onErrorRef.current(message, currentTurnIdRef.current);
      stopCapture();
    });
  }, [config.enabled, machine.state, startCapture, stopCapture, stopVoice]);

  useEffect(() => {
    if (!config.enabled) return;
    const hotkey = normalizeHotkey(config.hotkey ?? DEFAULT_HOTKEY);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      if (event.key !== hotkey && event.code !== hotkey) return;
      if (isEditableTarget(event.target) && !isDedicatedVoiceHotkey(hotkey)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [config.enabled, config.hotkey, toggle]);

  return {
    enabled: config.enabled,
    hotkey: config.hotkey ?? DEFAULT_HOTKEY,
    state: machine.state,
    error: machine.error,
    toggle,
    interactive: startedRef.current || machine.state === "idle" || machine.state === "error",
    audioLevel: machine.state === "listening" ? audioLevel : 0,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function normalizeHotkey(value: string): string {
  const text = value.trim();
  return text || DEFAULT_HOTKEY;
}

function isDedicatedVoiceHotkey(value: string): boolean {
  return /^F(?:[1-9]|1[0-2])$/.test(value) || value === "Escape" || value === "Esc";
}

function amplitudeToDb(value: number): number {
  if (value <= 0) return -100;
  return 20 * Math.log10(value);
}

function decibelLevelFromDb(db: number, floorDb: number, ceilingDb: number): number {
  const linear = (db - floorDb) / (ceilingDb - floorDb);
  return Math.min(1, Math.max(0, Math.pow(linear, 0.58)));
}

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate: number): Int16Array {
  if (inputRate <= outputRate) return floatToPcm16(input);
  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j] ?? 0;
      count += 1;
    }
    const sample = count > 0 ? sum / count : 0;
    output[i] = clampToInt16(sample);
  }
  return output;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = clampToInt16(input[i] ?? 0);
  return output;
}

function clampToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function playPcmAudio(
  base64: string,
  sampleRate: number,
  playbackCtxRef: MutableRefObject<AudioContext | null>,
  nextPlaybackTimeRef: MutableRefObject<number>,
): void {
  const bytes = base64ToBytes(base64);
  if (bytes.length < 2) return;
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const ctx = playbackCtxRef.current ?? new AudioContext();
  playbackCtxRef.current = ctx;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate || 24_000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = (pcm[i] ?? 0) / 0x8000;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, nextPlaybackTimeRef.current);
  source.start(startAt);
  nextPlaybackTimeRef.current = startAt + buffer.duration;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
