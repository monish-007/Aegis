# AEGIS-DRIVE — Counterfactual Safety Lab

An interactive autonomous-vehicle safety demo. You describe a traffic scenario, then act as the **obstacle** using hand gestures. The ego vehicle detects your motion and the system compares three possible futures — **brake**, **turn/overtake**, and **continue** — scoring each, recommending the safest, explaining the trade-off aloud, and visualising the chosen future as generated video.

## Core design principle

> A video-generation model never decides vehicle safety.

```
Scenario text + hand gesture
          ↓
Local hazard-state controller          (instant, deterministic)
          ↓
Deterministic safety simulator         (physics, runs in-browser)
          ↓
Brake / Turn / Continue scores + trajectories
          ↓
Recommended action + spoken explanation
          ↓
Generated visualisation of the selected future   (illustration only)
```

Deterministic logic decides safety. Generated video only illustrates the selected future. The UI keeps the two visually distinct so a forecast is never confused with a rendering.

## Features

- **Scenario input** — plain text, no source image or video required
- **Gesture control** — the user *is* the obstacle; webcam frames are processed locally and never uploaded
- **Deterministic simulator** — longitudinal physics model; speeds are clamped at or above zero so the scene can never appear to reverse
- **Three-way counterfactual** — safety score, fatality risk, and an animated trajectory per branch
- **Ego vehicle voice** — the car speaks its decision in first person
- **Live generated video** — one persistent session, re-prompted (not restarted) as gestures change

### Gesture map

| Gesture | Obstacle behaviour | Ego reaction |
|---|---|---|
| ✋ Open palm | Brakes hard, stops | **BRAKE** |
| ☝ One finger | Slows, blocks the lane | **TURN** (overtake) |
| ✊ Closed fist | Holds steady speed | **CONTINUE** |

## Stack

| Purpose | Service |
|---|---|
| Live text-to-video | Reactor Helios |
| Scenario analysis | Anthropic Claude Haiku 4.5 |
| Advisory safety review | Anthropic Claude Opus 5 (opt-in) |
| Ego vehicle voice | Fish Audio TTS |
| Gesture recognition | MediaPipe Hand Landmarker (in-browser) |
| Driving physics | Custom canvas simulator (local, instant, zero API cost) |
| Optional cloud video | NVIDIA Cosmos (hidden unless configured) |

Framework: Next.js 16 · React 19 · TypeScript · Tailwind CSS 4

## Getting started

```bash
cd frontend
npm install
cp .env.example .env.local     # then fill in your own keys
npm run dev
```

Open http://localhost:3000

### Environment variables

Create `frontend/.env.local`. **All keys are server-side only.**

```bash
REACTOR_API_KEY=
ANTHROPIC_API_KEY=
FISH_AUDIO_API_KEY=

# Optional. Leave unset and the Cosmos control stays hidden.
NVIDIA_API_KEY=
NVIDIA_COSMOS_ENDPOINT=
```

> **Never prefix a secret with `NEXT_PUBLIC_`.** Next.js inlines those into the JavaScript bundle sent to every browser, which publishes the key. Every key here is read only inside API routes and is never exposed to the client.

`.env*` is gitignored. Nothing in this repository contains a real credential.

## Demo flow

1. Paste a scenario, e.g.
   > Ego car at 50 km/h in the middle lane of a city road. A white van is directly ahead in the same lane. The left lane is empty.
2. Click **Generate Futures** — three scored branches appear
3. Click **Enable Camera**, then show ✋ → ☝ → ✊
4. Scores, trajectories and the spoken callout update instantly; the video follows

**The strongest moment:** run the scenario above, then rerun it with *"the left lane carries oncoming traffic and the right lane is blocked."* Only one fact changes, and TURN collapses from ~84 to ~12 and becomes fatal. The system is reasoning about lateral escape availability, not replaying fixed numbers.

## Deployment

Deployed on Vercel from `frontend/`. If connecting via GitHub, set **Root Directory** to `frontend`.

Add `REACTOR_API_KEY`, `ANTHROPIC_API_KEY`, and `FISH_AUDIO_API_KEY` under Settings → Environment Variables, then redeploy — Vercel does not apply new variables to an existing deployment.

Camera access requires HTTPS, which Vercel provides automatically.

## Repository layout

```
frontend/          Next.js app (the deployed application)
  app/page.tsx     Dashboard, gesture controller, physics simulator
  app/api/         Server-side routes; all API keys live here
backend/           FastAPI telemetry scaffold — not used by the frontend
```

## Limitations

- **Generated video is illustrative, not a physics authority.** Reactor Helios may vary scenery or vehicle placement between runs. Prompting constrains this; it cannot guarantee exact traffic physics. The deterministic canvas simulator is the authoritative layer.
- **One live video session** by design — keeps credit usage low and avoids session-limit errors, so the three branches are not generated simultaneously.
- **Safety scores are a demo decision model**, not certified vehicle-control software. Do not present this as production automotive code.
- **NVIDIA Cosmos** is integrated but requires credentials; the control is hidden when unconfigured.
- `backend/` is an unused scaffold retained for reference.

## Privacy

Webcam frames are processed entirely in the browser by MediaPipe. No camera data is uploaded, stored, or sent to any API.
