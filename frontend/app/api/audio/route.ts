import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();

    if (!process.env.FISH_AUDIO_API_KEY) {
      return NextResponse.json({ error: "Fish Audio is not configured on the server." }, { status: 503 });
    }

    const r = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.FISH_AUDIO_API_KEY || ""}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return NextResponse.json({ error: "Fish Audio Error: " + err }, { status: r.status });
    }

    // Fish Audio returns raw audio (e.g. mp3/wav buffer)
    const arrayBuffer = await r.arrayBuffer();
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "audio/mpeg",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
