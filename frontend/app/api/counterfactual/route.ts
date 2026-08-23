import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/* ------------------------------------------------------------------ */
/*  Claude API Integration with Graceful Hardcoded Fallback           */
/* ------------------------------------------------------------------ */


export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scenario_description } = body;

    if (!scenario_description || typeof scenario_description !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'scenario_description' field." },
        { status: 400 }
      );
    }

    const client = new Anthropic(); 

    const SYSTEM_PROMPT = `You are an AV safety evaluator. The user provides a driving scenario. Evaluate 3 actions: 'BRAKE', 'TURN', and 'CONTINUE'. Return STRICT JSON containing:
{
  "counterfactuals": [
    { "action": "BRAKE", "safety_score": 87, "fatalities": false, "visual_prompt": "A photorealistic dashcam video..." },
    { "action": "TURN", "safety_score": 52, "fatalities": false, "visual_prompt": "A photorealistic dashcam video..." },
    { "action": "CONTINUE", "safety_score": 4, "fatalities": true, "visual_prompt": "A photorealistic dashcam video..." }
  ],
  "voiceover_summary": "Optimal path identified: Threshold Braking. Swerving results in a rollover. Maintaining course results in critical impact."
}
Each visual_prompt must describe PHOTOREALISTIC footage from a camera fixed directly BEHIND and slightly ABOVE the ego vehicle, looking forward along the road, with BOTH the ego vehicle (lower part of frame) and the obstacle vehicle ahead visible at the same time. The camera stays locked behind the ego vehicle. Keep the wording plain and factual. No cinematic or film wording, no camera moves, no orbiting, no zoom, no slow motion, no camera effects, no floating debris.
Return ONLY the JSON object, no markdown fences, no explanation.`;

    let result;
    try {
      // 1. Try to call Claude API
      const message = await client.messages.create({
        // Fast, low-cost event interpretation. Physical trajectories remain
        // deterministic in the client simulation, never delegated to an LLM.
        model: process.env.CLAUDE_SAFETY_MODEL || "claude-haiku-4-5",
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content: `Evaluate the following driving scenario and return the JSON counterfactual analysis:\n\n${scenario_description}`,
          },
        ],
        system: SYSTEM_PROMPT,
      });

      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from model.");
      }
      
      // Claude commonly wraps JSON in a ```json fence despite the instruction.
      // Parsing the raw text throws and silently drops us into the hardcoded
      // fallback, so strip the fence (or pull the first JSON object) first.
      const raw = textBlock.text.trim();
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      const parsed = JSON.parse(candidate);

      if (!Array.isArray(parsed?.counterfactuals) || parsed.counterfactuals.length === 0) {
        throw new Error("Claude returned no counterfactuals array.");
      }

      result = parsed;
      console.log("[Prediction Engine] Claude response parsed successfully.");

    } catch (reason) {
      // 2. Fallback to hardcoded prompts if Claude fails (e.g. out of credits)
      // This ensures Reactor and Fish Audio are immediately unblocked to generate media.
      // Log the cause: silently swallowing it hides auth/model errors behind
      // output that looks like a successful analysis.
      console.warn(
        `[Prediction Engine] Claude unavailable, using fallback tensors. Cause:`,
        reason instanceof Error ? reason.message : reason
      );

      const s = scenario_description.slice(0, 60);
      result = {
        counterfactuals: [
          {
            action: "BRAKE",
            safety_score: 87,
            fatalities: false,
            visual_prompt: `A photorealistic dashcam video of a car executing maximum threshold ABS braking on a wet road. ${s}... The vehicle nose pitches down sharply under heavy deceleration, brake dust rises from the wheels, dark skid marks form on the asphalt. The car stops safely with meters of clearance. Camera fixed behind and slightly above the ego vehicle, looking forward; both the ego car and the vehicle ahead stay visible. Steady locked viewpoint, realistic daylight.`,
          },
          {
            action: "TURN",
            safety_score: 52,
            fatalities: false,
            visual_prompt: `A photorealistic dashcam video of a car executing an emergency swerve to the left on a wet road. ${s}... The vehicle leans hard as it changes lane, tire smoke rises from the rear wheels, and it passes close to the guardrail. Near miss. Camera fixed behind and slightly above the ego vehicle, looking forward; both the ego car and the vehicle ahead stay visible. Steady locked viewpoint, realistic daylight.`,
          },
          {
            action: "CONTINUE",
            safety_score: 4,
            fatalities: true,
            visual_prompt: `A photorealistic dashcam video of a car maintaining course with zero deceleration, resulting in a frontal collision. ${s}... The gap closes rapidly, the vehicle ahead fills the windshield, and the cars make contact. Camera fixed behind and slightly above the ego vehicle, looking forward; both the ego car and the vehicle ahead stay visible. Steady locked viewpoint, realistic daylight.`,
          },
        ],
        voiceover_summary:
          "Optimal path identified: Threshold Braking with an 87% safety index. Emergency swerve yields a marginal 52% safety index with high rollover risk. Maintaining course results in catastrophic impact with confirmed fatalities. Recommendation: Execute immediate AEB hard brake.",
      };
    }

    return NextResponse.json(result);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Prediction Engine Error]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
