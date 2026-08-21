"use client";

import type { MaterialId } from "@/data/materials";
import { getMaterial, MATERIALS } from "@/data/materials";
import {
  BATTERY,
  POWER_MODES,
  PRODUCT,
  SPECS,
  runtimeHours,
} from "@/data/specs";

/**
 * Generates the technical data sheet in the browser.
 *
 * No server, no template file, no pre-rendered PDF sitting in `public/`. The
 * document is composed at click time from the same `SPECS` and `POWER_MODES`
 * the rest of the site reads, which means it cannot fall out of step with the
 * page the way a checked-in PDF always eventually does.
 *
 * pdf-lib is loaded dynamically — it is ~120 KB gzip, and it should not be part
 * of the bytes that decide how fast the hero paints.
 *
 * Fonts are the built-in Helvetica and Courier. Embedding Geist would mean
 * shipping a TTF plus fontkit for a document nobody reads for its typography,
 * and the monospaced column is the only thing that actually matters here.
 */
export async function buildSpecSheet(materialId: MaterialId): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const doc = await PDFDocument.create();
  doc.setTitle(`${PRODUCT.name} — Technical Data Sheet`);
  doc.setAuthor(PRODUCT.name);
  doc.setSubject("Neural audio wearable, technical specification");
  doc.setProducer("Generated in-browser with pdf-lib");
  doc.setCreationDate(new Date());

  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const { width, height } = page.getSize();

  const ink = rgb(0.06, 0.06, 0.07);
  const dim = rgb(0.42, 0.42, 0.46);
  const rule = rgb(0.85, 0.85, 0.87);
  const signal = rgb(0.1, 0.55, 0.72);

  const margin = 48;
  let y = height - margin;

  const line = (atY: number, colour = rule) =>
    page.drawLine({
      start: { x: margin, y: atY },
      end: { x: width - margin, y: atY },
      thickness: 0.5,
      color: colour,
    });

  // ---- Masthead ----------------------------------------------------------
  page.drawText(PRODUCT.name, {
    x: margin,
    y: y - 26,
    size: 26,
    font: sansBold,
    color: ink,
  });
  page.drawText(PRODUCT.tagline, {
    x: margin,
    y: y - 44,
    size: 10.5,
    font: sans,
    color: dim,
  });
  page.drawText("TECHNICAL DATA SHEET", {
    x: width - margin - sans.widthOfTextAtSize("TECHNICAL DATA SHEET", 8),
    y: y - 26,
    size: 8,
    font: mono,
    color: signal,
  });

  y -= 62;
  line(y);
  y -= 24;

  // ---- Configuration -----------------------------------------------------
  const material = getMaterial(materialId);
  page.drawText("CONFIGURATION", {
    x: margin,
    y,
    size: 8,
    font: mono,
    color: dim,
  });
  y -= 16;
  page.drawText(`${material.name}  (${material.code})`, {
    x: margin,
    y,
    size: 12,
    font: sansBold,
    color: ink,
  });
  y -= 15;
  page.drawText(material.blurb, { x: margin, y, size: 9.5, font: sans, color: dim });
  y -= 26;

  // ---- Specification -----------------------------------------------------
  page.drawText("SPECIFICATION", { x: margin, y, size: 8, font: mono, color: dim });
  y -= 6;
  line(y);
  y -= 16;

  for (const row of SPECS) {
    page.drawText(row.label, { x: margin, y, size: 9.5, font: sans, color: ink });
    const value = row.unit ? `${row.value} ${row.unit}` : row.value;
    // Right-aligned: a spec column that does not line up is a spec sheet
    // nobody trusts.
    page.drawText(value, {
      x: width - margin - mono.widthOfTextAtSize(value, 9.5),
      y,
      size: 9.5,
      font: mono,
      color: ink,
    });
    y -= 15;
  }

  y -= 12;

  // ---- Power model -------------------------------------------------------
  page.drawText("POWER MODEL", { x: margin, y, size: 8, font: mono, color: dim });
  y -= 6;
  line(y);
  y -= 16;

  page.drawText(
    `${BATTERY.milliampHours} mAh at ${BATTERY.nominalVolts} V nominal = ${BATTERY.milliwattHours.toFixed(1)} mWh`,
    { x: margin, y, size: 9.5, font: sans, color: dim },
  );
  y -= 18;

  for (const mode of POWER_MODES) {
    const hours = runtimeHours(mode.mw);
    page.drawText(mode.label, { x: margin, y, size: 9.5, font: sans, color: ink });
    const value = `${mode.mw} mW  ·  ${hours.toFixed(1)} h`;
    page.drawText(value, {
      x: width - margin - mono.widthOfTextAtSize(value, 9.5),
      y,
      size: 9.5,
      font: mono,
      color: ink,
    });

    // Bar showing runtime relative to the longest mode.
    const longest = runtimeHours(Math.min(...POWER_MODES.map((m) => m.mw)));
    const barWidth = (width - margin * 2) * (hours / longest);
    page.drawRectangle({
      x: margin,
      y: y - 6,
      width: barWidth,
      height: 1.5,
      color: signal,
    });
    y -= 20;
  }

  y -= 6;

  // ---- Finishes ----------------------------------------------------------
  page.drawText("AVAILABLE FINISHES", {
    x: margin,
    y,
    size: 8,
    font: mono,
    color: dim,
  });
  y -= 6;
  line(y);
  y -= 16;

  for (const finish of MATERIALS) {
    const swatch = hexToRgb(finish.tint);
    page.drawRectangle({
      x: margin,
      y: y - 2,
      width: 10,
      height: 10,
      color: rgb(swatch[0], swatch[1], swatch[2]),
      borderColor: rule,
      borderWidth: 0.5,
    });
    page.drawText(`${finish.code}   ${finish.name}`, {
      x: margin + 18,
      y,
      size: 9.5,
      font: finish.id === materialId ? sansBold : sans,
      color: ink,
    });
    y -= 16;
  }

  // ---- Colophon ----------------------------------------------------------
  line(margin + 26);
  const stamp = `Generated ${new Date().toISOString().slice(0, 10)} in-browser · no server involved`;
  page.drawText(stamp, {
    x: margin,
    y: margin + 12,
    size: 7.5,
    font: mono,
    color: dim,
  });

  const bytes = await doc.save();
  return new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

/** Saves the blob under a sensible file name and cleans up the object URL. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers; one frame
  // is enough for the navigation to have been queued.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
