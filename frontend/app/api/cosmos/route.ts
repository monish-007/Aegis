import { NextRequest, NextResponse } from "next/server";

// Demo-length clip. Cosmos renders ~16 fps, so 81 frames is roughly 5 seconds
// — kept well under the 197-frame 720-tier ceiling so generation stays fast.
const DEFAULT_REQUEST = {
  resolution: "720_16_9",
  num_output_frames: 81,
  fps: 16,
};

// Lets the dashboard hide the Cosmos control instead of offering a button that
// can only fail. Reports configuration state only — never the key itself.
export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.NVIDIA_API_KEY && process.env.NVIDIA_COSMOS_ENDPOINT),
  });
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.NVIDIA_API_KEY;
  const endpoint = process.env.NVIDIA_COSMOS_ENDPOINT;

  if (!apiKey || !endpoint) {
    return NextResponse.json(
      {
        error:
          "Cosmos is not configured. Add NVIDIA_API_KEY and NVIDIA_COSMOS_ENDPOINT to .env.local, then restart the dev server.",
      },
      { status: 503 }
    );
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return NextResponse.json({ error: "NVIDIA_COSMOS_ENDPOINT is not a valid URL." }, { status: 500 });
  }

  // URL.protocol keeps its trailing colon ("https:"), so compare against that.
  if (endpointUrl.protocol !== "https:") {
    return NextResponse.json({ error: "NVIDIA_COSMOS_ENDPOINT must use HTTPS." }, { status: 500 });
  }

  let body: { prompt?: unknown; seed?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "A video prompt is required." }, { status: 400 });
  }

  try {
    const upstream = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ...DEFAULT_REQUEST,
        prompt,
        ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    let payload = await upstream.json().catch(() => null);
    if (!upstream.ok && upstream.status !== 202) {
      const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : "Unknown NVIDIA response";
      return NextResponse.json({ error: `Cosmos request failed (${upstream.status}): ${detail}` }, { status: upstream.status });
    }

    // NVCF queues long generations: 202 + NVCF-REQID, then poll the status URL
    // until it flips to 200 with the finished payload.
    let status = upstream.status;
    const requestId = upstream.headers.get("NVCF-REQID");
    for (let attempt = 0; status === 202 && requestId && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const poll = await fetch(`https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${requestId}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      status = poll.status;
      payload = await poll.json().catch(() => null);
      if (!poll.ok && status !== 202) {
        return NextResponse.json({ error: `Cosmos polling failed (${status}).` }, { status });
      }
    }

    if (status === 202) {
      return NextResponse.json({ error: "Cosmos is still rendering; try again shortly." }, { status: 504 });
    }

    // NVIDIA has shipped the clip under several field names depending on the
    // deployment, so accept any of them before giving up.
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const asset = Array.isArray(record.artifacts) && record.artifacts.length
      ? (record.artifacts[0] as Record<string, unknown>)
      : {};
    const encoded = [record.b64_video, record.video, record.b64_json, asset.base64, asset.b64_video]
      .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
    if (!encoded) {
      return NextResponse.json({ error: "Cosmos returned no video payload." }, { status: 502 });
    }

    const video = Buffer.from(encoded.replace(/^data:video\/[^;]+;base64,/, ""), "base64");
    return new NextResponse(video, {
      headers: {
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    return NextResponse.json({ error: `Cosmos connection failed: ${message}` }, { status: 502 });
  }
}
