import path from "node:path";
import type { ModelUsage } from "../model/model-gateway.js";

/**
 * Model speed: one sample per model request, in time order, across every session and agent of
 * the process. An observational indicator only: in-memory, bounded, never persisted.
 */
export interface ModelSpeedSample {
  at: string;
  model: string;
  /** Request sent to first output (text, thinking or tool call). */
  firstTokenMs: number;
  /** Output tokens over first output to end; absent when the provider reported no usage or the output was too short to measure. */
  tokensPerSecond?: number;
}

interface StoredSample extends ModelSpeedSample {
  /** Owning session (a subagent's child session lives under its owner); scopes samples to one user's sessions root. */
  sessionDir: string;
}

const CAPACITY = 200;
export const MODEL_SPEED_VIEW_SIZE = 30;
const MIN_OUTPUT_TOKENS = 16;
const MIN_GENERATION_MS = 250;

/** A model request in flight, as shown live: elapsed time since it was sent, first output once known. */
export interface ModelSpeedLive {
  id: string;
  model: string;
  /** Time since the request was sent, at the moment of reading; the viewer keeps counting from here. */
  elapsedMs: number;
  /** Set once the first output arrived. */
  firstTokenMs?: number;
}

interface LiveEntry { id: string; model: string; sessionDir: string; started: number; first?: number }

/** Handle of one in-flight request; every change is pushed to subscribers. */
export interface ModelSpeedLiveHandle {
  firstOutput(): void;
  /** A retried request starts over after its back-off delay. */
  restart(delayMs?: number): void;
  end(): void;
}

const underRoot = (sessionsRoot: string, sessionDir: string) => path.resolve(sessionDir).startsWith(path.resolve(sessionsRoot) + path.sep);

export class ModelSpeedStore {
  private samples: StoredSample[] = [];
  private readonly live = new Map<string, LiveEntry>();
  private liveCounter = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  record(sample: StoredSample): void {
    this.samples.push(sample);
    if (this.samples.length > CAPACITY) this.samples.splice(0, this.samples.length - CAPACITY);
    this.notify();
  }

  /** Latest samples of the sessions under one sessions root (one user's sessions in isolation mode). */
  recent(sessionsRoot: string, limit = MODEL_SPEED_VIEW_SIZE): ModelSpeedSample[] {
    return this.samples
      .filter((sample) => underRoot(sessionsRoot, sample.sessionDir))
      .slice(-limit)
      .map(({ sessionDir: _sessionDir, ...sample }) => sample);
  }

  begin(model: string, sessionDir: string): ModelSpeedLiveHandle {
    const entry: LiveEntry = { id: `live-${++this.liveCounter}`, model, sessionDir, started: this.now() };
    this.live.set(entry.id, entry);
    this.notify();
    let ended = false;
    return {
      firstOutput: () => {
        if (ended || entry.first !== undefined) return;
        entry.first = this.now();
        this.notify();
      },
      restart: (delayMs = 0) => {
        if (ended) return;
        entry.started = this.now() + Math.max(0, delayMs);
        entry.first = undefined;
        this.notify();
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.live.delete(entry.id);
        this.notify();
      },
    };
  }

  /** In-flight requests of the sessions under one sessions root, oldest first. */
  inFlight(sessionsRoot: string): ModelSpeedLive[] {
    const now = this.now();
    return [...this.live.values()]
      .filter((entry) => underRoot(sessionsRoot, entry.sessionDir))
      .map((entry) => ({
        id: entry.id,
        model: entry.model,
        elapsedMs: Math.max(0, Math.round(now - entry.started)),
        ...(entry.first !== undefined ? { firstTokenMs: Math.max(0, Math.round(entry.first - entry.started)) } : {}),
      }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void { this.samples = []; this.live.clear(); }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const globalModelSpeedStore = new ModelSpeedStore();

/** Times one model request: sent, first output, end; output tokens from the provider's usage. */
export class ModelSpeedMeter {
  private started: number;
  private first?: number;
  private outputTokens?: number;
  private finalUsage = false;

  constructor(private readonly model: string | undefined, private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  /** A retried request starts over after its back-off delay. */
  retry(delayMs = 0): void {
    this.started = this.now() + Math.max(0, delayMs);
    this.first = undefined;
    this.outputTokens = undefined;
    this.finalUsage = false;
  }

  firstOutput(): void {
    this.first ??= this.now();
  }

  usage(usage: ModelUsage | undefined, provisional = false): void {
    const tokens = usage?.outputTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return;
    if (provisional && this.finalUsage) return;
    this.outputTokens = tokens;
    if (!provisional) this.finalUsage = true;
  }

  /** The sample of a completed request; undefined when nothing was output or the model is unknown. */
  finish(wallNow = new Date()): ModelSpeedSample | undefined {
    if (!this.model || this.first === undefined) return undefined;
    const end = this.now();
    const generationMs = end - this.first;
    const tokens = this.outputTokens;
    const tokensPerSecond = tokens !== undefined && tokens >= MIN_OUTPUT_TOKENS && generationMs >= MIN_GENERATION_MS
      ? Math.round(tokens / generationMs * 10_000) / 10 : undefined;
    return {
      at: wallNow.toISOString(),
      model: this.model,
      firstTokenMs: Math.max(0, Math.round(this.first - this.started)),
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    };
  }
}
