import { describe, it, expect } from "vitest";
import { FixedWindowSegmenter } from "../segmenter/fixed-window.js";
import { MotionSegmenter } from "../segmenter/motion-stub.js";
import { VADSegmenter } from "../segmenter/vad-stub.js";
import { CompositeSegmenter } from "../segmenter/composite.js";
import type { CutSignal } from "../segmenter/types.js";
import { createSegmenterChain } from "../segmenter/index.js";
import type { FrameResult } from "../types.js";

const dummyFrame: FrameResult = {
  data: "base64",
  timestamp: Date.now(),
  source_name: "test",
};

/** Create a frame with a specific timestamp. */
function frameAt(ts: number): FrameResult {
  return { data: "base64", timestamp: ts, source_name: "test" };
}

describe("FixedWindowSegmenter", () => {
  it("fires CutSignal every windowSize frames", () => {
    const seg = new FixedWindowSegmenter(3);
    expect(seg.feed(dummyFrame, 0)).toBeNull();
    expect(seg.feed(dummyFrame, 1)).toBeNull();
    const cut = seg.feed(dummyFrame, 2);
    expect(cut).not.toBeNull();
    expect(cut!.endIndex).toBe(2);
    expect(cut!.reason).toContain("fixed_window");
  });

  it("resets count after cut", () => {
    const seg = new FixedWindowSegmenter(2);
    seg.feed(dummyFrame, 0);
    seg.feed(dummyFrame, 1); // fires
    expect(seg.feed(dummyFrame, 2)).toBeNull(); // reset, count=1
    expect(seg.feed(dummyFrame, 3)).not.toBeNull(); // fires again
  });

  it("reset() clears state", () => {
    const seg = new FixedWindowSegmenter(3);
    seg.feed(dummyFrame, 0);
    seg.reset();
    expect(seg.feed(dummyFrame, 1)).toBeNull(); // count=1, not 2
  });
});

describe("MotionSegmenter", () => {
  const T0 = 1000000;

  it("stays idle when no motion hint", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 2 });
    for (let i = 0; i < 20; i++) {
      expect(seg.feed(frameAt(T0 + i * 1000), i, { hasMotion: false })).toBeNull();
    }
  });

  it("stays idle when hints omitted", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 2 });
    for (let i = 0; i < 20; i++) {
      expect(seg.feed(frameAt(T0 + i * 1000), i)).toBeNull();
    }
  });

  it("transitions idle → in_motion → cooldown → cut", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 3, minDurationMs: 0 });

    expect(seg.feed(frameAt(T0), 0, { hasMotion: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 1000), 1, { hasMotion: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 2000), 2, { hasMotion: false })).toBeNull();
    expect(seg.feed(frameAt(T0 + 3000), 3, { hasMotion: false })).toBeNull();
    const cut = seg.feed(frameAt(T0 + 4000), 4, { hasMotion: false });
    expect(cut).not.toBeNull();
    expect(cut!.endIndex).toBe(4);
    expect(cut!.reason).toContain("motion_stop");
  });

  it("interrupts cooldown when motion resumes", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 3, minDurationMs: 0 });

    seg.feed(frameAt(T0), 0, { hasMotion: true });
    seg.feed(frameAt(T0 + 1000), 1, { hasMotion: false });   // cooldown 1
    seg.feed(frameAt(T0 + 2000), 2, { hasMotion: true });    // back to in_motion

    seg.feed(frameAt(T0 + 3000), 3, { hasMotion: false });   // cooldown 1
    seg.feed(frameAt(T0 + 4000), 4, { hasMotion: false });   // cooldown 2
    const cut = seg.feed(frameAt(T0 + 5000), 5, { hasMotion: false });
    expect(cut).not.toBeNull();
  });

  it("force cuts at maxDurationMs even if motion continues", () => {
    const seg = new MotionSegmenter({ maxDurationMs: 5000, minDurationMs: 0 });

    // Continuous motion for 6 seconds
    expect(seg.feed(frameAt(T0), 0, { hasMotion: true })).toBeNull();           // start
    expect(seg.feed(frameAt(T0 + 2000), 1, { hasMotion: true })).toBeNull();    // 2s
    expect(seg.feed(frameAt(T0 + 4000), 2, { hasMotion: true })).toBeNull();    // 4s
    const cut = seg.feed(frameAt(T0 + 5000), 3, { hasMotion: true });           // 5s → force cut
    expect(cut).not.toBeNull();
    expect(cut!.reason).toContain("motion_max");

    // After force cut, back to idle — new motion starts fresh
    expect(seg.feed(frameAt(T0 + 6000), 4, { hasMotion: true })).toBeNull();
  });

  it("won't cut until minDurationMs is reached", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 2, minDurationMs: 5000 });

    // Motion for 1s then stops — cooldown expires but elapsed < 5s → no cut
    seg.feed(frameAt(T0), 0, { hasMotion: true });
    seg.feed(frameAt(T0 + 500), 1, { hasMotion: false });       // cooldown 1
    expect(seg.feed(frameAt(T0 + 1000), 2, { hasMotion: false })).toBeNull(); // cooldown 2, but 1s < 5s → no cut

    // Still accumulating — new motion at 3s, stops at 6s → elapsed 6s >= 5s → cut
    seg.feed(frameAt(T0 + 3000), 3, { hasMotion: true });
    seg.feed(frameAt(T0 + 6000), 4, { hasMotion: false });      // cooldown 1
    const cut = seg.feed(frameAt(T0 + 7000), 5, { hasMotion: false }); // cooldown 2, 7s >= 5s
    expect(cut).not.toBeNull();
    expect(cut!.reason).toContain("motion_stop");
  });

  it("reset() returns to idle state", () => {
    const seg = new MotionSegmenter({ cooldownFrames: 2 });
    seg.feed(frameAt(T0), 0, { hasMotion: true });
    seg.reset();

    for (let i = 0; i < 10; i++) {
      expect(seg.feed(frameAt(T0 + (i + 1) * 1000), i, { hasMotion: false })).toBeNull();
    }
  });
});

describe("VADSegmenter", () => {
  const T0 = 1000000;

  it("stays idle when no voice hint", () => {
    const seg = new VADSegmenter({ cooldownFrames: 2 });
    for (let i = 0; i < 20; i++) {
      expect(seg.feed(frameAt(T0 + i * 1000), i, { hasVoice: false })).toBeNull();
    }
  });

  it("stays idle when hints omitted", () => {
    const seg = new VADSegmenter({ cooldownFrames: 2 });
    for (let i = 0; i < 20; i++) {
      expect(seg.feed(frameAt(T0 + i * 1000), i)).toBeNull();
    }
  });

  it("transitions idle → speaking → silence_cooldown → cut", () => {
    const seg = new VADSegmenter({ cooldownFrames: 3, minDurationMs: 0 });

    expect(seg.feed(frameAt(T0), 0, { hasVoice: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 1000), 1, { hasVoice: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 2000), 2, { hasVoice: false })).toBeNull();
    expect(seg.feed(frameAt(T0 + 3000), 3, { hasVoice: false })).toBeNull();
    const cut = seg.feed(frameAt(T0 + 4000), 4, { hasVoice: false });
    expect(cut).not.toBeNull();
    expect(cut!.endIndex).toBe(4);
    expect(cut!.reason).toContain("vad_silence");
  });

  it("interrupts cooldown when voice resumes", () => {
    const seg = new VADSegmenter({ cooldownFrames: 3, minDurationMs: 0 });

    seg.feed(frameAt(T0), 0, { hasVoice: true });
    seg.feed(frameAt(T0 + 1000), 1, { hasVoice: false });   // cooldown 1
    seg.feed(frameAt(T0 + 2000), 2, { hasVoice: true });    // back to speaking

    seg.feed(frameAt(T0 + 3000), 3, { hasVoice: false });   // cooldown 1
    seg.feed(frameAt(T0 + 4000), 4, { hasVoice: false });   // cooldown 2
    const cut = seg.feed(frameAt(T0 + 5000), 5, { hasVoice: false });
    expect(cut).not.toBeNull();
  });

  it("force cuts at maxDurationMs even if voice continues", () => {
    const seg = new VADSegmenter({ maxDurationMs: 5000, minDurationMs: 0 });

    expect(seg.feed(frameAt(T0), 0, { hasVoice: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 2000), 1, { hasVoice: true })).toBeNull();
    expect(seg.feed(frameAt(T0 + 4000), 2, { hasVoice: true })).toBeNull();
    const cut = seg.feed(frameAt(T0 + 5000), 3, { hasVoice: true });
    expect(cut).not.toBeNull();
    expect(cut!.reason).toContain("vad_max");

    // After force cut, back to idle
    expect(seg.feed(frameAt(T0 + 6000), 4, { hasVoice: true })).toBeNull();
  });

  it("won't cut until minDurationMs is reached", () => {
    const seg = new VADSegmenter({ cooldownFrames: 2, minDurationMs: 3000 });

    // Voice for 0.5s then stops — cooldown expires but elapsed < 3s → no cut
    seg.feed(frameAt(T0), 0, { hasVoice: true });
    seg.feed(frameAt(T0 + 500), 1, { hasVoice: false });      // cooldown 1
    expect(seg.feed(frameAt(T0 + 1000), 2, { hasVoice: false })).toBeNull(); // cooldown 2, but 1s < 3s

    // Still accumulating — new voice at 2s, stops at 4s → elapsed 4s >= 3s → cut
    seg.feed(frameAt(T0 + 2000), 3, { hasVoice: true });
    seg.feed(frameAt(T0 + 4000), 4, { hasVoice: false });     // cooldown 1
    const cut = seg.feed(frameAt(T0 + 5000), 5, { hasVoice: false }); // cooldown 2, 5s >= 3s
    expect(cut).not.toBeNull();
    expect(cut!.reason).toContain("vad_silence");
  });

  it("reset() returns to idle state", () => {
    const seg = new VADSegmenter({ cooldownFrames: 2 });
    seg.feed(frameAt(T0), 0, { hasVoice: true });
    seg.reset();

    for (let i = 0; i < 10; i++) {
      expect(seg.feed(frameAt(T0 + (i + 1) * 1000), i, { hasVoice: false })).toBeNull();
    }
  });
});

describe("CompositeSegmenter minDuration", () => {
  it("does not cut in active state before minDurationMs even if frameCount >= noVoiceWindowFrames", () => {
    const seg = new CompositeSegmenter({
      noVoiceWindowFrames: 10,
      minFrames: 10,
      minDurationMs: 5000,
    });

    // Feed 10 frames with motion over ~3.3s — all below minDurationMs, no cuts
    for (let i = 0; i < 10; i++) {
      const signal = seg.feed(
        { data: "", timestamp: i * 333, source_name: "cam1" },
        i,
        { hasMotion: true, motionRatio: 0.05 },
      );
      expect(signal).toBeNull();
    }

    // Continue feeding — once elapsed >= 5000ms and no voice, should cut
    for (let i = 10; i < 20; i++) {
      const signal = seg.feed(
        { data: "", timestamp: i * 333, source_name: "cam1" },
        i,
        { hasMotion: true, motionRatio: 0.05 },
      );
      if (i * 333 >= 5000 && i >= 10) {
        if (signal) {
          expect(signal.reason).toBeDefined();
          return;
        }
      }
    }
  });

  it("idle state ignores minDurationMs — cuts at idleWindowFrames", () => {
    const seg = new CompositeSegmenter({
      idleWindowFrames: 10,
      minFrames: 10,
      minDurationMs: 5000,
    });

    let cut = false;
    for (let i = 0; i < 10; i++) {
      const signal = seg.feed(
        { data: "", timestamp: i * 333, source_name: "cam1" },
        i,
        { hasMotion: false, motionRatio: 0 },
      );
      if (signal) { cut = true; break; }
    }
    expect(cut).toBe(true);
  });
});

describe("CompositeSegmenter active rules", () => {
  const mkFrame = (ts: number): FrameResult => ({
    data: "", timestamp: ts, source_name: "test",
  });

  it("Rule 1: never cuts before minDurationMs (5s)", () => {
    const seg = new CompositeSegmenter({ minDurationMs: 5000 });
    for (let i = 0; i < 15; i++) {
      const signal = seg.feed(mkFrame(i * 267), i, { hasMotion: true });
      expect(signal).toBeNull();
    }
  });

  it("Rule 2: hard_max at 30s", () => {
    const seg = new CompositeSegmenter({ hardMaxMs: 30000, minDurationMs: 5000 });
    seg.feed(mkFrame(0), 0, { hasMotion: true, hasVoice: true });
    const signal = seg.feed(mkFrame(30000), 1, { hasVoice: true });
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("hard_max");
  });

  it("Rule 4: hard_max_frames caps long non-voice active segments", () => {
    const seg = new CompositeSegmenter({ hardMaxFrames: 3, minDurationMs: 0 });
    seg.feed(mkFrame(0), 0, { hasMotion: true, hasVoice: false });
    seg.feed(mkFrame(1000), 1, { hasMotion: true, hasVoice: false });
    const signal = seg.feed(mkFrame(2000), 2, { hasMotion: true, hasVoice: false });
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("hard_max_frames");
  });

  it("Rule 4: default frame-count strategy still hard-caps active voice segments", () => {
    const seg = new CompositeSegmenter({ hardMaxFrames: 3, minDurationMs: 0 });
    seg.feed(mkFrame(0), 0, { hasMotion: true, hasVoice: true });
    seg.feed(mkFrame(1000), 1, { hasMotion: true, hasVoice: true });
    const signal = seg.feed(mkFrame(2000), 2, { hasMotion: true, hasVoice: true });
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("hard_max_frames");
  });

  it("default frame-count voice cuts still honor minDurationMs", () => {
    const seg = new CompositeSegmenter({
      minDurationMs: 5000,
      minFrames: 10,
      maxFrames: 15,
      noVoiceWindowFrames: 30,
      hardMaxFrames: 30,
    });

    for (let i = 0; i < 6; i++) {
      expect(seg.feed(mkFrame(i * 500), i, { hasMotion: true, hasVoice: true })).toBeNull();
      expect(seg.feedVoice(true, i * 500)).toBeNull();
    }

    let earlySignal: CutSignal | null = null;
    for (let i = 0; i < 12; i++) {
      earlySignal = seg.feedVoice(false, 3000 + i * 32);
      expect(earlySignal).toBeNull();
    }

    let signal: CutSignal | null = null;
    for (let i = 0; i < 12; i++) {
      signal = seg.feedVoice(false, 5000 + i * 32);
      if (signal) break;
    }
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("voice_pause_adaptive");
  });

  it("does not let silent audio trigger voice_pause_adaptive before speech was observed", () => {
    const seg = new CompositeSegmenter({
      minDurationMs: 5000,
      minFrames: 10,
      maxFrames: 15,
      noVoiceWindowFrames: 30,
      hardMaxFrames: 30,
      vadPauseStrategy: "elapsed_time",
    });

    for (let i = 0; i < 12; i++) {
      expect(seg.feed(mkFrame(i * 1000), i, { hasMotion: true, hasVoice: false })).toBeNull();
    }

    for (let i = 0; i < 20; i++) {
      expect(seg.feedVoice(false, 6000 + i * 32)).toBeNull();
    }
  });

  it("Rule 4: voice active suppresses soft cuts (defers to feedVoice)", () => {
    const seg = new CompositeSegmenter({ minDurationMs: 5000, noVoiceWindowFrames: 10 });
    for (let i = 0; i < 12; i++) {
      const signal = seg.feed(mkFrame(i * 500), i, { hasMotion: true, hasVoice: true });
      expect(signal).toBeNull();
    }
  });

  it("Rule 5: no_voice_window at 10 frames after 5s", () => {
    const seg = new CompositeSegmenter({ minDurationMs: 5000, noVoiceWindowFrames: 10 });
    let lastSignal: CutSignal | null = null;
    for (let i = 0; i < 15; i++) {
      lastSignal = seg.feed(mkFrame(i * 500), i, { hasMotion: true, hasVoice: false });
      if (lastSignal) break;
    }
    expect(lastSignal).not.toBeNull();
    expect(lastSignal!.reason).toBe("no_voice_window");
  });

  it("idle_window cuts at 10 frames without motion/voice/entity", () => {
    const seg = new CompositeSegmenter({ idleWindowFrames: 10 });
    let lastSignal: CutSignal | null = null;
    for (let i = 0; i < 12; i++) {
      lastSignal = seg.feed(mkFrame(i * 1000), i, { hasMotion: false, hasVoice: false, hasEntity: false });
      if (lastSignal) break;
    }
    expect(lastSignal).not.toBeNull();
    expect(lastSignal!.reason).toBe("idle_window");
  });

  it("transitions idle → active on entity detection", () => {
    const seg = new CompositeSegmenter();
    seg.feed(mkFrame(0), 0, { hasMotion: false, hasEntity: false });
    seg.feed(mkFrame(1000), 1, { hasMotion: false, hasEntity: false });
    const signal = seg.feed(mkFrame(2000), 2, { hasMotion: false, hasEntity: true });
    expect(signal).toBeNull(); // transitions to active, no cut
  });

  it("lets VAD activate an idle segment and cut on speech pause", () => {
    const seg = new CompositeSegmenter({
      minDurationMs: 0,
      minFrames: 10,
      maxFrames: 15,
      idleWindowFrames: 30,
      vadPauseStrategy: "elapsed_time",
      promoteIdleOnVoice: true,
    });
    for (let i = 0; i < 15; i++) {
      seg.feed(mkFrame(i * 1000), i, { hasMotion: false, hasVoice: false, hasEntity: false });
    }

    expect(seg.feedVoice(true, 14100)).toBeNull();
    let signal: CutSignal | null = null;
    for (let i = 0; i < 7; i++) {
      signal = seg.feedVoice(false, 14200 + i * 32);
      if (signal) break;
    }

    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("voice_pause_adaptive");
  });

  it("uses a late VAD pause before the hard frame cap on low-fps speech", () => {
    const seg = new CompositeSegmenter({
      minDurationMs: 5000,
      hardMaxMs: 30000,
      hardMaxFrames: 30,
      vadPauseStrategy: "elapsed_time",
    });

    for (let i = 0; i < 29; i++) {
      expect(seg.feed(mkFrame(i * 1000), i, { hasMotion: true, hasVoice: true })).toBeNull();
      expect(seg.feedVoice(true, i * 1000)).toBeNull();
    }

    const signal = seg.feedVoice(false, 29_000);
    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("voice_pause_adaptive");
  });
});

describe("createSegmenterChain", () => {
  it("returns FixedWindow by default", () => {
    const chain = createSegmenterChain(5);
    expect(chain).toHaveLength(1);
    expect(chain[0].name).toBe("fixed_window");
  });

  it("includes Motion when enabled", () => {
    const chain = createSegmenterChain(5, true, false);
    expect(chain).toHaveLength(2);
    expect(chain.map((s) => s.name)).toEqual(["motion", "fixed_window"]);
  });

  it("returns CompositeSegmenter when both motion and VAD enabled", () => {
    const chain = createSegmenterChain(5, true, true);
    expect(chain).toHaveLength(1);
    expect(chain[0].name).toBe("composite");
  });

  it("includes only VAD + FixedWindow when motion disabled", () => {
    const chain = createSegmenterChain(5, false, true);
    expect(chain).toHaveLength(2);
    expect(chain.map((s) => s.name)).toEqual(["vad", "fixed_window"]);
  });
});
