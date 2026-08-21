import { ImageResponse } from "next/og";
import { PRODUCT } from "@/data/specs";

export const alt = `${PRODUCT.name} — ${PRODUCT.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social card, composed at build time.
 *
 * Generated rather than exported from a design tool for the same reason as the
 * PDF: a checked-in image drifts the moment the tagline changes, and nobody
 * notices because nobody looks at their own OG card.
 *
 * Deliberately typographic. A product render at 1200×630 would be either
 * illegible or another megabyte in the repo, and the wordmark is what has to
 * survive being shown as a 400px-wide thumbnail in a chat client anyway.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#09090b",
          padding: 72,
          // Satori has no access to our stylesheet, so the palette is repeated
          // here as literals. Kept in sync by being the only four values used.
          color: "#ededf0",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "#4fd1ff",
            }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 22,
              letterSpacing: 6,
              color: "#838391",
            }}
          >
            NEURAL AUDIO WEARABLE
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 96, lineHeight: 1, letterSpacing: -4 }}>
            {`${PRODUCT.name}.`}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 96,
              lineHeight: 1.05,
              letterSpacing: -4,
              color: "#838391",
            }}
          >
            {PRODUCT.tagline}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 22,
            letterSpacing: 4,
            color: "#838391",
          }}
        >
          <div style={{ display: "flex" }}>ON-DEVICE INFERENCE</div>
          <div style={{ display: "flex", color: "#4fd1ff" }}>
            {`${PRODUCT.weightGrams} G`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
