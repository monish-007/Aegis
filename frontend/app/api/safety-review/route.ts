import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(request: NextRequest) {
  try {
    const { scenario, hazard, counterfactuals } = await request.json();
    if (typeof scenario !== "string" || !Array.isArray(counterfactuals)) {
      return NextResponse.json({ error: "Scenario and counterfactuals are required." }, { status: 400 });
    }
    const client = new Anthropic();
    const message = await client.messages.create({
      // Opus is intentionally opt-in: it is an advisory review, never the
      // real-time control loop or the physics authority.
      model: process.env.CLAUDE_OPUS_REVIEW_MODEL || "claude-opus-5",
      max_tokens: 500,
      system: "You are an advisory autonomous-vehicle safety reviewer. Review the supplied deterministic forecast. Do not claim certification or real-world control authority. Return concise plain text: recommended action, key uncertainty, and what sensor/physics data is missing.",
      messages: [{ role: "user", content: JSON.stringify({ scenario, hazard, counterfactuals }) }],
    });
    const text = message.content.find((block) => block.type === "text");
    return NextResponse.json({ review: text?.type === "text" ? text.text : "No review returned." });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
