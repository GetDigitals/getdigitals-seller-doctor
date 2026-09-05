// ProductPhotoshootTool.jsx
//
// Free feature: turn a plain product photo (flatlay/mannequin/hanger shot)
// into a professional-looking model/studio photo, using Google's Gemini
// image model. Generic text-to-image models don't preserve the exact
// product (color, print, pattern) well enough for catalog use — Gemini's
// image-editing mode, given the product photo as a reference, does much
// better at keeping the actual product faithful while changing the
// context around it.
//
// This is Bring-Your-Own-Key: the seller connects their OWN free Gemini
// API key (from Google AI Studio) in Settings, and every generation is
// billed to THEIR Google account, not GetDigitals'. That's also why this
// tool isn't paywalled — there's no cost on our side to gate.
//
// The Gemini API's classic generateContent endpoint supports direct
// browser calls (CORS-enabled) via a simple x-goog-api-key header, so no
// backend proxy is needed — the key never leaves the seller's own browser
// except to talk straight to Google.

import React, { useState, useRef } from "react";
import { supabase } from "./supabaseClient";

const MODEL = "gemini-3.1-flash-image-preview";

const STYLE_PRESETS = [
  {
    id: "model",
    label: "Model pehne hue",
    icon: "🧍",
    prompt:
      "Show this exact garment being worn by a photogenic Indian fashion model, front-facing, standing pose, professional e-commerce studio photography, soft even studio lighting, plain light grey seamless background. Preserve the garment's exact color, print, pattern, texture and fit precisely as in the reference photo — do not change the design in any way.",
  },
  {
    id: "studio",
    label: "Studio background",
    icon: "💡",
    prompt:
      "Recreate this exact product photo with professional e-commerce studio lighting and a clean plain white/light-grey seamless background, sharp focus, commercial product photography style. Preserve the product's exact color, print, pattern, texture and shape precisely as in the reference photo.",
  },
  {
    id: "lifestyle",
    label: "Lifestyle scene",
    icon: "🏡",
    prompt:
      "Show this exact product in a tasteful, realistic lifestyle setting appropriate for the product category, natural light, professional commercial photography style. Preserve the product's exact color, print, pattern, texture and shape precisely as in the reference photo.",
  },
];

async function getSavedKey() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from("user_api_keys").select("gemini_api_key").eq("user_id", user.id).maybeSingle();
  if (error) console.error("Key fetch failed:", error);
  return data?.gemini_api_key || null;
}

async function logActivity(actionType, details = {}) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("activity_log").insert({ user_id: user.id, action_type: actionType, details });
  } catch (err) {
    console.error("Activity log failed:", err);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ProductPhotoshootTool({ onBack }) {
  const [apiKey, setApiKey] = useState(null); // null = checking, "" = not set
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [style, setStyle] = useState(STYLE_PRESETS[0].id);
  const [customNote, setCustomNote] = useState("");
  const [status, setStatus] = useState("idle"); // idle | generating | done | error
  const [error, setError] = useState("");
  const [resultUrl, setResultUrl] = useState(null);
  const fileInputRef = useRef(null);

  React.useEffect(() => {
    getSavedKey().then((k) => setApiKey(k || ""));
  }, []);

  const handleUpload = async (f) => {
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setResultUrl(null);
    setError("");
  };

  const handleGenerate = async () => {
    if (!file || !apiKey) return;
    setStatus("generating");
    setError("");
    try {
      const base64 = await fileToBase64(file);
      const preset = STYLE_PRESETS.find((p) => p.id === style);
      const promptText = preset.prompt + (customNote.trim() ? ` Additional instruction: ${customNote.trim()}` : "");

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: promptText },
                { inline_data: { mime_type: file.type || "image/jpeg", data: base64 } },
              ],
            }],
          }),
        }
      );

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || `Request failed (${res.status})`;
        // Google's error reason (e.g. ACCESS_TOKEN_TYPE_UNSUPPORTED) can live in
        // error.status or error.details[].reason, not just the message text —
        // so match against the whole error body, not just the message string.
        throw new Error(msg, { cause: JSON.stringify(errBody) });
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inline_data || p.inlineData);
      const imgData = imgPart?.inline_data?.data || imgPart?.inlineData?.data;
      if (!imgData) throw new Error("Model ne image nahi banayi — dobara try karo ya prompt change karo.");

      const mime = imgPart?.inline_data?.mime_type || imgPart?.inlineData?.mimeType || "image/png";
      setResultUrl(`data:${mime};base64,${imgData}`);
      setStatus("done");
      logActivity("photoshoot_generate", { style });
    } catch (err) {
      console.error(err);
      const msg = String(err.message || err);
      const fullDetails = (msg + " " + (err.cause || "")).toLowerCase();
      if (fullDetails.includes("access_token_type_unsupported") || fullDetails.includes("api_key_service_blocked")) {
        setError("Ye Google ki taraf se ek known issue hai — kuch accounts ki nayi 'Auth key' (AQ. wali) abhi Gemini API ke saath kaam nahi kar rahi (Google ka apna rollout bug hai, humari taraf se nahi). Kuch din baad dobara try karo, ya Google AI Studio forum pe apni account ke baare mein report karo.");
      } else if (fullDetails.includes("api key") || fullDetails.includes("permission") || fullDetails.includes("unauthenticated")) {
        setError("API key invalid ya expired lag rahi hai — Settings mein jaake dobara check karo.");
      } else if (fullDetails.includes("quota") || fullDetails.includes("resource_exhausted")) {
        setError("Aaj ki free limit khatam ho gayi lagti hai (Google ki apni free-tier limit) — kal try karo ya apne Google account mein billing enable karo.");
      } else {
        setError(msg);
      }
      setStatus("error");
    }
  };

  const resetAll = () => {
    setFile(null);
    setPreviewUrl(null);
    setResultUrl(null);
    setStatus("idle");
    setError("");
  };

  if (apiKey === null) {
    return <div style={{ padding: 40, textAlign: "center", color: "#9a9a95", fontFamily: "system-ui, sans-serif" }}>Load ho raha hai...</div>;
  }

  if (!apiKey) {
    return (
      <div style={{ padding: "60px 24px", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 30, marginBottom: 10 }}>🔑</div>
        <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Pehle apni free Gemini API key connect karo</h3>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "#6b6b68", maxWidth: 380, marginLeft: "auto", marginRight: "auto" }}>
          Ye tool tumhari apni Google account ki free API key use karta hai — GetDigitals ka koi charge nahi lagta. Settings mein 2 minute mein connect ho jayegi.
        </p>
        <button onClick={onBack} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "10px 22px", borderRadius: 8, fontSize: 13.5, fontWeight: 500, cursor: "pointer" }}>
          Settings mein jaake connect karo
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: "24px 16px" }}>
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "#0F6E56", textTransform: "uppercase", margin: "0 0 4px" }}>GetDigitals Seller Doctor</p>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Product Photoshoot</h1>
        <p style={{ fontSize: 12.5, color: "#6b6b68", margin: "6px 0 0" }}>Apni product photo upload karo — professional model/studio photo mil jayega. Bilkul free (tumhari apni API key se).</p>
      </div>

      {!previewUrl && (
        <div style={{ textAlign: "center", padding: "40px 20px", border: "1px dashed #d8d6cf", borderRadius: 12 }}>
          <input type="file" accept="image/*" ref={fileInputRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleUpload(e.target.files[0])} />
          <button onClick={() => fileInputRef.current.click()} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer" }}>
            📷 Product Photo Upload Karo
          </button>
          <p style={{ fontSize: 11.5, color: "#9a9a95", marginTop: 14 }}>Flatlay, hanger, ya mannequin — koi bhi clear photo chalegi.</p>
        </div>
      )}

      {previewUrl && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: resultUrl ? "1fr 1fr" : "1fr", gap: 14, marginBottom: 18 }}>
            <div>
              <p style={{ fontSize: 11.5, color: "#9a9a95", margin: "0 0 6px" }}>Original</p>
              <img src={previewUrl} alt="Original product" style={{ width: "100%", borderRadius: 10, border: "1px solid #e5e4df" }} />
            </div>
            {resultUrl && (
              <div>
                <p style={{ fontSize: 11.5, color: "#9a9a95", margin: "0 0 6px" }}>Generated</p>
                <img src={resultUrl} alt="Generated photoshoot" style={{ width: "100%", borderRadius: 10, border: "1px solid #0F6E56" }} />
              </div>
            )}
          </div>

          {status !== "done" && (
            <>
              <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>Style choose karo:</p>
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {STYLE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setStyle(p.id)}
                    style={{
                      padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                      border: style === p.id ? "1.5px solid #0F6E56" : "1px solid #e5e4df",
                      background: style === p.id ? "#EAF6F2" : "#fff",
                      color: style === p.id ? "#0F6E56" : "#6b6b68",
                    }}
                  >
                    {p.icon} {p.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                placeholder="Extra instructions (optional) — jaise 'sleeveless dikhao' ya 'red background'"
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #e5e4df", fontSize: 13, marginBottom: 16, boxSizing: "border-box" }}
              />
            </>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={resetAll} style={{ flex: "0 0 auto", background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "12px 18px", borderRadius: 8, fontSize: 14, cursor: "pointer" }}>
              Naya photo
            </button>
            {status === "done" ? (
              <a href={resultUrl} download="product-photoshoot.png" style={{ flex: 1, textAlign: "center", background: "#0F6E56", color: "#fff", padding: "12px 18px", borderRadius: 8, fontSize: 15, fontWeight: 500, textDecoration: "none" }}>
                ⬇️ Download Karo
              </a>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={status === "generating"}
                style={{ flex: 1, background: "#0F6E56", color: "#fff", border: "none", padding: "12px 18px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", opacity: status === "generating" ? 0.7 : 1 }}
              >
                {status === "generating" ? "Generate ho raha hai... (10-20 sec)" : "✨ Photoshoot Generate Karo"}
              </button>
            )}
          </div>
          {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 12 }}>{error}</p>}
        </>
      )}

      <p style={{ fontSize: 11, color: "#c2c1bc", marginTop: 28, textAlign: "center" }}>GetDigitals Seller Doctor — powered by tumhari apni Gemini API key</p>
    </div>
  );
}
