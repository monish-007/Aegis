import { NextResponse } from "next/server";

export async function POST() {
  try {
    // Keep the long-lived Reactor credential on the server. Session JWTs are
    // short-lived and are the only credential the browser receives.
    const apiKey = process.env.REACTOR_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "Reactor is not configured on the server." },
        { status: 503 }
      );
    }

    const r = await fetch("https://api.reactor.inc/tokens", {
      method: "POST",
      headers: {
        "Reactor-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        authorization_details: [
          {
            type: "session",
            resources: { models: { match: ["reactor/helios"] } },
            constraints: { max_sessions: 1 }
          }
        ]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return NextResponse.json({ error: "Failed to get Reactor token: " + err }, { status: r.status });
    }

    const data = await r.json();
    return NextResponse.json(data); // returns { jwt: "..." }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
