// LabelCropperTool.jsx
//
// A paid-plan feature: crop shipping labels out of Meesho / Flipkart / Amazon
// seller-panel PDFs (which usually bundle the label together with an
// invoice or extra blank space on the same page).
//
// How it works:
//   1. Seller picks their platform (just changes the starting guess box).
//   2. Seller uploads the PDF they downloaded from their seller panel.
//   3. We render page 1 with pdf.js and show a draggable/resizable box the
//      seller can adjust so it sits exactly over the label.
//   4. On confirm, we use pdf-lib to set that same crop box on every page of
//      the real PDF (a true vector crop — barcodes/QR stay full quality,
//      nothing is rasterized) and offer the cropped file for download.
//   5. The chosen box is remembered per platform in localStorage, so next
//      time the seller uploads a same-platform file the box is already in
//      the right place — no repeat fiddling.
//
// This intentionally does NOT try to "AI-auto-detect" the label region,
// because Meesho/Flipkart/Amazon PDF layouts vary by seller settings (page
// size, whether invoice is attached, single vs multi-order files). A
// remembered, seller-adjusted box is more reliable than a guess that could
// silently clip a barcode.

import React, { useState, useRef, useEffect, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";
import { supabase } from "./supabaseClient";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Fire-and-forget activity logging — same pattern as SellerDoctorTool's
// logActivity, kept local here so this file doesn't need a shared import.
async function logActivity(actionType, details = {}) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("activity_log").insert({ user_id: user.id, action_type: actionType, details });
  } catch (err) {
    console.error("Activity log failed:", err);
  }
}

const PLATFORMS = [
  { id: "meesho", label: "Meesho", icon: "🟣", defaultBox: { x: 0.04, y: 0.03, w: 0.92, h: 0.46 } },
  { id: "flipkart", label: "Flipkart", icon: "🟡", defaultBox: { x: 0.04, y: 0.02, w: 0.92, h: 0.48 } },
  { id: "amazon", label: "Amazon", icon: "🟠", defaultBox: { x: 0.03, y: 0.02, w: 0.94, h: 0.5 } },
];

const STORAGE_PREFIX = "gd_label_crop_box_";

// Bulk PDFs from Meesho/Flipkart/Amazon mix pages in different ways:
// sometimes the label and its tax invoice are on two SEPARATE pages,
// sometimes they're printed on the SAME page (barcode/AWB block on top,
// a full GST tax-invoice table right below it). Scanning only for invoice
// wording would wrongly drop that second, combined-page case too — it has
// plenty of "HSN"/"Seller Registered Address"/"E. & O.E." text even though
// the top half is a perfectly good, croppable label. So a page is only
// treated as invoice-only (and dropped) when it has invoice wording AND
// none of these label-only markers, which are standard across all three
// platforms' shipping labels.
const INVOICE_MARKERS = [
  "e. & o.e.", "e & o e", "tax invoice", "hsn", "seller registered address",
  "total qty", "taxable value", "irn", "cess", "gstin",
].map((m) => m.replace(/[^a-z0-9]/g, ""));
const INVOICE_MARKER_MIN_HITS = 2;

const LABEL_MARKERS = [
  "awb", "ordered through", "hbd", "cpd", "destination code",
  "not for resale", "shipping/customer address",
  "if undelivered, return to", "do not collect cash", "customer address",
].map((m) => m.replace(/[^a-z0-9]/g, ""));

// On combined label+invoice pages, the "Tax Invoice" heading marks exactly
// where the invoice section begins — so instead of guessing a fixed crop
// height per platform, we look up that heading's real Y position on the
// page and use it to compute the correct height for THIS specific file.
// This works for any seller's page margins/layout without anyone needing
// to manually adjust the box.
async function findLabelBottomFraction(page) {
  const [content, viewport] = await Promise.all([
    page.getTextContent(),
    page.getViewport({ scale: 1 }),
  ]);
  const items = content.items;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let i = 0; i < items.length; i++) {
    const single = norm(items[i].str);
    const pair = i + 1 < items.length ? norm(items[i].str + items[i + 1].str) : "";
    if (single === "taxinvoice" || pair === "taxinvoice") {
      const yFromBottom = items[i].transform[5];
      const fractionFromTop = 1 - yFromBottom / viewport.height;
      // Small buffer above the heading so its top edge/underline isn't
      // clipped right at the crop line.
      return Math.max(0.05, fractionFromTop - 0.012);
    }
  }
  return null;
}

async function classifyPages(pdfjsDoc) {
  const results = [];
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js splits text into arbitrary fragments; joining with spaces can
    // still leave inconsistent spacing/punctuation around fragment
    // boundaries (e.g. "Seller Registered  Address" or "E .& O . E ."), so
    // multi-word/punctuated markers can silently fail to match on a raw
    // joined string. Stripping everything except letters/digits before
    // comparing makes the match immune to that.
    const rawText = content.items.map((it) => it.str).join(" ").toLowerCase();
    const normalized = rawText.replace(/[^a-z0-9]/g, "");
    const invoiceHits = INVOICE_MARKERS.reduce((n, marker) => n + (normalized.includes(marker) ? 1 : 0), 0);
    const hasLabelMarker = LABEL_MARKERS.some((marker) => normalized.includes(marker));
    const isInvoice = invoiceHits >= INVOICE_MARKER_MIN_HITS && !hasLabelMarker;
    const labelBottomFraction = isInvoice ? null : await findLabelBottomFraction(page);
    results.push({ pageIndex: i - 1, isInvoice, labelBottomFraction });
  }
  return results;
}

function loadSavedBox(platformId) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + platformId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.x === "number" && typeof parsed.y === "number" &&
      typeof parsed.w === "number" && typeof parsed.h === "number"
    ) return parsed;
  } catch (_) {}
  return null;
}

function saveBox(platformId, box) {
  try { localStorage.setItem(STORAGE_PREFIX + platformId, JSON.stringify(box)); } catch (_) {}
}

const HANDLE_SIZE = 14;
const EDGE_HANDLE_LENGTH = 28;
const EDGE_HANDLE_THICKNESS = 10;

export default function LabelCropperTool({ onBack }) {
  const [platform, setPlatform] = useState("meesho");
  const [file, setFile] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null); // ArrayBuffer of the uploaded file
  const [pageCount, setPageCount] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null); // rendered page-1 image
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 }); // rendered canvas px size
  const [box, setBox] = useState(PLATFORMS[0].defaultBox); // normalized 0..1 crop box
  const [pageClassification, setPageClassification] = useState([]); // [{pageIndex, isInvoice}]
  const [status, setStatus] = useState("idle"); // idle | rendering | ready | cropping | done | error
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState(null);
  const [resultName, setResultName] = useState("");
  const [resultCount, setResultCount] = useState(0);
  const fileInputRef = useRef(null);
  const stageRef = useRef(null);
  const dragState = useRef(null);
  const boxRef = useRef(box);
  useEffect(() => { boxRef.current = box; }, [box]);

  const platformDef = PLATFORMS.find((p) => p.id === platform);

  // Switching platform (before a file is loaded) updates the starting box.
  useEffect(() => {
    if (!previewUrl) {
      const saved = loadSavedBox(platform);
      setBox(saved || platformDef.defaultBox);
    }
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetAll = () => {
    setFile(null);
    setPdfBytes(null);
    setPageCount(0);
    setPreviewUrl(null);
    setPreviewSize({ w: 0, h: 0 });
    setStatus("idle");
    setError("");
    setResultUrl(null);
    setResultName("");
    setPageClassification([]);
  };

  const handleUpload = async (f) => {
    setError("");
    setResultUrl(null);
    if (!f || f.type !== "application/pdf") {
      setError("Sirf PDF file upload karo — jo seller panel se download hoti hai.");
      return;
    }
    setStatus("rendering");
    try {
      const buf = await f.arrayBuffer();
      setFile(f);
      setPdfBytes(buf);

      const loadingTask = pdfjsLib.getDocument({ data: buf.slice(0) });
      const pdf = await loadingTask.promise;
      setPageCount(pdf.numPages);

      const classification = await classifyPages(pdf);
      setPageClassification(classification);
      const firstLabelEntry = classification.find((c) => !c.isInvoice);
      const previewPageNum = firstLabelEntry ? firstLabelEntry.pageIndex + 1 : 1;

      const page = await pdf.getPage(previewPageNum);
      const scale = 1.6;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      setPreviewUrl(canvas.toDataURL("image/png"));
      setPreviewSize({ w: viewport.width, h: viewport.height });

      const saved = loadSavedBox(platform);
      const base = saved || platformDef.defaultBox;
      const detectedBottom = firstLabelEntry?.labelBottomFraction;
      // Prefer the per-file detected boundary for height/top — it's exact
      // for this specific PDF, so it works correctly the very first time,
      // for every seller, without anyone adjusting anything. Horizontal
      // fit isn't auto-detectable the same way, so that still comes from
      // the saved/default box.
      const box = detectedBottom
        ? { x: base.x, y: 0.02, w: base.w, h: Math.max(0.1, detectedBottom - 0.02) }
        : base;
      setBox(box);
      setStatus("ready");
    } catch (err) {
      console.error(err);
      setError("PDF read nahi ho payi — file corrupt ho sakti hai ya password-protected hai.");
      setStatus("error");
    }
  };

  // ---- Drag / resize handling for the crop box overlay ----
  const onPointerDown = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    dragState.current = {
      mode, // 'move' | 'nw' | 'ne' | 'sw' | 'se'
      startX: e.clientX,
      startY: e.clientY,
      rectW: rect.width,
      rectH: rect.height,
      startBox: { ...box },
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onPointerMove = useCallback((e) => {
    const ds = dragState.current;
    if (!ds) return;
    const dx = (e.clientX - ds.startX) / ds.rectW;
    const dy = (e.clientY - ds.startY) / ds.rectH;
    let { x, y, w, h } = ds.startBox;

    if (ds.mode === "move") {
      x = clamp(ds.startBox.x + dx, 0, 1 - ds.startBox.w);
      y = clamp(ds.startBox.y + dy, 0, 1 - ds.startBox.h);
    } else {
      if (ds.mode.includes("w")) { x = clamp(ds.startBox.x + dx, 0, ds.startBox.x + ds.startBox.w - 0.05); w = ds.startBox.w - (x - ds.startBox.x); }
      if (ds.mode.includes("e")) { w = clamp(ds.startBox.w + dx, 0.05, 1 - ds.startBox.x); }
      if (ds.mode.includes("n")) { y = clamp(ds.startBox.y + dy, 0, ds.startBox.y + ds.startBox.h - 0.05); h = ds.startBox.h - (y - ds.startBox.y); }
      if (ds.mode.includes("s")) { h = clamp(ds.startBox.h + dy, 0.05, 1 - ds.startBox.y); }
    }
    setBox({ x, y, w, h });
  }, []);

  const onPointerUp = useCallback(() => {
    dragState.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // Remember the adjusted box immediately, so the NEXT upload for this
    // platform starts here automatically — the seller shouldn't have to
    // re-fit the box every single time, only fine-tune it if needed.
    saveBox(platform, boxRef.current);
  }, [onPointerMove, platform]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove, onPointerUp]);

  // ---- Actual crop + export, using pdf-lib (vector crop, only label pages) ----
  const handleCropAndDownload = async () => {
    if (!pdfBytes) return;
    setStatus("cropping");
    setError("");
    try {
      const doc = await PDFDocument.load(pdfBytes);
      const pages = doc.getPages();
      const isInvoiceAt = (idx) => pageClassification[idx]?.isInvoice;

      pages.forEach((page, idx) => {
        if (isInvoiceAt(idx)) return; // leave invoice pages uncropped for now — dropped below
        const { width, height } = page.getSize();
        // PDF coordinate origin is bottom-left; our box.y is measured from
        // the top of the preview, so flip it.
        const cropX = box.x * width;
        const cropW = box.w * width;
        const cropH = box.h * height;
        const cropY = height - (box.y * height) - cropH;
        page.setCropBox(cropX, cropY, cropW, cropH);
        page.setMediaBox(cropX, cropY, cropW, cropH);
      });

      // Drop invoice/non-label pages entirely, highest index first so
      // removal doesn't shift the indices we still need to remove.
      for (let idx = pages.length - 1; idx >= 0; idx--) {
        if (isInvoiceAt(idx)) doc.removePage(idx);
      }

      const keptCount = doc.getPageCount();
      if (keptCount === 0) {
        setError("Is file mein koi bhi shipping label nahi mila — sirf invoice/tax pages hain. Apni seller panel se sahi 'Label' file (invoice nahi) download karke try karo.");
        setStatus("ready");
        return;
      }

      const outBytes = await doc.save();
      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const base = (file?.name || "labels").replace(/\.pdf$/i, "");
      setResultUrl(url);
      setResultName(`${base}-${platform}-labels-only.pdf`);
      setResultCount(keptCount);
      saveBox(platform, box);
      logActivity("label_crop", { platform, labelCount: keptCount });
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError("Crop karte waqt error aayi — file dobara try karo.");
      setStatus("error");
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", color: "#1a1a1a", padding: "24px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "#0F6E56", textTransform: "uppercase", margin: "0 0 4px" }}>GetDigitals Seller Doctor</p>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Label Cropper</h1>
        </div>
        <button onClick={onBack} style={{ background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "6px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>← Wapas</button>
      </div>

      <p style={{ fontSize: 13, color: "#6b6b68", margin: "0 0 18px", lineHeight: 1.6 }}>
        Apni Meesho, Flipkart ya Amazon bulk PDF upload karo — invoice pages apne aap detect karke hata di jaati hain, sirf clean labels crop karke milte hain.
      </p>

      {/* Platform picker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => { setPlatform(p.id); if (!previewUrl) resetAll(); }}
            style={{
              flex: 1, padding: "10px 8px", borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
              border: platform === p.id ? "1.5px solid #0F6E56" : "1px solid #e5e4df",
              background: platform === p.id ? "#EAF6F2" : "#fff",
              color: platform === p.id ? "#0F6E56" : "#6b6b68",
            }}
          >
            {p.icon} {p.label}
          </button>
        ))}
      </div>

      {!previewUrl && (
        <div style={{ maxWidth: 480, margin: "20px auto", textAlign: "center" }}>
          <input type="file" accept="application/pdf" ref={fileInputRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0])} />
          <button
            onClick={() => fileInputRef.current.click()}
            disabled={status === "rendering"}
            style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%", opacity: status === "rendering" ? 0.6 : 1 }}
          >
            {status === "rendering" ? "PDF load ho rahi hai..." : `${platformDef.label} label PDF upload karo`}
          </button>
          {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 14 }}>{error}</p>}
          <p style={{ fontSize: 11, color: "#9a9a95", marginTop: 14, lineHeight: 1.6 }}>
            File sirf tumhare browser mein process hoti hai — kahi upload/store nahi hoti.
          </p>
        </div>
      )}

      {previewUrl && status !== "done" && (
        <>
          {(() => {
            const invoiceCount = pageClassification.filter((c) => c.isInvoice).length;
            const labelCount = pageClassification.length - invoiceCount;
            return invoiceCount > 0 ? (
              <div style={{ background: "#FFF7E6", border: "1px solid #F0C36D", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12.5, color: "#7a5b12" }}>
                📄 {labelCount} label page{labelCount === 1 ? "" : "s"} aur {invoiceCount} invoice/extra page{invoiceCount === 1 ? "" : "s"} detect hui — invoice pages final PDF mein nahi aayengi.
              </div>
            ) : null;
          })()}
          <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>
            Box ko drag/resize karke label ke upar exactly set karo (label page ka preview — same box har detected label page pe lagega):
          </p>
          <div
            ref={stageRef}
            style={{ position: "relative", width: "100%", maxWidth: 460, margin: "0 auto", border: "1px solid #e5e4df", borderRadius: 8, overflow: "hidden", touchAction: "none" }}
          >
            <img src={previewUrl} alt="PDF label page preview" style={{ display: "block", width: "100%", userSelect: "none", pointerEvents: "none" }} draggable={false} />
            <div
              onPointerDown={(e) => onPointerDown(e, "move")}
              style={{
                position: "absolute",
                left: `${box.x * 100}%`, top: `${box.y * 100}%`,
                width: `${box.w * 100}%`, height: `${box.h * 100}%`,
                border: "2px solid #0F6E56", background: "rgba(15,110,86,0.12)", cursor: "move",
              }}
            >
              {["nw", "ne", "sw", "se"].map((corner) => (
                <div
                  key={corner}
                  onPointerDown={(e) => onPointerDown(e, corner)}
                  style={{
                    position: "absolute", width: HANDLE_SIZE, height: HANDLE_SIZE, background: "#0F6E56", borderRadius: 3,
                    cursor: `${corner}-resize`,
                    top: corner.includes("n") ? -HANDLE_SIZE / 2 : undefined,
                    bottom: corner.includes("s") ? -HANDLE_SIZE / 2 : undefined,
                    left: corner.includes("w") ? -HANDLE_SIZE / 2 : undefined,
                    right: corner.includes("e") ? -HANDLE_SIZE / 2 : undefined,
                    zIndex: 2,
                  }}
                />
              ))}
              {/* Edge-midpoint handles: drag ONLY width (e/w) or ONLY height
                  (n/s) without the other dimension shifting at the same
                  time — corner handles change both together, which makes it
                  hard to just widen the box. No cap on how wide/tall it can
                  go beyond the page edges. */}
              {["n", "s", "e", "w"].map((edge) => {
                const isVertical = edge === "n" || edge === "s";
                return (
                  <div
                    key={edge}
                    onPointerDown={(e) => onPointerDown(e, edge)}
                    style={{
                      position: "absolute",
                      width: isVertical ? EDGE_HANDLE_LENGTH : EDGE_HANDLE_THICKNESS,
                      height: isVertical ? EDGE_HANDLE_THICKNESS : EDGE_HANDLE_LENGTH,
                      background: "#0F6E56", borderRadius: 3, opacity: 0.85,
                      cursor: isVertical ? "ns-resize" : "ew-resize",
                      top: edge === "n" ? -EDGE_HANDLE_THICKNESS / 2 : edge === "s" ? undefined : "50%",
                      bottom: edge === "s" ? -EDGE_HANDLE_THICKNESS / 2 : undefined,
                      left: edge === "w" ? -EDGE_HANDLE_THICKNESS / 2 : edge === "e" ? undefined : "50%",
                      right: edge === "e" ? -EDGE_HANDLE_THICKNESS / 2 : undefined,
                      transform: isVertical ? "translateX(-50%)" : "translateY(-50%)",
                      zIndex: 2,
                    }}
                  />
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button onClick={resetAll} style={{ flex: "0 0 auto", background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "12px 18px", borderRadius: 8, fontSize: 14, cursor: "pointer" }}>
              Naya file
            </button>
            <button
              onClick={handleCropAndDownload}
              disabled={status === "cropping"}
              style={{ flex: 1, background: "#0F6E56", color: "#fff", border: "none", padding: "12px 18px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", opacity: status === "cropping" ? 0.7 : 1 }}
            >
              {status === "cropping" ? "Crop ho raha hai..." : (() => {
                const invoiceCount = pageClassification.filter((c) => c.isInvoice).length;
                const labelCount = pageClassification.length - invoiceCount;
                return `✂️ Crop Karo — ${labelCount || pageCount} Label${labelCount === 1 ? "" : "s"}`;
              })()}
            </button>
          </div>
          {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 12 }}>{error}</p>}
        </>
      )}

      {status === "done" && resultUrl && (
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <div style={{ background: "#EAF6F2", border: "1px solid #0F6E56", borderRadius: 10, padding: "20px 16px", marginBottom: 16 }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: "#0F6E56", margin: "0 0 4px" }}>✅ Ho gaya — {resultCount} label{resultCount > 1 ? "s" : ""} crop ho gaye</p>
            <p style={{ fontSize: 12.5, color: "#6b6b68", margin: 0 }}>Ye crop box agli baar {platformDef.label} ke liye yaad rahega.</p>
          </div>
          <a
            href={resultUrl}
            download={resultName}
            style={{ display: "block", background: "#0F6E56", color: "#fff", padding: "13px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, textDecoration: "none", marginBottom: 10 }}
          >
            ⬇️ Cropped PDF Download Karo
          </a>
          <button onClick={resetAll} style={{ background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "10px 18px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>
            Ek aur file crop karo
          </button>
        </div>
      )}

      <p style={{ fontSize: 11, color: "#c2c1bc", marginTop: 28, textAlign: "center" }}>GetDigitals Seller Doctor</p>
    </div>
  );
}

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
