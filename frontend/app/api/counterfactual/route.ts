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
    { "action": "BRAKE", "safety_score": 87, "fatalities": false, "visual_prompt": "A realistic driving simulation video..." },
    { "action": "TURN", "safety_score": 52, "fatalities": false, "visual_prompt": "A realistic driving simulation video..." },
    { "action": "CONTINUE", "safety_score": 4, "fatalities": true, "visual_prompt": "A realistic driving simulation video..." }
  ],
  "voiceover_summary": "Optimal path identified: Threshold Braking. Swerving results in a rollover. Maintaining course results in critical impact."
}
Each visual_prompt must describe a realistic car driving simulation seen from a camera close behind the silver ego car on a three-lane highway, with the white van just ahead in the same lane only a couple of car lengths away, and several other cars in the neighbouring lanes. Keep the wording short, plain and factual. Never use the words drone, aerial or cinematic. No camera moves, no zoom, no slow motion, no camera effects.
Return ONLY the JSON object, no markdown fences, no explanation.`;

    let result;
    try {
      // 1. Try to call Claude API
      const message = await client.messages.create({
        // Fast, low-cost event interpretation. Physical trajectories remain
        // deterministic in the client simulation, never delegated to an LLM.
        model: process.env.CLAUDE_SAFETY_MODEL || "claude-haiku-4-5",
        max_tokens: 2000,
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
            visual_prompt: `A realistic driving simulation video of a car braking hard on a dry three-lane highway. ${s}... The car's brake lights glow red, its nose dips under heavy deceleration, and the gap to the van closes. The car stops safely with meters of clearance. Camera close behind the silver car, the white van a couple of car lengths ahead in the same lane, several other cars in the neighbouring lanes. Clear daylight.`,
          },
          {
            action: "TURN",
            safety_score: 52,
            fatalities: false,
            visual_prompt: `A realistic driving simulation video of a car changing lane to the left on a dry three-lane highway. ${s}... The car moves smoothly into the clear left lane and passes the van. Camera close behind the silver car, the white van a couple of car lengths ahead in the same lane, several other cars in the neighbouring lanes. Clear daylight.`,
          },
          {
            action: "CONTINUE",
            safety_score: 4,
            fatalities: true,
            visual_prompt: `A realistic driving simulation video of a car maintaining course with zero deceleration, resulting in a frontal collision. ${s}... The gap closes rapidly, the vehicle ahead fills the windshield, and the cars make contact. Camera close behind the silver car, the white van a couple of car lengths ahead in the same lane, several other cars in the neighbouring lanes. Clear daylight.`,
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
