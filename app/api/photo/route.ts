import { NextRequest, NextResponse } from "next/server";
import { KEYS, patchTask, redis } from "@/lib/state";

export const dynamic = "force-dynamic";

/** Phones downscale before upload; this is a backstop against a huge payload. */
const MAX_BYTES = 400_000;

/**
 * Photo evidence for jobs that need eyes in a room.
 *
 * Stored as a data URL under its own key — deliberately NOT in the state
 * snapshot, which forty phones poll once a second. The projector fetches it
 * once, when a task reports hasPhoto.
 */
export async function POST(req: NextRequest) {
  const { taskId, dataUrl, workerId } = await req.json();
  if (!taskId || typeof dataUrl !== "string") {
    return NextResponse.json({ error: "taskId and dataUrl required" }, { status: 400 });
  }

  // Only the worker holding the claim may attach evidence to it.
  const held = await redis().get<string>(KEYS.claim(taskId));
  const [winnerId] = (held ?? "").split(":");
  if (!winnerId || winnerId !== workerId) {
    return NextResponse.json({ error: "you don't hold this job" }, { status: 403 });
  }
  if (!dataUrl.startsWith("data:image/")) {
    return NextResponse.json({ error: "expected an image data URL" }, { status: 400 });
  }
  if (dataUrl.length > MAX_BYTES) {
    return NextResponse.json({ error: "image too large" }, { status: 413 });
  }

  await redis().set(KEYS.photo(taskId), dataUrl, { ex: 60 * 60 });
  await patchTask(taskId, (t) => {
    t.hasPhoto = true;
  });

  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return new Response("taskId required", { status: 400 });

  const dataUrl = await redis().get<string>(KEYS.photo(taskId));
  if (!dataUrl) return new Response("not found", { status: 404 });

  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  return new Response(Buffer.from(b64, "base64"), {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=60" },
  });
}
