"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ReactorProvider, ReactorView, useReactor } from "@reactor-team/js-sdk";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
type Counterfactual = {
  action: string;
  safety_score: number;
  fatalities: boolean;
  visual_prompt: string;
};

type APIResponse = {
  counterfactuals: Counterfactual[];
  voiceover_summary: string;
};

type HazardAction = "CUT_IN" | "SUDDEN_STOP" | "OVERTAKE";

function liveEgoDirective(gesture: HazardAction, scenario: string) {
  // Short on purpose: Helios dilutes long prompts. Chase view from just behind
  // the car - never "drone", "aerial" or "cinematic", which pull it into
  // overhead or film framing. Obstacle kept close, road populated.
  void scenario;
  const VIEW = "Realistic car driving simulation, camera close behind a silver car on a three-lane highway. The camera is fixed to the silver car and moves at exactly the same speed as it, so the silver car stays in the same spot in the frame while the road flows past. ";
  const TRAFFIC = " Several other cars drive nearby in the left and right lanes. Clear daylight.";
  return {
    SUDDEN_STOP:
      VIEW + "A white van is just ahead in the same lane, only two car lengths away. " +
      "The van brakes hard and stops, and the silver car brakes and stops close behind it." + TRAFFIC,
    CUT_IN:
      VIEW + "A slow white van is just ahead in the same lane, only two car lengths away. " +
      "The silver car pulls into the empty left lane and drives past the van." + TRAFFIC,
    OVERTAKE:
      VIEW + "A white van is just ahead in the same lane, two car lengths away. " +
      "The silver car follows it at the same steady speed, keeping that short gap." + TRAFFIC,
  }[gesture];
}

const CAMERA =
  "Realistic car driving simulation, camera close behind the silver car on a three-lane highway, the white van just ahead in the same lane a couple of car lengths away, several other cars in the neighbouring lanes. Clear daylight.";

function liveCounterfactuals(hazard: HazardAction, scenario = "busy forward-moving city traffic"): Counterfactual[] {
  // [BRAKE, TURN, CONTINUE]. The highest score must match the branch the live
  // video switches to, or the RECOMMENDED badge contradicts the video.
  const profiles = {
    CUT_IN: [74, 91, 7],        // slow vehicle ahead, clear lane -> overtake
    SUDDEN_STOP: [96, 48, 2],   // obstacle stops -> brake
    OVERTAKE: [71, 78, 90],     // traffic stable -> continue
  }[hazard];
  const subject = {
    CUT_IN: "a nearby vehicle cuts sharply into the ego lane",
    SUDDEN_STOP: "a lead vehicle stops suddenly in front of the ego vehicle",
    OVERTAKE: "a surrounding vehicle overtakes and merges ahead",
  }[hazard];
  return ["BRAKE", "TURN", "CONTINUE"].map((action, index) => ({
    action,
    safety_score: profiles[index],
    fatalities: profiles[index] < 20,
    visual_prompt: `The ego vehicle executes this safety action: ${action}. ${subject}. ${scenario} ${CAMERA}`,
  }));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function AegisDriveDashboard() {
  const [scenario, setScenario] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [counterfactuals, setCounterfactuals] = useState<Counterfactual[]>([]);
  const [voiceover, setVoiceover] = useState("");
  const [isPlayingVoiceover, setIsPlayingVoiceover] = useState(false);
  const [activeReactorAction, setActiveReactorAction] = useState<string | null>(null);
  const [hazard, setHazard] = useState<HazardAction | null>(null);
  const [livePrompt, setLivePrompt] = useState("");
  const [safetyReview, setSafetyReview] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cosmosClips, setCosmosClips] = useState<Record<string, string>>({});
  const [cosmosGenerating, setCosmosGenerating] = useState<string | null>(null);
  const [cosmosError, setCosmosError] = useState<string | null>(null);
  const [cosmosReady, setCosmosReady] = useState(false);
  const [reactorHost, setReactorHost] = useState<HTMLDivElement | null>(null);
  // When the live branch switches, React may attach the new panel's host before
  // detaching the old one. A plain setState ref would then be clobbered back to
  // null and the portal would render nowhere, so ignore the detach call.
  const attachReactorHost = useCallback((node: HTMLDivElement | null) => {
    if (node) setReactorHost(node);
  }, []);
  const [reactorAttempt, setReactorAttempt] = useState(0);

  // Cosmos needs NVIDIA credentials the demo may not have. Ask the server once
  // and hide the control entirely rather than surface a guaranteed failure.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/cosmos")
      .then((response) => response.json())
      .then((data) => { if (!cancelled) setCosmosReady(Boolean(data?.configured)); })
      .catch(() => { if (!cancelled) setCosmosReady(false); });
    return () => { cancelled = true; };
  }, []);

  const voiceoverAudioRef = useRef<HTMLAudioElement | null>(null);
  const cosmosClipsRef = useRef<Record<string, string>>({});

  // The Reactor session is now mounted once at dashboard level and its video is
  // portalled into whichever panel is active, so switching branches no longer
  // tears down and reopens a WebRTC session. That churn against the
  // max_sessions:1 token was what produced the empty control/data channel
  // errors. Switching is therefore instant and needs no release delay.
  const requestReactorAction = useCallback((action: string) => {
    setActiveReactorAction((current) => (current === action ? current : action));
  }, []);

  const applyHazard = useCallback((nextHazard: HazardAction) => {
    const futures = liveCounterfactuals(nextHazard, scenario);
    setHazard(nextHazard);
    setCounterfactuals(futures);
    setLivePrompt(liveEgoDirective(nextHazard, scenario));
    // Every gesture drives the live view to that hazard's recommended branch,
    // so the generated video always matches the action the safety layer chose.
    const recommended = nextHazard === "SUDDEN_STOP" ? "BRAKE" : nextHazard === "CUT_IN" ? "TURN" : "CONTINUE";
    requestReactorAction(recommended);
  }, [requestReactorAction, scenario]);

  const requestOpusReview = async () => {
    if (!scenario || !counterfactuals.length || isReviewing) return;
    setIsReviewing(true);
    setSafetyReview("");
    try {
      const response = await fetch("/api/safety-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, hazard, counterfactuals }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Opus safety review failed.");
      setSafetyReview(data.review);
    } catch (reason) {
      setSafetyReview(`Review unavailable: ${reason instanceof Error ? reason.message : "unknown error"}`);
    } finally {
      setIsReviewing(false);
    }
  };

  const generateCosmosClip = async (cf: Counterfactual) => {
    if (cosmosGenerating) return;
    setCosmosGenerating(cf.action);
    setCosmosError(null);
    try {
      const response = await fetch("/api/cosmos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: livePrompt || cf.visual_prompt, seed: 20260823 }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Cosmos request failed (${response.status}).`);
      }
      const clip = URL.createObjectURL(await response.blob());
      setCosmosClips((current) => {
        if (current[cf.action]) URL.revokeObjectURL(current[cf.action]);
        return { ...current, [cf.action]: clip };
      });
    } catch (reason) {
      setCosmosError(reason instanceof Error ? reason.message : "Cosmos video generation failed.");
    } finally {
      setCosmosGenerating(null);
    }
  };

  useEffect(() => {
    cosmosClipsRef.current = cosmosClips;
  }, [cosmosClips]);

  useEffect(() => () => {
    Object.values(cosmosClipsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);


  /* ── Ego vehicle voice ─────────────────────────────────────────── */
  // What the car says out loud the moment it detects the obstacle's motion.
  // First person, short, spoken as the vehicle itself.
  const egoCallout = (nextHazard: HazardAction) => ({
    SUDDEN_STOP: "Obstacle braking ahead. Emergency braking engaged. Holding my lane.",
    CUT_IN: "Slower vehicle ahead. Left lane is clear. Overtaking now.",
    OVERTAKE: "Traffic ahead is stable. Maintaining speed and lane.",
  }[nextHazard]);

  /* ── Synthetic Voice Audit (TTS) ───────────────────────────────── */
  const playVoiceover = async (text: string) => {
    if (!text) return;

    if (voiceoverAudioRef.current) {
      voiceoverAudioRef.current.pause();
      voiceoverAudioRef.current = null;
    }

    setIsPlayingVoiceover(true);

    try {
      const res = await fetch("/api/audio", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        throw new Error(`Audio Engine HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      voiceoverAudioRef.current = audio;

      audio.onended = () => {
        setIsPlayingVoiceover(false);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setIsPlayingVoiceover(false);
        console.warn("[Audio System] Playback error.");
      };

      await audio.play();
    } catch (err) {
      console.warn("[Audio System] TTS unavailable.", err);
      setIsPlayingVoiceover(false);
    }
  };

  // The car speaks the moment a new hazard is detected. Guarded by a ref so a
  // repeated gesture does not make it talk over itself.
  const spokenHazardRef = useRef<HazardAction | null>(null);
  useEffect(() => {
    if (!hazard || spokenHazardRef.current === hazard) return;
    spokenHazardRef.current = hazard;
    void playVoiceover(egoCallout(hazard));
  }, [hazard]);

  /* ── Submit handler ────────────────────────────────────────────── */
  const handleSubmit = async () => {
    if (!scenario.trim()) return;
    setIsSimulating(true);
    setError(null);
    setCounterfactuals([]);
    setVoiceover("");
    setCosmosError(null);
    setCosmosClips((current) => {
      Object.values(current).forEach((url) => URL.revokeObjectURL(url));
      return {};
    });

    try {
      // 1. Get analytical predictions
      const res = await fetch("/api/counterfactual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_description: scenario }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Prediction Engine returned HTTP ${res.status}`);
      }

      const data: APIResponse = await res.json();
      const cfs = data.counterfactuals;

      if (!Array.isArray(cfs) || cfs.length === 0) {
        throw new Error("Invalid response structure from prediction engine.");
      }

      setCounterfactuals(cfs);
      const safest = cfs.reduce((previous, current) =>
        previous.safety_score > current.safety_score ? previous : current
      );
      setLivePrompt(safest.visual_prompt);
      requestReactorAction(safest.action);
      setVoiceover(data.voiceover_summary || "");

      // 2. Play auditory summary while the safest visual stream connects.
      if (data.voiceover_summary) {
        playVoiceover(data.voiceover_summary);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Simulation Error]", msg);
      setError(msg);
    } finally {
      setIsSimulating(false);
    }
  };

  /* ── Helpers ────────────────────────────────────────────────────── */
  const asilBadge = (cf: Counterfactual) => {
    if (cf.fatalities)
      return {
        label: "ASIL-D CRITICAL",
        cls: "bg-red-50 border-red-400 text-red-600",
      };
    if (cf.safety_score >= 80)
      return {
        label: "ASIL-A SAFE",
        cls: "bg-emerald-50 border-emerald-400 text-emerald-600",
      };
    if (cf.safety_score >= 50)
      return {
        label: "ASIL-C WARNING",
        cls: "bg-amber-50 border-amber-400 text-amber-600",
      };
    return {
      label: "ASIL-D DANGER",
      cls: "bg-red-50 border-red-400 text-red-600",
    };
  };

  const actionIcon = (action: string) => {
    if (action === "BRAKE") return "⏹";
    if (action === "TURN") return "↺";
    return "→";
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-800 antialiased">
      {/* ═══ HEADER ═══ */}
      <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-6 py-3.5 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-400" />
          </span>
          <h1 className="text-lg font-semibold tracking-[0.18em] text-slate-900">
            AEGIS<span className="text-cyan-700">DRIVE</span>
          </h1>
          <span className="hidden text-sm tracking-[0.15em] text-slate-800 sm:inline">
            COUNTERFACTUAL SAFETY LAB
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden tracking-[0.12em] text-slate-800 lg:inline">
            LOCAL PHYSICS · REACTOR HELIOS{cosmosReady ? " · NVIDIA COSMOS" : ""}
          </span>
          <span className={`rounded-full border px-3 py-1 font-semibold tracking-[0.15em] ${isSimulating ? "border-amber-300 bg-amber-50 text-amber-700" : "border-emerald-300 bg-emerald-50 text-emerald-700"}`}>
            {isSimulating ? "ANALYSING" : "READY"}
          </span>
        </div>
      </header>

      <div className="flex-1 flex flex-col gap-6 p-6">
        {/* ═══ SCENARIO DICTATION CONSOLE ═══ */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold tracking-[0.15em] text-slate-600">SCENARIO</h2>
            <span className="text-sm tracking-[0.1em] text-slate-800">TEXT-TO-VIDEO · NO SOURCE CLIP NEEDED</span>
          </div>
          <textarea
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            placeholder="Input edge-case parameters... e.g. 'Ego vehicle at 90 km/h on rain-slicked highway. A child runs onto the road from behind a parked van 35m ahead. Oncoming traffic in the adjacent lane.'"
            rows={4}
            className="w-full resize-none rounded-lg border border-slate-300 bg-white/95 px-4 py-3 text-base leading-relaxed text-slate-800 placeholder-slate-400 transition-colors focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-300"
          />
          <GestureControl onHazard={applyHazard} activeHazard={hazard} />
          <div className="flex items-center justify-between mt-3">
            <p className="text-sm text-slate-800">{scenario.length} characters</p>
            <button
              onClick={handleSubmit}
              disabled={isSimulating || !scenario.trim()}
              className="rounded-lg bg-cyan-500 px-6 py-2.5 text-sm font-semibold tracking-[0.1em] text-white shadow-lg shadow-cyan-500/25 transition-all hover:bg-cyan-400 disabled:opacity-40 disabled:shadow-none disabled:hover:bg-cyan-500"
            >
              {isSimulating ? "ANALYSING…" : "GENERATE FUTURES"}
            </button>
          </div>
          {error && (
            <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
        </section>

        {/* ═══ COUNTERFACTUAL VIEWPORTS (3-column video grid) ═══ */}
        <section className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
          {["BRAKE", "TURN", "CONTINUE"].map((action) => {
            const cf = counterfactuals.find((c) => c.action === action) || null;
            const badge = cf ? asilBadge(cf) : null;
            const best = counterfactuals.length
              ? counterfactuals.reduce((x, y) => (x.safety_score >= y.safety_score ? x : y)).action
              : null;
            const isRecommended = Boolean(cf) && action === best;

            return (
              <div
                key={action}
                className={`flex flex-col overflow-hidden rounded-2xl border bg-white shadow-sm transition-all duration-300 ease-out hover:shadow-md ${isRecommended ? "border-cyan-500 ring-1 ring-cyan-500/40" : "border-slate-200"}`}
              >
                {/* Channel header */}
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">
                      {cf ? actionIcon(cf.action) : "○"}
                    </span>
                    <span className="text-sm font-semibold tracking-[0.12em] text-slate-600">{action}</span>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-sm font-semibold tracking-[0.12em] ${isRecommended ? "bg-cyan-100 text-cyan-700" : cf ? "text-slate-800" : "text-slate-800"}`}>
                    {isRecommended ? "RECOMMENDED" : cf ? "READY" : "STANDBY"}
                  </span>
                </div>

                {/* Video viewport */}
                <div className="relative flex aspect-video flex-col items-center justify-center overflow-hidden bg-slate-900">
                  {cf && cosmosClips[action] ? (
                    <video className="absolute inset-0 h-full w-full object-cover" src={cosmosClips[action]} controls autoPlay muted playsInline loop />
                  ) : cf && activeReactorAction === action ? (
                    <div className="absolute inset-0">
                      <CounterfactualPreview action={action} hazard={hazard} />
                      {/* Portal target: the single live session renders here. */}
                      <div ref={attachReactorHost} className="absolute inset-0" />
                    </div>
                  ) : cf ? (
                    <div className="absolute inset-0">
                      <CounterfactualPreview action={action} hazard={hazard} />
                      <div className="absolute inset-x-2 bottom-2 z-20 flex gap-2">
                        <button onClick={() => requestReactorAction(action)} className="rounded border border-cyan-400 bg-white/90 px-2 py-1 text-sm font-bold tracking-widest text-cyan-800">
                          REACTOR LIVE
                        </button>
                        {cosmosReady && (
                          <button onClick={() => void generateCosmosClip(cf)} disabled={Boolean(cosmosGenerating)} className="rounded border border-emerald-400 bg-white/90 px-2 py-1 text-sm font-bold tracking-widest text-emerald-800 disabled:opacity-50">
                            {cosmosGenerating === action ? "COSMOS QUEUED..." : "NVIDIA COSMOS 5S"}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50 p-4">
                      {isSimulating ? (
                        <>
                          <div className="w-10 h-10 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mb-3 " />
                          <p className="text-sm text-cyan-700 animate-pulse text-center tracking-widest font-bold">
                            GENERATING…
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-slate-600 tracking-widest">
                          AWAITING SCENARIO
                        </p>
                      )}
                    </div>
                  )}

                  {/* ASIL badge overlay */}
                  {badge && (
                    <div className="absolute top-2 right-2">
                      <span
                        className={`text-sm font-bold px-2 py-0.5 rounded border shadow-lg ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                  )}
                </div>

                {/* Telemetry footer */}
                <div className="p-4 border-t border-slate-200 bg-slate-50 flex-1 flex flex-col justify-center">
                  {cf ? (
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-sm text-slate-800 tracking-widest font-bold">
                          SAFETY SCORE
                        </p>
                        <p
                          className={`text-4xl font-bold tracking-tighter ${
                            cf.safety_score >= 80
                              ? "text-emerald-600"
                              : cf.safety_score >= 50
                              ? "text-amber-600"
                              : "text-red-600"
                          }`}
                        >
                          {cf.safety_score}%
                        </p>
                      </div>
                      <div className="text-right border-l border-slate-200 pl-4">
                        <p className="text-sm text-slate-800 tracking-widest font-bold">FATALITY RISK</p>
                        <p
                          className={`text-2xl font-bold tracking-tight mt-1 ${
                            cf.fatalities
                              ? "text-red-600 animate-pulse"
                              : "text-emerald-600"
                          }`}
                        >
                          {cf.fatalities ? "CRITICAL" : "NOMINAL"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center opacity-30">
                      <div>
                        <p className="text-sm text-slate-800 tracking-widest">SAFETY SCORE</p>
                        <p className="text-3xl font-bold text-slate-800">--%</p>
                      </div>
                      <div className="text-right border-l border-slate-200 pl-4">
                        <p className="text-sm text-slate-800 tracking-widest">MORTALITY</p>
                        <p className="text-xl font-bold text-slate-800 mt-1">---</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </section>
        <p className="-mt-4 text-sm text-slate-800">LOCAL FORECAST is deterministic and instant. REACTOR HELIOS uses one live text-to-video session.{cosmosReady ? " NVIDIA COSMOS 5S is an explicit cloud request; Preview output may carry a SynthID watermark and is rate-limited." : ""}</p>
        {cosmosError && <div className="-mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">COSMOS VIDEO ERROR: {cosmosError}</div>}

        {/* ═══ VOICEOVER & AUDIO LOG ═══ */}
        <section className="border border-slate-200 rounded-xl p-4 bg-white backdrop-blur shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-800 tracking-widest flex items-center gap-2">
              <span>🔊</span> EGO VEHICLE VOICE
            </h2>
            {isPlayingVoiceover && (
              <span className="text-sm text-amber-600 animate-bounce font-bold tracking-widest">
                ● SPEAKING
              </span>
            )}
            {voiceover && !isPlayingVoiceover && (
              <button
                onClick={() => playVoiceover(voiceover)}
                className="text-sm text-cyan-700 hover:text-cyan-700 font-bold transition-colors tracking-widest border border-cyan-200 px-2 py-1 rounded bg-cyan-50"
              >
                ▶ REPLAY
              </button>
            )}
          </div>

          {voiceover ? (
            <div className="bg-white/95 border border-slate-200 rounded-lg p-4">
              <p className="text-sm text-slate-800 mb-2 font-bold tracking-widest">
                TRANSCRIPT
              </p>
              <p className="text-sm text-slate-600 leading-relaxed font-mono">
                {voiceover}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-600 italic tracking-widest">
              The vehicle will speak its decision as soon as a scenario or gesture is detected.
            </p>
          )}
          {counterfactuals.length > 0 && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-slate-800 tracking-widest">INDEPENDENT SAFETY REVIEW · ADVISORY ONLY</p>
                <button onClick={() => void requestOpusReview()} disabled={isReviewing} className="rounded border border-violet-300 px-3 py-1.5 text-sm font-bold tracking-widest text-violet-800 disabled:opacity-50">
                  {isReviewing ? "REVIEWING..." : "RUN REVIEW"}
                </button>
              </div>
              {safetyReview && <p className="mt-2 rounded border border-violet-200 bg-violet-50 p-3 text-sm leading-relaxed text-violet-900">{safetyReview}</p>}
            </div>
          )}
        </section>
      </div>

      {/* One long-lived Reactor session for the whole dashboard. Remounted only
          when the user explicitly retries, never on a branch switch. */}
      {counterfactuals.length > 0 && activeReactorAction && (
        <ReactorSession
          key={reactorAttempt}
          prompt={livePrompt}
          host={reactorHost}
          onRetry={() => setReactorAttempt((value) => value + 1)}
        />
      )}
    </div>
  );
}

function GestureControl({ onHazard, activeHazard }: { onHazard: (hazard: HazardAction) => void; activeHazard: HazardAction | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const detectorRef = useRef<{ close: () => void } | null>(null);
  const lastGestureRef = useRef<{ name: HazardAction | null; at: number }>({ name: null, at: 0 });
  const lastStampRef = useRef(0);
  const stableRef = useRef<{ name: HazardAction | null; count: number }>({ name: null, count: 0 });
  // Mirrors the status string so the per-frame loop only calls setState when
  // the text actually changes, instead of re-rendering on every frame.
  const statusRef = useRef("");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("CAMERA OFF · LOCAL GESTURE CONTROL");

  // The detect loop starts once but must always reach the newest handler, or it
  // keeps firing against the scenario text and Reactor state captured at start.
  const onHazardRef = useRef(onHazard);
  useEffect(() => { onHazardRef.current = onHazard; }, [onHazard]);

  const stop = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    detectorRef.current?.close();
    detectorRef.current = null;
    lastGestureRef.current = { name: null, at: 0 };
    lastStampRef.current = 0;
    stableRef.current = { name: null, count: 0 };
    statusRef.current = "";
    setEnabled(false);
    setStatus("CAMERA OFF · LOCAL GESTURE CONTROL");
  }, []);

  const start = useCallback(async () => {
    try {
      setStatus("LOADING LOCAL HAND TRACKER...");
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
      const detectorOptions = {
        runningMode: "VIDEO" as const,
        numHands: 1,
      };
      // Prefer the browser GPU delegate for lower gesture latency. Some
      // browsers block WebGL/WebGPU, so fall back to CPU rather than failing.
      let detector;
      try {
        detector = await vision.HandLandmarker.createFromOptions(fileset, {
          ...detectorOptions,
          baseOptions: {
            delegate: "GPU",
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
          },
        });
      } catch {
        detector = await vision.HandLandmarker.createFromOptions(fileset, {
          ...detectorOptions,
          baseOptions: {
            delegate: "CPU",
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
          },
        });
      }
      detectorRef.current = detector;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 }, audio: false });
      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        detector.close();
        detectorRef.current = null;
        return;
      }
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setEnabled(true);
      setStatus("LOCAL HAND TRACKING ACTIVE");

      const detect = () => {
        const video = videoRef.current;
        if (!video || !streamRef.current) return;
        // MediaPipe throws on an unready frame or a repeated timestamp. An
        // uncaught throw here would end the rAF chain and silently kill
        // gestures for the rest of the demo, so skip the frame instead.
        if (video.readyState < 2) {
          frameRef.current = requestAnimationFrame(detect);
          return;
        }
        const stamp = Math.max(performance.now(), lastStampRef.current + 1);
        lastStampRef.current = stamp;
        let points;
        try {
          points = detector.detectForVideo(video, stamp).landmarks[0];
        } catch {
          frameRef.current = requestAnimationFrame(detect);
          return;
        }
        if (!points) {
          stableRef.current = { name: null, count: 0 };
          if (statusRef.current !== "NO HAND") {
            statusRef.current = "NO HAND";
            setStatus("SHOW YOUR HAND TO THE CAMERA");
          }
        } else {
          // Orientation-robust: a finger counts as extended when its tip sits
          // further from the wrist than its middle joint. The old tip.y < pip.y
          // test misread any tilted or angled hand.
          const wrist = points[0];
          const reach = (i: number) => Math.hypot(points[i].x - wrist.x, points[i].y - wrist.y);
          const extended = (tip: number, pip: number) => reach(tip) > reach(pip) * 1.15;
          const fingersUp = [extended(8, 6), extended(12, 10), extended(16, 14), extended(20, 18)].filter(Boolean).length;

          // 2 fingers is ambiguous between fist and palm, so it commits to
          // nothing rather than firing a wrong branch switch.
          const gesture: HazardAction | null =
            fingersUp >= 3 ? "SUDDEN_STOP" : fingersUp === 1 ? "CUT_IN" : fingersUp === 0 ? "OVERTAKE" : null;

          const stable = stableRef.current;
          if (gesture && stable.name === gesture) stable.count += 1;
          else stableRef.current = { name: gesture, count: gesture ? 1 : 0 };

          // Require the same reading across consecutive frames before acting:
          // a single noisy frame used to be enough to switch the Reactor branch.
          const STABLE_FRAMES = 4;
          if (gesture && stableRef.current.count === STABLE_FRAMES && lastGestureRef.current.name !== gesture) {
            lastGestureRef.current = { name: gesture, at: performance.now() };
            onHazardRef.current(gesture);
            statusRef.current = gesture;
            setStatus(`GESTURE LOCKED · ${gesture.replace("_", " ")} (${fingersUp} fingers)`);
          } else if (stableRef.current.count < STABLE_FRAMES) {
            const hint = `READING... ${fingersUp} FINGER${fingersUp === 1 ? "" : "S"}`;
            if (statusRef.current !== hint) {
              statusRef.current = hint;
              setStatus(hint);
            }
          }
        }
        frameRef.current = requestAnimationFrame(detect);
      };
      frameRef.current = requestAnimationFrame(detect);
    } catch (reason) {
      setStatus(reason instanceof Error ? `CAMERA ERROR · ${reason.message}` : "CAMERA ERROR");
      stop();
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold tracking-[0.15em] text-slate-600">GESTURE CONTROL</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-800">✋ Open palm — brake · ☝ One finger — overtake · ✊ Fist — continue</p>
        </div>
        <button onClick={enabled ? stop : () => void start()} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold tracking-[0.12em] text-slate-800 transition-all duration-200 hover:-translate-y-px hover:border-cyan-500 hover:text-cyan-700 hover:shadow-sm">
          {enabled ? "STOP CAMERA" : "ENABLE CAMERA"}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <video ref={videoRef} muted playsInline className="h-16 w-24 -scale-x-100 rounded-md border border-slate-300 object-cover" />
        <span className="text-sm tracking-[0.1em] text-slate-800">{status}{activeHazard ? ` · ACTIVE: ${activeHazard.replace("_", " ")}` : ""}</span>
      </div>
    </div>
  );
}

function TrafficPredictionCanvas({ action, hazard }: { action: string; hazard: HazardAction }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Longitudinal model. Speeds are clamped at or above zero so nothing in the
    // scene can travel backwards. The obstacle profile is what the gesture
    // controls; the ego profile is its reaction.
    const CRUISE = 130;
    const MAX_GAP = 160;               // metres shown; keeps the readout sane
    const obstacleSpeedAt = (t: number) =>
      hazard === "SUDDEN_STOP" ? Math.max(0, CRUISE - 260 * t)
      : hazard === "CUT_IN" ? CRUISE * 0.45
      : CRUISE;
    const egoSpeedAt = (t: number) =>
      action === "BRAKE" ? Math.max(0, CRUISE - 210 * t)
      : action === "TURN" ? CRUISE * 0.95
      : CRUISE;

    // Ambient highway traffic in the neighbouring lanes.
    const traffic = [
      { lane: -1, offset: 40, speed: 118, colour: "#64748b" },
      { lane: -1, offset: 200, speed: 126, colour: "#475569" },
      { lane: 1, offset: 95, speed: 108, colour: "#94a3b8" },
      { lane: 1, offset: 250, speed: 114, colour: "#64748b" },
    ];
    const ambient = traffic.map((v) => ({ ...v, y: v.offset }));

    let animation = 0;
    let last = 0;
    let elapsed = 0;
    let gap = 120;
    let scroll = 0;
    let lateral = 0;

    const car = (x: number, y: number, w: number, h: number, body: string) => {
      context.fillStyle = body;
      context.beginPath();
      context.roundRect(x - w / 2, y - h, w, h, 5);
      context.fill();
      // windscreen band, so the blocks read as vehicles rather than rectangles
      context.fillStyle = "rgba(255,255,255,0.35)";
      context.beginPath();
      context.roundRect(x - w / 2 + 3, y - h + 5, w - 6, h * 0.26, 2);
      context.fill();
    };

    const draw = (now: number) => {
      const width = canvas.clientWidth || 640;
      const height = canvas.clientHeight || 360;
      const scale = window.devicePixelRatio || 1;
      if (canvas.width !== width * scale || canvas.height !== height * scale) {
        canvas.width = width * scale; canvas.height = height * scale;
        context.setTransform(scale, 0, 0, scale, 0, 0);
      }
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      elapsed += dt;

      const egoSpeed = egoSpeedAt(elapsed);
      const obstacleSpeed = obstacleSpeedAt(elapsed);
      gap = Math.min(MAX_GAP, Math.max(0, gap + (obstacleSpeed - egoSpeed) * dt));
      scroll = (scroll + egoSpeed * dt) % 34;
      const targetLateral = action === "TURN" ? -width * 0.2 : 0;
      lateral += (targetLateral - lateral) * Math.min(1, dt * 2.2);

      // road
      context.fillStyle = "#e2e8f0"; context.fillRect(0, 0, width, height);
      context.fillStyle = "#cbd5e1"; context.fillRect(width * .1, 0, width * .8, height);
      context.strokeStyle = "#ffffff"; context.lineWidth = 2; context.setLineDash([18, 16]);
      context.lineDashOffset = -scroll;
      [width * .3, width * .5, width * .7].forEach((x, i) => {
        if (i === 1) return;                      // centre of the ego lane stays clear
        context.beginPath(); context.moveTo(x, -40); context.lineTo(x, height + 40); context.stroke();
      });
      context.setLineDash([]); context.lineDashOffset = 0;
      context.strokeStyle = "#94a3b8"; context.lineWidth = 3;
      [width * .1, width * .9].forEach((x) => {
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
      });

      const egoY = height * .78;
      const egoX = width * .5 + lateral;
      const obstacleX = width * .5;
      const perMetre = (height * .62) / MAX_GAP;
      const obstacleY = egoY - gap * perMetre;

      // ambient traffic, positioned relative to the ego's own speed
      ambient.forEach((v) => {
        v.y += (egoSpeed - v.speed) * dt * perMetre * 0.6;
        const span = height + 160;
        if (v.y > height + 80) v.y -= span;
        if (v.y < -80) v.y += span;
        car(width * .5 + v.lane * width * .2, v.y, 30, 54, v.colour);
      });

      const contact = gap <= 2 && Math.abs(egoX - obstacleX) < 34;
      car(obstacleX, obstacleY, 34, 58, obstacleSpeed < 30 ? "#dc2626" : "#ea580c");
      car(egoX, egoY, 36, 62, "#0f766e");

      context.fillStyle = "#0f172a";
      context.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      context.fillText(`GAP ${Math.round(gap)} m`, 12, 18);
      context.fillText(`EGO ${Math.round(egoSpeed * 0.28)} km/h`, 12, 34);
      context.fillText(`OBST ${Math.round(obstacleSpeed * 0.28)} km/h`, 12, 50);
      context.fillStyle = "#334155";
      context.font = "600 9px ui-sans-serif, system-ui, sans-serif";
      context.fillText("EGO", egoX - 11, egoY + 12);

      context.fillStyle = contact ? "rgba(220,38,38,.25)" : "rgba(16,185,129,.16)";
      context.beginPath(); context.arc(egoX, egoY - 31, contact ? 50 : 32, 0, Math.PI * 2); context.fill();
      if (contact) {
        context.fillStyle = "#b91c1c";
        context.font = "700 11px ui-sans-serif, system-ui, sans-serif";
        context.fillText("CONTACT", egoX - 27, egoY - 74);
      }

      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [action, hazard]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Deterministic traffic counterfactual simulation" />;
}

function CounterfactualPreview({ action, hazard }: { action: string; hazard?: HazardAction | null }) {
  const settings = {
    BRAKE: { label: "AEB ENGAGED", speed: 0.68, filter: "saturate(0.8) contrast(1.08)", color: "#34d399", path: "M50 100 C50 78 50 63 50 55" },
    TURN: { label: "EVASIVE TURN", speed: 1, filter: "sepia(0.18) saturate(1.3)", color: "#fbbf24", path: "M50 100 C50 78 44 64 30 52" },
    CONTINUE: { label: "IMPACT TRAJECTORY", speed: 1.1, filter: "saturate(1.35) contrast(1.15) hue-rotate(-12deg)", color: "#f87171", path: "M50 100 C50 78 50 62 50 42" },
  }[action] || { label: "SIMULATION", speed: 1, filter: "none", color: "#67e8f9", path: "M50 100 L50 50" };

  return (
    <div className="absolute inset-0 overflow-hidden bg-slate-100">
      <TrafficPredictionCanvas action={action} hazard={hazard ?? "SUDDEN_STOP"} />
      <div className="absolute inset-0 bg-gradient-to-t from-slate-900/40 via-transparent to-transparent" />
      <div className="absolute right-3 top-3 rounded border bg-white/90 px-2 py-1 text-[10px] font-bold tracking-wide" style={{ borderColor: settings.color, color: settings.color }}>
        {settings.label}
      </div>
      <div className="absolute bottom-3 right-3 rounded border border-cyan-300 bg-white/90 px-2 py-1 text-[10px] font-bold tracking-wide text-cyan-700">
        DETERMINISTIC FORECAST
      </div>
    </div>
  );
}

function ReactorSession({ prompt, host, onRetry }: { prompt: string; host: HTMLDivElement | null; onRetry: () => void }) {
  const tokenRef = useRef<string | null>(null);
  const getJwt = useCallback(async () => {
    if (tokenRef.current) return tokenRef.current;
    const response = await fetch("/api/reactor", { method: "POST" });
    if (!response.ok) throw new Error(`Reactor token request failed (${response.status})`);
    const data = await response.json();
    if (!data.jwt) throw new Error("Reactor did not return a token.");
    tokenRef.current = data.jwt;
    return data.jwt;
  }, []);

  return (
    <ReactorProvider modelName="reactor/helios" getJwt={getJwt} connectOptions={{ autoConnect: true, autoResumeTracks: true }}>
      <HeliosWorldInput prompt={prompt} />
      {host && createPortal(
        <>
          <ReactorView className="absolute inset-0 h-full w-full object-cover" style={{ background: "transparent" }} videoObjectFit="cover" />
          <ReactorStatus onRetry={onRetry} />
        </>,
        host
      )}
    </ReactorProvider>
  );
}

function HeliosWorldInput({ prompt }: { prompt: string }) {
  // useReactor has no equality-function overload, so a selector returning a new
  // object re-renders on every store tick. Select each primitive separately.
  const status = useReactor((state) => state.status);
  const sendCommand = useReactor((state) => state.sendCommand);
  const promptRef = useRef(prompt);
  const started = useRef(false);
  // The exact prompt text Helios is currently generating from. Re-sending the
  // same text restarts generation for no reason, so it is only sent when the
  // text genuinely differs — i.e. a new scenario or a new gesture directive.
  const sentPromptRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { promptRef.current = prompt; }, [prompt]);

  useEffect(() => {
    if (status !== "ready") return;
    // Same prompt as the running stream: leave it alone.
    if (prompt === sentPromptRef.current) return;
    // No `started` gate here. It was set asynchronously after an await, so a
    // gesture arriving during start-up was silently dropped and the video never
    // followed the gesture.
    sentPromptRef.current = prompt;
    void (async () => {
      await sendCommand("set_prompt", { prompt });
    })().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Helios prompt update failed."));
  }, [prompt, sendCommand, status]);

  useEffect(() => {
    if (status !== "ready") return;
    if (started.current) return;
    // Claim the start slot synchronously so it cannot run twice, and so the
    // update effect above is never blocked waiting on this one.
    started.current = true;
    void (async () => {
      if (sentPromptRef.current !== promptRef.current) {
        sentPromptRef.current = promptRef.current;
        await sendCommand("set_prompt", { prompt: promptRef.current });
      }
      try {
        await sendCommand("start", {});
      } catch (reason) {
        console.warn("[Reactor] start command rejected; stream may already be running.", reason);
      }
    })().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Helios initialization failed.");
    });
  }, [sendCommand, status]);

  // Reported to the console only. Surfacing transient Helios warnings on top of
  // the video looked like a broken app during the demo.
  useEffect(() => { if (error) console.warn("[Reactor]", error); }, [error]);
  return null;
}

function ReactorStatus({ onRetry }: { onRetry: () => void }) {
  const status = useReactor((state) => state.status);
  const error = useReactor((state) => state.lastError);
  const tracks = useReactor((state) => state.tracks);
  const videoTrack = Object.entries(tracks).find(([, track]) => track.kind === "video");

  // Kept out of the UI on purpose, but still reported for debugging.
  useEffect(() => { if (error) console.warn("[Reactor]", error.message); }, [error]);

  if (status === "ready") {
    return <div className="absolute left-2 top-2 z-30 rounded border border-cyan-400 bg-white/95 px-2 py-1 text-xs font-bold tracking-widest text-cyan-800">{videoTrack?.[1].muted ? "REACTOR GENERATING..." : "REACTOR LIVE"}</div>;
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-50 p-4 text-center backdrop-blur-[2px]">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
      <span className="text-sm font-semibold tracking-[0.2em] text-cyan-800">
        {status === "disconnected" ? "RECONNECTING" : "STARTING LIVE MODEL"}
      </span>
      {status === "disconnected" && (
        <button onClick={onRetry} className="rounded-md border border-cyan-500 bg-cyan-50 px-3 py-1.5 text-sm font-semibold tracking-[0.15em] text-cyan-800 transition-colors hover:bg-cyan-100">
          RETRY
        </button>
      )}
    </div>
  );
}
