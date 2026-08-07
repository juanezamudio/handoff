import { NextRequest } from "next/server";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";

/**
 * QR for the projector. Rendered as SVG so it stays razor-sharp at any size —
 * a blurry code that forty phones fail to scan would end the demo before it
 * started.
 *
 * The URL is passed in by the stage page (which knows its own origin), so the
 * same code works for localhost-over-LAN during rehearsal and for the deployed
 * URL on the day, with nothing to reconfigure.
 */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url") ?? req.nextUrl.origin;

  const svg = await QRCode.toString(target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
}
