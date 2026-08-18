import React, { useState, useMemo, useRef, useEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient";

const DEMO_ORDERS = [
  { sku: "SKU-31", name: "Cotton Kurti - Blue", platform: "Meesho", sales: 42000, units: 210, returns: 95, commission: 0, shipping: 8400, tds: 420, hiddenDeduction: 3100, adSpend: 0 },
  { sku: "SKU-15", name: "Steel Water Bottle 1L", platform: "Amazon", sales: 68000, units: 340, returns: 24, commission: 9520, shipping: 6800, tds: 680, hiddenDeduction: 2200, adSpend: 4500 },
  { sku: "SKU-07", name: "Kids Backpack", platform: "Flipkart", sales: 51000, units: 102, returns: 31, commission: 7650, shipping: 5100, tds: 510, hiddenDeduction: 1800, adSpend: 2100 },
  { sku: "SKU-22", name: "Wireless Earbuds", platform: "Amazon", sales: 74000, units: 148, returns: 18, commission: 11100, shipping: 4200, tds: 740, hiddenDeduction: 1800, adSpend: 6200 },
];

const FIELD_ALIASES = {
  sku: ["sku", "product id", "productid", "item sku", "seller sku"],
  name: ["name", "product name", "title", "item name", "description"],
  platform: ["platform", "marketplace", "channel", "source"],
  sales: ["sales", "sale amount", "order value", "gross sale", "invoice amount", "total sale value", "amount"],
  units: ["units", "quantity", "qty", "order quantity"],
  returns: ["returns", "return units", "returned qty", "rto units"],
  commission: ["commission", "marketplace fee", "referral fee", "commission amount"],
  shipping: ["shipping", "shipping fee", "shipping charge", "logistics fee"],
  tds: ["tds", "tax deducted", "tds amount", "tcs"],
  hiddenDeduction: ["hidden deduction", "deduction", "adjustment", "other deduction", "claims deducted"],
  adSpend: ["ad spend", "ads", "advertising cost", "campaign spend"],
};

function matchColumn(headers, aliases) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.findIndex((h) => h === alias || h.includes(alias));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function mapRowsFromGenericCsv(data) {
  if (!data.length) return [];
  const headers = Object.keys(data[0]);
  const colMap = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    colMap[field] = matchColumn(headers, aliases);
  });
  return data.map((row, i) => {
    const num = (key) => {
      const col = colMap[key];
      if (!col) return 0;
      const val = parseFloat(String(row[col]).replace(/[^0-9.-]/g, ""));
      return isNaN(val) ? 0 : val;
    };
    return {
      sku: colMap.sku ? row[colMap.sku] : `ROW-${i + 1}`,
      name: colMap.name ? row[colMap.name] : "Unnamed product",
      platform: colMap.platform ? row[colMap.platform] : "Unknown",
      sales: num("sales"), units: num("units") || 1, returns: num("returns"),
      commission: num("commission"), shipping: num("shipping"), tds: num("tds"),
      hiddenDeduction: num("hiddenDeduction"), adSpend: num("adSpend"),
    };
  });
}

// Real Meesho "Order Payments" settlement format. Column names repeat
// (e.g. "Fixed Fee (Incl. GST)" appears twice — forward + return legs) so we
// map by fixed position, verified against an actual Meesho export.
const MEESHO_COLS = {
  sku: 4, status: 7, quantity: 10, finalSettlement: 13,
  saleAmount: 15, returnAmount: 16,
  meeshoCommission: 22, returnShippingCharge: 27, shippingCharge: 29,
  tcs: 34, tds: 36, compensation: 37, claims: 38, recovery: 39,
};

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

async function parseMeeshoSettlement(rawFile) {
  const file = await unwrapIfZipped(rawFile);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes("order payments"));
  if (!sheetName) throw new Error("Order Payments sheet nahi mili — file format check karo.");
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  // Row 0 = merged category headers, row 1 = actual column names, row 2+ = data.
  const dataRows = aoa.slice(2).filter((r) => r && r[0]);

  const bySku = {};
  let totals = { sales: 0, returns: 0, shipping: 0, returnShipping: 0, tcs: 0, tds: 0, compensation: 0, claims: 0, recovery: 0, finalSettlement: 0 };
  let statusCounts = {};

  dataRows.forEach((r) => {
    const sku = r[MEESHO_COLS.sku] || "Unknown SKU";
    const status = r[MEESHO_COLS.status] || "Unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    const sale = toNum(r[MEESHO_COLS.saleAmount]);
    const ret = toNum(r[MEESHO_COLS.returnAmount]);
    const ship = toNum(r[MEESHO_COLS.shippingCharge]);
    const retShip = toNum(r[MEESHO_COLS.returnShippingCharge]);
    const tcs = toNum(r[MEESHO_COLS.tcs]);
    const tds = toNum(r[MEESHO_COLS.tds]);
    const comp = toNum(r[MEESHO_COLS.compensation]);
    const claims = toNum(r[MEESHO_COLS.claims]);
    const recovery = toNum(r[MEESHO_COLS.recovery]);
    const settlement = toNum(r[MEESHO_COLS.finalSettlement]);
    const qty = toNum(r[MEESHO_COLS.quantity]) || 1;

    totals.sales += sale;
    totals.returns += ret;
    totals.shipping += ship;
    totals.returnShipping += retShip;
    totals.tcs += tcs;
    totals.tds += tds;
    totals.compensation += comp;
    totals.claims += claims;
    totals.recovery += recovery;
    totals.finalSettlement += settlement;

    if (!bySku[sku]) {
      bySku[sku] = { sku, units: 0, delivered: 0, rto: 0, returned: 0, sales: 0, returns: 0, shipping: 0, returnShipping: 0 };
    }
    const s = bySku[sku];
    s.units += qty;
    s.sales += sale;
    s.returns += ret;
    s.shipping += ship;
    s.returnShipping += retShip;
    if (status === "Delivered") s.delivered += qty;
    if (status === "RTO") s.rto += qty;
    if (status === "Return") s.returned += qty;
  });

  const skuRows = Object.values(bySku)
    .map((s) => {
      const netSales = s.sales + s.returns; // returns is stored negative
      const totalCost = s.shipping + s.returnShipping; // both negative
      const profit = netSales + totalCost;
      const rtoRate = s.units ? s.rto / s.units : 0;
      return {
        sku: s.sku,
        name: s.sku,
        platform: "Meesho",
        sales: Math.round(netSales),
        units: s.units,
        returns: s.rto + s.returned,
        commission: 0,
        shipping: Math.round(-totalCost),
        tds: 0,
        hiddenDeduction: 0,
        adSpend: 0,
        rtoRate,
      };
    })
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 15); // keep the top 15 SKUs by revenue for a readable table

  return { skuRows, totals, statusCounts, totalOrders: dataRows.length };
}

// Real Flipkart "Orders" export format (operational data — no money fields,
// verified against an actual Flipkart export). Different shape from the
// profit table, so it renders as its own "Order Health" panel.
const FLIPKART_ORDER_COLS = {
  status: 6, sku: 7, productTitle: 9, quantity: 10,
  cancellationReason: 18, returnReason: 22, deliverySlaBreached: 34,
};

function parseFlipkartOrders(aoa) {
  const headers = aoa[0].map((h) => String(h || "").toLowerCase().trim());
  const isFlipkartOrders = headers.includes("order_item_status") && headers.includes("sku");
  if (!isFlipkartOrders) return null;

  const dataRows = aoa.slice(1).filter((r) => r && r[0]);
  const statusCounts = {};
  const bySku = {};
  let slaBreaches = 0;

  dataRows.forEach((r) => {
    const status = r[FLIPKART_ORDER_COLS.status] || "Unknown";
    const sku = r[FLIPKART_ORDER_COLS.sku] || "Unknown SKU";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (r[FLIPKART_ORDER_COLS.deliverySlaBreached] === "Y") slaBreaches += 1;

    if (!bySku[sku]) bySku[sku] = { sku, total: 0, cancelled: 0, returned: 0 };
    bySku[sku].total += 1;
    if (status === "CANCELLED") bySku[sku].cancelled += 1;
    if (status === "RETURNED") bySku[sku].returned += 1;
  });

  const riskySkus = Object.values(bySku)
    .filter((s) => s.cancelled + s.returned >= 2)
    .sort((a, b) => (b.cancelled + b.returned) - (a.cancelled + a.returned));

  return { totalOrders: dataRows.length, statusCounts, slaBreaches, riskySkus };
}

async function readFlipkartOrdersFile(rawFile) {
  const file = await unwrapIfZipped(rawFile);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes("order")) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const parsed = parseFlipkartOrders(aoa);
  if (!parsed) throw new Error("Ye Flipkart Orders report jaisa nahi lag raha — 'order_item_status' column nahi mila.");
  return parsed;
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new Error("Zip library load nahi ho payi — internet check karo."));
      document.head.appendChild(script);
    });
  }
  return jszipPromise;
}

// Accepts either a raw .xlsx File, or a .zip File containing one or more
// .xlsx files (Meesho ships every report zipped). Returns the first .xlsx
// found inside a zip as a File-like object with an arrayBuffer() method.
async function unwrapIfZipped(file) {
  const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
  if (!isZip) return file;
  const JSZip = await loadJSZip();
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const xlsxEntry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(".xlsx"));
  if (!xlsxEntry) throw new Error("Is zip ke andar koi .xlsx file nahi mili.");
  const xlsxBuf = await xlsxEntry.async("arraybuffer");
  return { name: xlsxEntry.name, arrayBuffer: async () => xlsxBuf };
}

function currency(n) {
  return "₹" + Math.round(n || 0).toLocaleString("en-IN");
}

function computeMetrics(row) {
  const returnRate = row.units ? row.returns / row.units : 0;
  const totalCost = row.commission + row.shipping + row.tds + row.hiddenDeduction + row.adSpend;
  const profit = row.sales - totalCost;
  const margin = row.sales ? profit / row.sales : 0;
  return { returnRate, totalCost, profit, margin };
}

function buildRuleBasedRecommendations(rows) {
  const recs = [];
  rows.forEach((row) => {
    const m = computeMetrics(row);
    if (m.returnRate > 0.3) {
      recs.push({ sku: row.sku, level: "critical", title: `${row.sku} ka return/RTO rate check karo`, reason: `Return rate ${(m.returnRate * 100).toFixed(0)}% hai — margin isse kha raha hai.` });
    }
  });
  return recs;
}

async function getAiRecommendations(rows, meta) {
  const skuSummaries = rows.map((row) => {
    const m = computeMetrics(row);
    return {
      sku: row.sku, sales: Math.round(row.sales), units: row.units, returns: row.returns,
      returnRatePercent: Math.round(m.returnRate * 1000) / 10,
      profit: Math.round(m.profit), marginPercent: Math.round(m.margin * 1000) / 10,
    };
  });

  const prompt = `Tum ek e-commerce business advisor ho jo Indian sellers (Amazon/Flipkart/Meesho) ko roz ka action plan dete ho.
${meta ? `Overall account context: ${JSON.stringify(meta)}` : ""}
Neeche har SKU ka data hai. Har SKU ke liye decide karo ki koi action chahiye ya nahi.

Data:
${JSON.stringify(skuSummaries, null, 2)}

Respond ONLY with a JSON array, no markdown, no preamble, no code fences. Each item must have exactly these fields:
- "sku": string
- "level": "critical" or "warning"
- "title": short action in Hindi/English mix (max 10 words)
- "reason": one sentence explanation using the actual numbers, in Hindi/English mix

Only include SKUs/points that genuinely need attention. If everything is healthy, return [].`;

  const response = await fetch("/.netlify/functions/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) throw new Error("API request failed");
  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in response");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error("Response was not an array");
  return parsed;
}

// PHASE 1 — Daily Briefing: har successful analysis ke baad ek snapshot
// save karta hai, isi se "pichle hafte vs is hafte" comparison possible hota hai.
async function saveSnapshot(rows, recommendations) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return; // logged out ho to silently skip

    const totalSales = rows.reduce((sum, r) => sum + (r.sales || 0), 0);
    let totalProfit = 0, totalLoss = 0;
    rows.forEach((row) => {
      const m = computeMetrics(row);
      if (m.profit >= 0) totalProfit += m.profit;
      else totalLoss += Math.abs(m.profit);
    });

    const criticalCount = recommendations.filter((r) => r.level === "critical").length;
    const warningCount = recommendations.filter((r) => r.level === "warning").length;
    const topIssues = recommendations.slice(0, 3).map((r) => ({ title: r.title, level: r.level }));

    await supabase.from("snapshots").insert({
      user_id: user.id,
      total_sales: Math.round(totalSales),
      total_profit: Math.round(totalProfit),
      total_loss: Math.round(totalLoss),
      critical_count: criticalCount,
      warning_count: warningCount,
      sku_count: rows.length,
      top_issues: topIssues,
    });
  } catch (err) {
    // Snapshot fail hone se poora analysis fail nahi hona chahiye.
    console.error("Snapshot save failed:", err);
  }
}

// PHASE 1 — Daily Briefing: pichle 2 snapshots fetch karke AI se ek
// chhota, plain-language "aaj ki briefing" banata hai.
async function getBriefing() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not logged in");

  const { data: snapshots, error } = await supabase
    .from("snapshots")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(2);

  if (error) throw error;
  if (!snapshots || snapshots.length === 0) {
    return { bullets: ["Abhi tak koi analysis save nahi hua. Pehle apni file upload karo."], hasTrend: false };
  }

  const latest = snapshots[0];
  const previous = snapshots[1] || null;

  const prompt = `Tum ek e-commerce business advisor ho. Neeche seller ke latest business snapshot ka data hai${previous ? ", aur pichle snapshot se comparison ke liye purana data bhi hai" : " (ye unka pehla snapshot hai, koi comparison nahi)"}.

Latest: ${JSON.stringify({ totalSales: latest.total_sales, totalProfit: latest.total_profit, totalLoss: latest.total_loss, criticalIssues: latest.critical_count, warningIssues: latest.warning_count, topIssues: latest.top_issues })}
${previous ? `Previous (${new Date(previous.created_at).toLocaleDateString("en-IN")}): ${JSON.stringify({ totalSales: previous.total_sales, totalProfit: previous.total_profit, criticalIssues: previous.critical_count })}` : ""}

3-4 short bullet points mein ek "daily briefing" likho, Hindi/English mix mein, jaise ek dost seedhi baat kar raha ho. Sabse important/urgent point sabse pehle. Agar previous data hai to trend (badha/gira) zaroor mention karo. Numbers ka use karo, generic baatein mat likho.

Respond ONLY with a JSON object, no markdown, no code fences: {"bullets": ["point 1", "point 2", ...]}`;

  const response = await fetch("/.netlify/functions/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) throw new Error("Briefing request failed");
  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  const clean = textBlock.text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return { bullets: parsed.bullets, hasTrend: !!previous };
}

function ProfitDashboardApp({ onOpenListingTool, hasAccess, onRequestPayment }) {
  const [rows, setRows] = useState(null);
  const [meesho, setMeesho] = useState(null); // { totals, statusCounts, totalOrders }
  const [flipkart, setFlipkart] = useState(null); // { totalOrders, statusCounts, slaBreaches, riskySkus }
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState("");
  const [recommendations, setRecommendations] = useState([]);
  const [aiStatus, setAiStatus] = useState("idle");
  const [briefing, setBriefing] = useState(null);
  const [briefingStatus, setBriefingStatus] = useState("idle"); // idle | loading | done | failed
  const csvRef = useRef(null);
  const xlsxRef = useRef(null);
  const flipkartRef = useRef(null);

  const loadRows = async (newRows, meeshoMeta = null) => {
    setRows(newRows);
    setMeesho(meeshoMeta);
    setAiStatus("loading");
    try {
      const meta = meeshoMeta
        ? { totalOrders: meeshoMeta.totalOrders, statusCounts: meeshoMeta.statusCounts, netSettlement: Math.round(meeshoMeta.totals.finalSettlement) }
        : null;
      const recs = await getAiRecommendations(newRows, meta);
      setRecommendations(recs);
      setAiStatus("done");
      saveSnapshot(newRows, recs); // fire-and-forget — analysis UI iske liye rukna nahi chahiye
    } catch (err) {
      setRecommendations(buildRuleBasedRecommendations(newRows));
      setAiStatus("failed");
    }
  };

  const handleGetBriefing = async () => {
    setBriefingStatus("loading");
    try {
      const result = await getBriefing();
      setBriefing(result);
      setBriefingStatus("done");
    } catch (err) {
      setBriefingStatus("failed");
    }
  };

  const handleCsv = (file) => {
    setError("");
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (result) => {
        if (!result.data.length) { setError("File khali lag raha hai ya format samajh nahi aaya."); return; }
        loadRows(mapRowsFromGenericCsv(result.data));
      },
      error: () => setError("File parse nahi ho payi. CSV format check karo."),
    });
  };

  const handleMeeshoXlsx = async (file) => {
    setError("");
    try {
      const { skuRows, totals, statusCounts, totalOrders } = await parseMeeshoSettlement(file);
      loadRows(skuRows, { totals, statusCounts, totalOrders });
    } catch (err) {
      setError(err.message || "Meesho file parse nahi ho payi.");
    }
  };

  const handleFlipkartOrders = async (file) => {
    setError("");
    try {
      const parsed = await readFlipkartOrdersFile(file);
      setFlipkart(parsed);
    } catch (err) {
      setError(err.message || "Flipkart file parse nahi ho payi.");
    }
  };

  const totals = useMemo(() => {
    if (!rows) return { sales: 0, hidden: 0, profit: 0 };
    let sales = 0, hidden = 0, profit = 0;
    rows.forEach((r) => {
      const m = computeMetrics(r);
      sales += r.sales; hidden += r.hiddenDeduction; profit += m.profit;
    });
    return { sales, hidden, profit };
  }, [rows]);

  if (!rows && !flipkart) {
    // Locked features stay fully visible (never hidden) — tapping one just
    // opens the payment screen instead of performing the upload/action.
    // This lets a free/unpaid visitor see everything Seller Doctor offers
    // (matching GetDigitals Topper's "see it, then unlock it" pattern)
    // instead of hitting a blank paywall before they even know what's here.
    const lockIcon = !hasAccess ? ' 🔒' : '';

    return (
      <div style={{ maxWidth: 480, margin: "48px auto", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ width: 56, height: 56, borderRadius: 14, background: "#0F6E56", margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center", color: "#E1F5EE", fontSize: 24, fontWeight: 600 }}>AI</div>
        <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#0F6E56", textTransform: "uppercase", margin: "0 0 6px" }}>GetDigitals</p>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "#1a1a1a", margin: "0 0 8px" }}>GetDigitals Seller Doctor — Demo</h1>
        <p style={{ fontSize: 14, color: "#6b6b68", margin: "0 0 24px", lineHeight: 1.6 }}>Real Meesho settlement file (.xlsx) upload karo, ya generic CSV try karo.</p>

        {!hasAccess && (
          <div style={{ background: "#FFF4E5", border: "1px solid #F0C36D", borderRadius: 8, padding: "10px 14px", marginBottom: 20, fontSize: 12.5, color: "#8A5A00", textAlign: "left" }}>
            🔒 Neeche diye features ek plan activate karne ke baad unlock hote hain. Free calculator sabse neeche hai, woh abhi bhi try kar sakte ho.
          </div>
        )}

        <input type="file" accept=".xlsx,.zip" ref={xlsxRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleMeeshoXlsx(e.target.files[0])} />
        <button onClick={() => (hasAccess ? xlsxRef.current.click() : onRequestPayment())} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", marginBottom: 12, width: "100%", opacity: hasAccess ? 1 : 0.75 }}>
          Meesho settlement (.xlsx) upload karo{lockIcon}
        </button>

        <input type="file" accept=".xlsx,.zip" ref={flipkartRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleFlipkartOrders(e.target.files[0])} />
        <button onClick={() => (hasAccess ? flipkartRef.current.click() : onRequestPayment())} style={{ background: "#fff", color: "#0F6E56", border: "1px solid #0F6E56", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", marginBottom: 12, width: "100%", opacity: hasAccess ? 1 : 0.75 }}>
          Flipkart Orders report (.xlsx) upload karo{lockIcon}
        </button>

        <input type="file" accept=".csv" ref={csvRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleCsv(e.target.files[0])} />
        <button onClick={() => (hasAccess ? csvRef.current.click() : onRequestPayment())} style={{ background: "transparent", color: "#0F6E56", border: "1px solid #0F6E56", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", marginBottom: 12, width: "100%", opacity: hasAccess ? 1 : 0.75 }}>
          Generic CSV upload karo{lockIcon}
        </button>

        <button onClick={() => (hasAccess ? loadRows(DEMO_ORDERS) : onRequestPayment())} style={{ background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%", marginBottom: 20, opacity: hasAccess ? 1 : 0.75 }}>
          Demo data se try karo{lockIcon}
        </button>

        <button onClick={() => (hasAccess ? onOpenListingTool() : onRequestPayment())} style={{ background: "#f4f3ef", color: "#1a1a1a", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: "pointer", width: "100%", marginBottom: 10, opacity: hasAccess ? 1 : 0.75 }}>
          📋 Listing Draft Generator (beta) →{lockIcon}
        </button>

        <a href="/toolkit/" target="_blank" rel="noreferrer" style={{ display: "block", textAlign: "center", background: "#EAF6F2", color: "#0F6E56", border: "1px solid #0F6E56", padding: "12px 24px", borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: "none", width: "100%", boxSizing: "border-box" }}>
          🧮 Free Business Profit Toolkit (calculators) → Hamesha free
        </a>

        {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 16 }}>{error}</p>}
        <p style={{ fontSize: 12, color: "#9a9a95", marginTop: 20, lineHeight: 1.6 }}>
          Meesho upload: zip ya .xlsx dono seedha upload kar sakte ho — tool khud zip ke andar se "Order Payments" file dhoondh lega.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", color: "#1a1a1a", padding: "24px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "#0F6E56", textTransform: "uppercase", margin: "0 0 4px" }}>GetDigitals Seller Doctor</p>
          <p style={{ fontSize: 13, color: "#6b6b68", margin: "0 0 4px" }}>{meesho ? "Meesho settlement — real data" : "Good morning — kal ka summary"}</p>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Business health report</h1>
        </div>
        <button onClick={() => { setRows(null); setFlipkart(null); }} style={{ background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "6px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>Naya file</button>
      </div>

      {rows && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={{ background: "#f4f3ef", borderRadius: 12, padding: "14px 16px" }}>
          <p style={{ fontSize: 12, color: "#6b6b68", margin: "0 0 6px" }}>{meesho ? "Total sale amount" : "Total sale"}</p>
          <p style={{ fontSize: 21, fontWeight: 600, margin: 0 }}>{currency(meesho ? meesho.totals.sales : totals.sales)}</p>
        </div>
        <div style={{ background: "#EAF3DE", borderRadius: 12, padding: "14px 16px" }}>
          <p style={{ fontSize: 12, color: "#3B6D11", margin: "0 0 6px" }}>{meesho ? "Final settlement" : "Actual profit"}</p>
          <p style={{ fontSize: 21, fontWeight: 600, margin: 0, color: "#173404" }}>{currency(meesho ? meesho.totals.finalSettlement : totals.profit)}</p>
        </div>
        <div style={{ background: "#FCEBEB", borderRadius: 12, padding: "14px 16px" }}>
          <p style={{ fontSize: 12, color: "#A32D2D", margin: "0 0 6px" }}>{meesho ? "Return+ship cost" : "Hidden deductions"}</p>
          <p style={{ fontSize: 21, fontWeight: 600, margin: 0, color: "#501313" }}>
            {currency(meesho ? Math.abs(meesho.totals.shipping) + Math.abs(meesho.totals.returnShipping) : totals.hidden)}
          </p>
        </div>
      </div>
      )}

      {meesho && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24, fontSize: 12 }}>
          {Object.entries(meesho.statusCounts).map(([status, count]) => (
            <span key={status} style={{ background: "#f4f3ef", padding: "4px 10px", borderRadius: 20, color: "#6b6b68" }}>
              {status || "Unknown"}: <strong style={{ color: "#1a1a1a" }}>{count}</strong>
            </span>
          ))}
        </div>
      )}

      {flipkart && (
        <div style={{ marginBottom: 28, border: "1px solid #e5e4df", borderRadius: 12, padding: "16px 18px" }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 10px" }}>Flipkart — Order Health</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 12 }}>
            {Object.entries(flipkart.statusCounts).map(([status, count]) => (
              <span key={status} style={{ background: "#f4f3ef", padding: "4px 10px", borderRadius: 20, color: "#6b6b68" }}>
                {status}: <strong style={{ color: "#1a1a1a" }}>{count}</strong>
              </span>
            ))}
          </div>
          <p style={{ fontSize: 13, color: "#6b6b68", margin: "0 0 10px" }}>
            Total orders: {flipkart.totalOrders} • Delivery SLA breaches: {flipkart.slaBreaches}
          </p>
          {flipkart.riskySkus.length > 0 ? (
            <>
              <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 6px", color: "#A32D2D" }}>Repeat cancel/return SKUs:</p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#6b6b68" }}>
                {flipkart.riskySkus.slice(0, 5).map((s) => (
                  <li key={s.sku}>{s.sku} — {s.cancelled} cancelled, {s.returned} returned (of {s.total} total)</li>
                ))}
              </ul>
            </>
          ) : (
            <p style={{ fontSize: 13, color: "#6b6b68", margin: 0 }}>Koi SKU repeat cancel/return pattern nahi dikh raha.</p>
          )}
        </div>
      )}

      {rows && (
      <div style={{ border: "1px solid #e5e4df", borderRadius: 10, padding: "16px 18px", marginBottom: 20, background: "#FAFAF8" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: briefing ? 12 : 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>🩺 Aaj ki Briefing</h2>
          <button
            onClick={handleGetBriefing}
            disabled={briefingStatus === "loading"}
            style={{ fontSize: 12, background: "#3C3489", color: "#fff", border: "none", borderRadius: 20, padding: "6px 14px", cursor: "pointer" }}
          >
            {briefingStatus === "loading" ? "Soch raha hai..." : "Refresh Briefing"}
          </button>
        </div>

        {briefingStatus === "failed" && (
          <p style={{ fontSize: 13, color: "#BA7517", margin: 0 }}>Briefing load nahi ho payi. Dobara try karo.</p>
        )}

        {briefing && briefing.bullets && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {briefing.bullets.map((b, i) => (
              <li key={i} style={{ fontSize: 13.5, color: "#3a3a37", marginBottom: 6, lineHeight: 1.6 }}>{b}</li>
            ))}
          </ul>
        )}

        {!briefing && briefingStatus === "idle" && (
          <p style={{ fontSize: 13, color: "#9a9a95", margin: 0 }}>Refresh dabao apni latest briefing dekhne ke liye.</p>
        )}
      </div>
      )}

      {rows && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Aaj ke actions</h2>
        {aiStatus === "loading" && <span style={{ fontSize: 12, color: "#9a9a95" }}>AI soch raha hai...</span>}
        {aiStatus === "done" && <span style={{ fontSize: 11, background: "#EEEDFE", color: "#3C3489", padding: "2px 8px", borderRadius: 20 }}>Claude AI generated</span>}
        {aiStatus === "failed" && <span style={{ fontSize: 11, color: "#BA7517" }}>AI unavailable — rule-based fallback</span>}
      </div>
      )}

      {rows && aiStatus !== "loading" && recommendations.length === 0 && (
        <p style={{ fontSize: 13, color: "#6b6b68", marginBottom: 20 }}>Koi urgent action nahi mila — numbers healthy lag rahe hain.</p>
      )}

      {rows && (
      <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
        {recommendations.map((rec, i) => (
          <div key={i} onClick={() => setExpanded(expanded === i ? null : i)} style={{ border: "1px solid #e5e4df", borderLeft: `3px solid ${rec.level === "critical" ? "#E24B4A" : "#BA7517"}`, borderRadius: 8, padding: "12px 14px", cursor: "pointer", background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>{rec.title}</p>
              <span style={{ fontSize: 12, color: "#9a9a95" }}>{expanded === i ? "−" : "+"}</span>
            </div>
            {expanded === i && <p style={{ fontSize: 13, color: "#6b6b68", margin: "8px 0 0", lineHeight: 1.6 }}>{rec.reason}</p>}
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>{meesho ? "Top SKUs (by revenue)" : "SKU-wise breakdown"}</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e5e4df", color: "#6b6b68", textAlign: "left" }}>
              <th style={{ padding: "8px 6px", fontWeight: 500 }}>SKU</th>
              <th style={{ padding: "8px 6px", fontWeight: 500, textAlign: "right" }}>Net sales</th>
              <th style={{ padding: "8px 6px", fontWeight: 500, textAlign: "right" }}>Return %</th>
              <th style={{ padding: "8px 6px", fontWeight: 500, textAlign: "right" }}>Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const m = computeMetrics(row);
              const returnPct = (m.returnRate * 100).toFixed(0);
              return (
                <tr key={i} style={{ borderBottom: "1px solid #f0efeb" }}>
                  <td style={{ padding: "8px 6px", fontWeight: 500 }}>{row.sku}</td>
                  <td style={{ padding: "8px 6px", textAlign: "right" }}>{currency(row.sales)}</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", color: m.returnRate > 0.3 ? "#A32D2D" : "#6b6b68" }}>{returnPct}%</td>
                  <td style={{ padding: "8px 6px", textAlign: "right" }}>{currency(m.profit)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 12, color: "#9a9a95", marginTop: 24, textAlign: "center" }}>
        {meesho ? "Real Meesho settlement se calculate hua — Order Payments sheet, exact column mapping." : "Column matching automatic hai (fuzzy match)."}
      </p>
      <p style={{ fontSize: 11, color: "#c2c1bc", marginTop: 8, textAlign: "center" }}>
        GetDigitals Seller Doctor
      </p>
      </>
      )}
    </div>
  );
}

// ===================== Listing Draft Generator =====================
// Reads a real, empty Meesho category bulk-listing template (the "...-Fill
// this" sheet + its "Validation Sheet" dropdown lists), then asks Claude to
// draft the compulsory fields for each size variant. Output is an editable
// table + a CSV the seller can copy into the official template.

async function parseMeeshoListingTemplate(rawFile) {
  const file = await unwrapIfZipped(rawFile);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const fillSheetName = wb.SheetNames.find((n) => n.toLowerCase().includes("fill this"));
  if (!fillSheetName) throw new Error("Ye Meesho listing template jaisa nahi lag raha — 'Fill this' sheet nahi mili.");

  const fillAoa = XLSX.utils.sheet_to_json(wb.Sheets[fillSheetName], { header: 1, raw: true });
  const categoryTitle = (fillAoa[0] && fillAoa[0][0]) || fillSheetName;
  const compulsoryRow = fillAoa[1] || [];
  const descRow = fillAoa[2] || [];

  // Column-aligned dropdown option lists, when present.
  const validationSheetName = wb.SheetNames.find((n) => n.toLowerCase().includes("validation"));
  let validationAoa = [];
  if (validationSheetName) {
    validationAoa = XLSX.utils.sheet_to_json(wb.Sheets[validationSheetName], { header: 1, raw: true });
  }

  const fields = [];
  descRow.forEach((cellVal, colIdx) => {
    if (colIdx < 3 || !cellVal) return; // skip label col + 2 system "do not fill" cols
    const parts = String(cellVal).split("\n\n").map((p) => p.trim()).filter(Boolean);
    const name = parts[0];
    const description = parts[1] || "";
    if (!name) return;
    const compulsory = String(compulsoryRow[colIdx] || "").toLowerCase().includes("compulsory");

    let options = [];
    if (validationAoa.length > 2) {
      for (let r = 2; r < Math.min(validationAoa.length, 62); r++) {
        const v = validationAoa[r] && validationAoa[r][colIdx];
        if (v) options.push(String(v));
      }
    }
    fields.push({ index: colIdx, name, description, compulsory, options: options.slice(0, 60) });
  });

  return { category: categoryTitle, fillSheetName, format: "meesho", fields };
}

// Flipkart's bulk-listing file (.xls) has a completely different layout to
// Meesho's: one row of field names, a type/hyperlink row, an example row,
// a description row, then data from row 5 onward — spread across many
// utility sheets (Summary Sheet, Index, per-column dropdown sheets, etc).
// We only need the header rows of the single category "fill" sheet.
const FLIPKART_UTILITY_SHEETS = /^(summary sheet|index|listing faq sheet|image guidelines|matchingattributes|variantattributes|parent variant products|template_version)$/i;

function isFlipkartSystemField(name) {
  return /flipkart serial|qc status|qc failed|product link|product data status|disapproval reason|^listing id$|processing error|parent variant fsn|parent request id|^request id$/i.test(name);
}

async function parseFlipkartListingTemplate(rawFile) {
  const file = await unwrapIfZipped(rawFile);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const mainSheetName = wb.SheetNames.find(
    (n) => !FLIPKART_UTILITY_SHEETS.test(n) && !/^dropdownvaluesforcolumn/i.test(n)
  );
  if (!mainSheetName) throw new Error("Ye Flipkart listing template jaisa nahi lag raha — category sheet nahi mili.");

  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[mainSheetName], { header: 1, raw: true });
  const nameRow = aoa[0] || [];
  const descRow = aoa[3] || [];

  const fields = [];
  nameRow.forEach((cellVal, colIdx) => {
    const name = cellVal ? String(cellVal).trim() : "";
    if (!name || isFlipkartSystemField(name)) return;
    const description = descRow[colIdx] ? String(descRow[colIdx]).trim() : "";
    // Flipkart marks mandatory-vs-optional via cell background colour, not
    // text, and encodes dropdown lists through internal cell hyperlinks —
    // neither is reliably readable via the free browser xlsx library, so
    // we fill every field the same way (like we already do for Meesho's
    // optional fields) rather than trying to detect strict mandatory status.
    fields.push({ index: colIdx, name, description, compulsory: false, options: [] });
  });

  return { category: mainSheetName, format: "flipkart", fields };
}

// Amazon has no public downloadable bulk-listing file — the real category
// "flat file" only exists behind Seller Central login. This field list was
// captured directly from Amazon's own "Edit Listing" form + validation
// error messages for the Apparel/Kurta product type, which is an equally
// authoritative source, just via a different route.
const AMAZON_APPAREL_FIELDS = [
  { name: "Item Name", description: "The product title.", compulsory: true },
  { name: "Product Type", description: "Amazon product type / category node, e.g. KURTA.", compulsory: true },
  { name: "Recommended Browse Nodes", description: "Amazon browse node ID — leave blank, Amazon usually assigns this.", compulsory: false },
  { name: "Item Highlight", description: "Short highlight phrase, e.g. Breathable material.", compulsory: false },
  { name: "Brand Name", description: "Brand under which the product is sold.", compulsory: true },
  { name: "Product Description", description: "Full product description.", compulsory: true },
  { name: "Bullet Point 1", description: "First key feature bullet.", compulsory: true },
  { name: "Bullet Point 2", description: "Second key feature bullet.", compulsory: false },
  { name: "Bullet Point 3", description: "Third key feature bullet.", compulsory: false },
  { name: "Bullet Point 4", description: "Fourth key feature bullet.", compulsory: false },
  { name: "Bullet Point 5", description: "Fifth key feature bullet.", compulsory: false },
  { name: "Collar Style", description: "e.g. Buttoned, Spread, Cutaway.", compulsory: false },
  { name: "Model Number", description: "Seller's internal model number.", compulsory: false },
  { name: "Model Name", description: "Seller's internal model name.", compulsory: true },
  { name: "Manufacturer", description: "Manufacturer name.", compulsory: true },
  { name: "Generic Keywords", description: "Backend search keywords.", compulsory: false },
  { name: "Lifestyle", description: "e.g. Athletic.", compulsory: false },
  { name: "Style", description: "e.g. Regular.", compulsory: false },
  { name: "Department Name", description: "e.g. Womens.", compulsory: true },
  { name: "Target Gender", description: "Female / Male / Unisex.", compulsory: true },
  { name: "Age Range Description", description: "e.g. Adult.", compulsory: true },
  { name: "Apparel Size System", description: "e.g. IN.", compulsory: false },
  { name: "Apparel Size Class", description: "e.g. Alpha.", compulsory: false },
  { name: "Material", description: "e.g. Rayon, Cotton.", compulsory: false },
  { name: "Fabric Type", description: "e.g. Rayon, Cotton.", compulsory: true },
  { name: "Number of Items", description: "How many items in the package.", compulsory: false },
  { name: "Item Type Name", description: "e.g. Kurti, Blouse, Tunic Shirt.", compulsory: true },
  { name: "Color Map", description: "Standard Amazon colour bucket, e.g. Black.", compulsory: false },
  { name: "Color", description: "Actual colour name.", compulsory: false },
  { name: "Item Length Description", description: "e.g. Knee Length.", compulsory: false },
  { name: "Occasion", description: "e.g. Party, Daily.", compulsory: false },
  { name: "Part Number", description: "Seller's part number.", compulsory: false },
  { name: "Fit Type", description: "e.g. Regular.", compulsory: false },
  { name: "Care Instructions", description: "e.g. Machine Wash.", compulsory: true },
  { name: "Manufacturer Contact Information", description: "Manufacturer name, address, contact, email.", compulsory: true },
  { name: "Embroidery Type", description: "e.g. Applique, Beaded — leave blank if not embroidered.", compulsory: false },
  { name: "Design Name", description: "e.g. Floral.", compulsory: false },
  { name: "Pattern", description: "e.g. Solid, Printed.", compulsory: false },
  { name: "Unit Count", description: "Numeric unit count, e.g. 1.", compulsory: false },
  { name: "Unit Count Type", description: "e.g. Count.", compulsory: false },
  { name: "Included Components", description: "What's in the box, e.g. 1 Kurta.", compulsory: false },
  { name: "Embellishment Feature", description: "e.g. Embroidery.", compulsory: false },
  { name: "External Product Information Entity", description: "e.g. HSN Code.", compulsory: true },
  { name: "External Product Information", description: "The actual HSN code value.", compulsory: true },
  { name: "Number of Pockets", description: "", compulsory: false },
  { name: "Packer Contact Information", description: "Packer name, address, contact, email.", compulsory: true },
  { name: "Sleeve Type", description: "e.g. 3/4 Sleeve.", compulsory: false },
  { name: "Item Length Longer Edge", description: "Product length value.", compulsory: true },
  { name: "Item Length Unit", description: "e.g. Centimeters.", compulsory: true },
  { name: "Item Weight", description: "Product weight value.", compulsory: true },
  { name: "Item Weight Unit", description: "e.g. Kilograms.", compulsory: true },
  { name: "SKU", description: "Seller SKU, unique per variant.", compulsory: true },
  { name: "Fulfillment Channel Code", description: "Merchant Fulfilled or Fulfilled by Amazon.", compulsory: true },
  { name: "Your Price", description: "Selling price.", compulsory: true },
  { name: "Maximum Retail Price", description: "MRP.", compulsory: false },
  { name: "Item Condition", description: "New / Used etc.", compulsory: false },
  { name: "Package Length", description: "Package length value.", compulsory: true },
  { name: "Package Length Unit", description: "e.g. Centimeters.", compulsory: true },
  { name: "Package Width", description: "Package width value.", compulsory: true },
  { name: "Package Width Unit", description: "e.g. Centimeters.", compulsory: true },
  { name: "Package Height", description: "Package height value.", compulsory: true },
  { name: "Package Height Unit", description: "e.g. Centimeters.", compulsory: true },
  { name: "Package Weight", description: "Package weight value.", compulsory: true },
  { name: "Package Weight Unit", description: "e.g. Kilograms.", compulsory: true },
  { name: "Country/Region of Origin", description: "Country of manufacture.", compulsory: true },
].map((f, i) => ({ ...f, index: i, options: [] }));

function loadAmazonApparelTemplate() {
  return { category: "Amazon Apparel (built-in — no downloadable file exists)", format: "amazon", fields: AMAZON_APPAREL_FIELDS };
}

// Fields Amazon expects that are computed directly from the seller's form
// inputs (weight/dimensions/price/etc) rather than left to the AI — reuses
// the same Weight/piece-count/price inputs already collected for Flipkart.
function getAmazonSpecialValue(name, form) {
  const dim = Number(form.pieceCount) >= 2 ? 14 : 10;
  const table = {
    "Product Type": form.amazonProductType || "KURTA",
    "Item Weight": form.weightKg,
    "Item Weight Unit": "Kilograms",
    "Package Weight": form.weightKg,
    "Package Weight Unit": "Kilograms",
    "Item Length Longer Edge": dim,
    "Item Length Unit": "Centimeters",
    "Package Length": dim,
    "Package Length Unit": "Centimeters",
    "Package Width": dim,
    "Package Width Unit": "Centimeters",
    "Package Height": dim,
    "Package Height Unit": "Centimeters",
    "Country/Region of Origin": "India",
    "Item Condition": "New",
    "Fulfillment Channel Code": form.amazonFulfillment || "Merchant Fulfilled",
    "Your Price": form.meeshoPrice,
    "Maximum Retail Price": form.mrp,
  };
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

function isImageField(name) {
  return /image/i.test(name);
}
function isColorField(name) {
  return /color/i.test(name);
}
function isStyleIdField(name) {
  return /style id|product id|style code/i.test(name);
}
function isSkuIdField(name) {
  return /sku id/i.test(name) || /^sku$/i.test(name.trim());
}
function isGroupIdField(name) {
  return /group id/i.test(name);
}
function isDupattaField(name) {
  return /dupatta/i.test(name);
}
function isShippingProviderField(name) {
  return /shipping provider/i.test(name);
}
function isWeightKgField(name) {
  return /^weight \(kg\)$/i.test(name.trim());
}

// Flipkart's standard garments handling-fee rate card: base rate for the
// first 0.5kg, then a fixed increment for every additional 0.5kg slab.
// This is the STANDARD card — actual fee can vary by seller tier
// (Bronze/Silver/Gold) and fulfilment type, which is why manual entry
// still overrides this when the seller knows their real rate.
function calculateGarmentHandlingFees(weightKg) {
  const w = parseFloat(weightKg);
  if (!w || w <= 0) return { local: 47, zonal: 54, national: 68 };
  const base = { local: 47, zonal: 54, national: 68 };
  if (w <= 0.5) return base;
  const extraSlabs = Math.ceil((w - 0.5) / 0.5);
  return {
    local: base.local + extraSlabs * 4,
    zonal: base.zonal + extraSlabs * 19,
    national: base.national + extraSlabs * 26,
  };
}
function isHandlingFeeField(name) {
  return /handling fee/i.test(name);
}
function isPackageDimensionField(name) {
  return /^(length|breadth|height) \(cm\)$/i.test(name.trim());
}
function isHandledSpecially(name) {
  return (
    isImageField(name) || isColorField(name) || isStyleIdField(name) || isSkuIdField(name) || isGroupIdField(name) ||
    isWeightKgField(name) || isHandlingFeeField(name) || isPackageDimensionField(name) || isShippingProviderField(name)
  );
}

async function generateListingDraft(template, productInfo, sizes) {
  // Send every field the AI itself needs to fill in — both compulsory and
  // optional (e.g. Product Description, Brand, Ornamentation) — except
  // the ones we compute ourselves (color/Style ID/SKU ID/Group ID) or that
  // need a real file (Image columns), which AI can't meaningfully fill.
  const aiFields = template.fields.filter((f) => !isHandledSpecially(f.name));
  // Large categories (e.g. "Kurti With Bottomwear") can have 40-60+ fields —
  // trim hints/options so the prompt stays a reasonable size and the
  // response comfortably fits in max_tokens.
  const maxOptionsPerField = aiFields.length > 25 ? 12 : 40;
  const fieldSpec = aiFields.map((f) => ({
    name: f.name,
    hint: f.description ? f.description.slice(0, 100) : undefined,
    allowedValues: f.options.length ? f.options.slice(0, maxOptionsPerField) : undefined,
  }));

  const prompt = `Tum ek Indian e-commerce seller ke liye Meesho product listing draft bana rahe ho, category: "${template.category}".

Seller ne ye basic info di hai:
${JSON.stringify(productInfo, null, 2)}

Sizes/variants fill karne hain: ${JSON.stringify(sizes)}

Har size ke liye, neeche diye gaye fields fill karo. Jahan "allowedValues" diya hai, sirf usi list mein se exact ek value choose karo (spelling bilkul match honi chahiye) — bahar ki value mat do. Jahan allowedValues nahi diya, apna reasonable text likho seller ki basic info ke hisaab se. Values short aur crisp rakho (koi bhi ek value 4-5 words se zyada lamba mat likho, sirf Product Description field lamba ho sakta hai).

Fields:
${JSON.stringify(fieldSpec, null, 2)}

Respond ONLY with a JSON array (no markdown, no preamble, no code fences), one object per size, in the same order as the sizes list. Each object's keys must be exactly the field "name" values above (plus a "Variation" key set to that row's size), and values must be strings or numbers.`;

  // Response size scales with fields x sizes — give it enough room, capped
  // at a sane ceiling so a huge template + many sizes doesn't hang forever.
  const estimatedTokens = fieldSpec.length * sizes.length * 25 + 1000;
  const maxTokens = Math.min(8000, Math.max(2000, estimatedTokens));

  let response;
  try {
    response = await fetch("/.netlify/functions/claude-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
  } catch (networkErr) {
    throw new Error("Network error — internet connection check karo aur dobara try karo.");
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || JSON.stringify(errBody).slice(0, 200);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`AI request fail hui (status ${response.status})${detail ? ": " + detail : ""}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("AI se response mein text nahi mila.");

  let clean = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (parseErr) {
    // Response may have been cut off mid-JSON if it hit the token limit —
    // this is more informative than a raw "unexpected end of JSON" error.
    throw new Error("AI ka response poora nahi mila (shayad bahut bada tha) — kam sizes ke saath ya chhoti category ke saath dobara try karo.");
  }
  if (!Array.isArray(parsed)) throw new Error("Response format galat tha — array nahi mila.");
  return parsed;
}

function ListingDraftTool({ onBack }) {
  const [template, setTemplate] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("idle"); // idle | generating | done | failed
  const [generationSummary, setGenerationSummary] = useState("");
  const [rows, setRows] = useState(null);
  const templateRef = useRef(null);
  const flipkartTemplateRef = useRef(null);

  const [form, setForm] = useState({
    productName: "", keyFeatures: "", meeshoPrice: "", mrp: "",
    colors: "", fabric: "", sizes: "S, M, L, XL", skuPrefix: "", brand: "",
    hasDupatta: false,
    weightKg: "", localHandlingFee: "", zonalHandlingFee: "", nationalHandlingFee: "", pieceCount: "1",
    amazonProductType: "KURTA", amazonFulfillment: "Merchant Fulfilled",
  });

  const handleMeeshoTemplateUpload = async (file) => {
    setError(""); setTemplate(null); setRows(null); setGenerationSummary("");
    try {
      const parsed = await parseMeeshoListingTemplate(file);
      setTemplate(parsed);
    } catch (err) {
      setError(err.message || "Template parse nahi ho payi.");
    }
  };

  const handleFlipkartTemplateUpload = async (file) => {
    setError(""); setTemplate(null); setRows(null); setGenerationSummary("");
    try {
      const parsed = await parseFlipkartListingTemplate(file);
      setTemplate(parsed);
    } catch (err) {
      setError(err.message || "Template parse nahi ho payi.");
    }
  };

  const handleGenerate = async () => {
    if (!template) return;
    setStatus("generating"); setError("");
    const sizes = form.sizes.split(",").map((s) => s.trim()).filter(Boolean);
    const colors = form.colors.split(",").map((c) => c.trim()).filter(Boolean);
    if (!colors.length) colors.push(""); // still works with no color specified

    const slugify = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    // If the seller's own Product Code happens to contain one of the color
    // names (e.g. code "K-WHITE-PLAZO-SET" but colors White/Pink/Black),
    // every row would end up with that color word baked in regardless of
    // its actual color — strip any color word out of the base code first.
    let baseCode = form.skuPrefix || form.productName || "PRODUCT";
    colors.forEach((c) => {
      if (!c) return;
      const re = new RegExp(c.trim(), "gi");
      baseCode = baseCode.replace(re, "");
    });
    const groupId = slugify(baseCode) || "PRODUCT";

    const productInfo = {
      "Product Name": form.productName,
      "Key features / description hints (use for Product Description field)": form.keyFeatures,
      "Meesho Price": form.meeshoPrice,
      "MRP": form.mrp,
      "Colors (will be filled in separately per variant)": colors.join(", ") || "single color",
      "Fabric": form.fabric,
      "Brand": form.brand || "Generic / Unbranded",
    };
    try {
      // One AI call regardless of how many colors — size-dependent fields
      // (measurements etc.) don't change with color, so we generate them
      // once per size and then replicate across every color ourselves.
      const draftRows = await generateListingDraft(template, productInfo, sizes);
      const baseRowsBySize = sizes.map((size, i) => ({
        ...(draftRows[i] || draftRows[draftRows.length - 1] || {}),
        Variation: size,
        "Product Name": form.productName || draftRows[i]?.["Product Name"],
      }));

      const finalRows = [];
      colors.forEach((color) => {
        const styleId = [slugify(color), groupId].filter(Boolean).join("-");
        baseRowsBySize.forEach((baseRow) => {
          const skuId = [slugify(color), slugify(baseRow.Variation), groupId].filter(Boolean).join("-");
          // Build the row by walking the template's own field list in its
          // original left-to-right order, so every column — including the
          // ones we just added (Product Description, Brand, etc.) — lands
          // in exactly the same position as the official template.
          const row = {};
          const autoFees = calculateGarmentHandlingFees(form.weightKg);
          const amazonSpecial = template.format === "amazon" ? getAmazonSpecialValue : () => undefined;
          template.fields.forEach((f) => {
            const amazonVal = amazonSpecial(f.name, form);
            if (amazonVal !== undefined) row[f.name] = amazonVal;
            else if (isWeightKgField(f.name)) row[f.name] = form.weightKg;
            else if (isShippingProviderField(f.name)) row[f.name] = "Flipkart";
            else if (/local handling/i.test(f.name)) row[f.name] = form.localHandlingFee || autoFees.local;
            else if (/zonal handling/i.test(f.name)) row[f.name] = form.zonalHandlingFee || autoFees.zonal;
            else if (/national handling/i.test(f.name)) row[f.name] = form.nationalHandlingFee || autoFees.national;
            else if (isPackageDimensionField(f.name)) {
              // Business rule: single-piece products pack smaller than
              // 2-3 piece sets (dupatta, co-ord sets, etc).
              row[f.name] = Number(form.pieceCount) >= 2 ? 14 : 10;
            }
            else if (isDupattaField(f.name) && !form.hasDupatta) {
              // No dupatta in this product — use the template's own "No
              // Dupatta" option where it exists (e.g. Dupatta Fabric);
              // fields with no such option (e.g. Dupatta Color, which only
              // lists real colors) are correctly left blank instead.
              const noDupattaOption = f.options.find((o) => /no dupatta|without dupatta|^na$/i.test(o));
              row[f.name] = noDupattaOption || "";
            }
            else if (isImageField(f.name)) row[f.name] = "";
            else if (isColorField(f.name)) row[f.name] = color || "";
            else if (isStyleIdField(f.name)) row[f.name] = styleId;
            else if (isSkuIdField(f.name)) row[f.name] = skuId;
            else if (isGroupIdField(f.name)) row[f.name] = groupId;
            else row[f.name] = baseRow[f.name] ?? "";
          });
          finalRows.push(row);
        });
      });

      setGenerationSummary(`${colors.filter(Boolean).length || 1} colors × ${sizes.length} sizes = ${finalRows.length} rows generate hue.`);

      setRows(finalRows);
      setStatus("done");
    } catch (err) {
      setError(err.message || "AI draft generate nahi ho paya — dobara try karo.");
      setStatus("failed");
    }
  };

  const updateCell = (rowIdx, key, value) => {
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r)));
  };

  const [copyState, setCopyState] = useState("idle"); // idle | copied | fallback
  const fallbackTextareaRef = useRef(null);

  useEffect(() => {
    if (copyState === "fallback" && fallbackTextareaRef.current) {
      fallbackTextareaRef.current.focus();
      fallbackTextareaRef.current.select();
    }
  }, [copyState]);
  const [csvText, setCsvText] = useState("");

  const downloadCsv = () => {
    if (!rows || !rows.length) return;
    const csv = Papa.unparse(rows);
    const encodedUri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    const a = document.createElement("a");
    a.href = encodedUri;
    a.download = `${(template.category || "listing").replace(/[^a-z0-9]/gi, "_")}_draft.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const copyCsv = async () => {
    if (!rows || !rows.length) return;
    // Tab-separated, not comma-separated: Excel/Google Sheets only
    // auto-split pasted clipboard text into columns when it's TSV. A plain
    // comma-separated paste lands as one blob of text in a single cell.
    const tsv = Papa.unparse(rows, { delimiter: "\t" });

    try {
      await navigator.clipboard.writeText(tsv);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2500);
      return;
    } catch (err) {
      // Clipboard API blocked — try the older execCommand path next.
    }

    try {
      const temp = document.createElement("textarea");
      temp.value = tsv;
      temp.style.position = "fixed";
      temp.style.left = "-9999px";
      document.body.appendChild(temp);
      temp.focus();
      temp.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(temp);
      if (ok) {
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 2500);
        return;
      }
    } catch (err) {
      // fall through to visible textarea below
    }

    setCsvText(tsv);
    setCopyState("fallback");
  };

  const columns = rows && rows.length ? Object.keys(rows[0]) : [];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", fontFamily: "system-ui, sans-serif", color: "#1a1a1a", padding: "24px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "#0F6E56", textTransform: "uppercase", margin: "0 0 4px" }}>GetDigitals Seller Doctor</p>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Listing Draft Generator</h1>
        </div>
        <button onClick={onBack} style={{ background: "transparent", color: "#6b6b68", border: "1px solid #e5e4df", padding: "6px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer" }}>← Wapas</button>
      </div>

      {!template && (
        <div style={{ maxWidth: 480, margin: "40px auto", textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#6b6b68", marginBottom: 16, lineHeight: 1.6 }}>
            Apne Meesho ya Flipkart seller panel se category ka **khali bulk-listing template** download karo, aur yahan upload karo.
          </p>
          <input type="file" accept=".xlsx,.zip" ref={templateRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleMeeshoTemplateUpload(e.target.files[0])} />
          <button onClick={() => templateRef.current.click()} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%", marginBottom: 10 }}>
            Meesho category template upload karo
          </button>
          <input type="file" accept=".xls,.xlsx,.zip" ref={flipkartTemplateRef} style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleFlipkartTemplateUpload(e.target.files[0])} />
          <button onClick={() => flipkartTemplateRef.current.click()} style={{ background: "#fff", color: "#0F6E56", border: "1px solid #0F6E56", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%", marginBottom: 10 }}>
            Flipkart category template upload karo
          </button>
          <button onClick={() => { setError(""); setRows(null); setGenerationSummary(""); setTemplate(loadAmazonApparelTemplate()); }} style={{ background: "#fff", color: "#0F6E56", border: "1px solid #0F6E56", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%" }}>
            Amazon Apparel listing banao (built-in — koi file chahiye nahi)
          </button>
          {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 16 }}>{error}</p>}
        </div>
      )}

      {template && (
        <>
          <div style={{ background: "#f4f3ef", borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
            <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 4px" }}>{template.category}</p>
            <p style={{ fontSize: 12, color: "#6b6b68", margin: 0 }}>
              {template.format === "flipkart"
                ? `${template.fields.length} fields detect hue — sab fill honge (Image/QC/system columns chhodkar). Flipkart mandatory-vs-optional color-coding browser se nahi padhi ja sakti, isliye sab fields fill kar rahe hain.`
                : template.format === "amazon"
                ? `${template.fields.filter((f) => f.compulsory).length} required + ${template.fields.filter((f) => !f.compulsory).length} optional fields — Amazon Seller Central ke real listing form se liye gaye (koi downloadable file available nahi hai, isliye ye built-in list hai).`
                : `${template.fields.filter((f) => f.compulsory).length} compulsory + ${template.fields.filter((f) => !f.compulsory).length} optional fields detect hue — sab fill honge (Image columns chhodkar, wo manual rahenge).`}
            </p>
          </div>

          {!rows && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <input placeholder="Product Name" value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="Colors (comma se, e.g. White, Black, Red)" value={form.colors} onChange={(e) => setForm({ ...form, colors: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="Fabric" value={form.fabric} onChange={(e) => setForm({ ...form, fabric: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="Brand (optional, e.g. Generic)" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="Selling Price (₹)" value={form.meeshoPrice} onChange={(e) => setForm({ ...form, meeshoPrice: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="MRP (₹)" value={form.mrp} onChange={(e) => setForm({ ...form, mrp: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              <input placeholder="Sizes (comma separated)" value={form.sizes} onChange={(e) => setForm({ ...form, sizes: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
              {template.fields.some((f) => isDupattaField(f.name)) && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14, color: "#6b6b68" }}>
                  <input type="checkbox" checked={form.hasDupatta} onChange={(e) => setForm({ ...form, hasDupatta: e.target.checked })} />
                  Is set mein Dupatta hai (3-piece set)
                </label>
              )}
              {(template.format === "flipkart" || template.format === "amazon") && (
                <>
                  <input placeholder="Weight in KG (e.g. 0.3)" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
                  <div>
                    <select value={form.pieceCount} onChange={(e) => setForm({ ...form, pieceCount: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14, width: "100%", boxSizing: "border-box" }}>
                      <option value="1">Single piece</option>
                      <option value="2">2-piece set</option>
                      <option value="3">3-piece set</option>
                    </select>
                    <p style={{ fontSize: 11, color: "#9a9a95", margin: "4px 0 0" }}>Package length/breadth/height isी se decide hoga (single = 10cm, 2-3pc = 14cm).</p>
                  </div>
                </>
              )}
              {template.format === "flipkart" && (
                <details style={{ gridColumn: "1 / -1", fontSize: 13, color: "#6b6b68" }}>
                  <summary style={{ cursor: "pointer", padding: "6px 0" }}>Handling fee override (optional — weight se auto-calculate ho jata hai, sirf tab bharo agar tumhara actual rate alag hai)</summary>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
                    <input placeholder="Local handling fee (₹)" value={form.localHandlingFee} onChange={(e) => setForm({ ...form, localHandlingFee: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
                    <input placeholder="Zonal handling fee (₹)" value={form.zonalHandlingFee} onChange={(e) => setForm({ ...form, zonalHandlingFee: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
                    <input placeholder="National handling fee (₹)" value={form.nationalHandlingFee} onChange={(e) => setForm({ ...form, nationalHandlingFee: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
                  </div>
                </details>
              )}
              {template.format === "amazon" && (
                <>
                  <input placeholder="Amazon Product Type (e.g. KURTA)" value={form.amazonProductType} onChange={(e) => setForm({ ...form, amazonProductType: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }} />
                  <select value={form.amazonFulfillment} onChange={(e) => setForm({ ...form, amazonFulfillment: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14 }}>
                    <option value="Merchant Fulfilled">Merchant Fulfilled (self-ship)</option>
                    <option value="Fulfilled by Amazon">Fulfilled by Amazon (FBA)</option>
                  </select>
                </>
              )}
              <div>
                <input placeholder="Product Code (ek hi, short, e.g. KWS01)" value={form.skuPrefix} onChange={(e) => setForm({ ...form, skuPrefix: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14, width: "100%", boxSizing: "border-box" }} />
                <p style={{ fontSize: 11, color: "#9a9a95", margin: "4px 0 0" }}>Chhota code rakho (comma se multiple mat daalo) — tool khud har color ke liye alag ID banayega.</p>
              </div>
              <textarea placeholder="Key features / short description hints" value={form.keyFeatures} onChange={(e) => setForm({ ...form, keyFeatures: e.target.value })} style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 14, gridColumn: "1 / -1", minHeight: 60 }} />
            </div>
          )}

          {!rows && (
            <button onClick={handleGenerate} disabled={status === "generating"} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: "pointer", width: "100%", opacity: status === "generating" ? 0.6 : 1 }}>
              {status === "generating" ? "AI draft bana raha hai..." : "AI se listing draft banao"}
            </button>
          )}
          {error && <p style={{ color: "#A32D2D", fontSize: 13, marginTop: 12 }}>{error}</p>}

          {rows && (
            <>
              {generationSummary && (
                <p style={{ fontSize: 12, color: "#0F6E56", fontWeight: 500, margin: "0 0 10px" }}>{generationSummary}</p>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <p style={{ fontSize: 13, color: "#6b6b68", margin: 0 }}>Values edit kar sakte ho neeche seedha click karke.</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={copyCsv} style={{ background: "#0F6E56", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
                    {copyState === "copied" ? "Copied ✓" : "Copy (paste into Excel)"}
                  </button>
                  <button onClick={downloadCsv} style={{ background: "transparent", color: "#0F6E56", border: "1px solid #0F6E56", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>Download CSV</button>
                </div>
              </div>
              {copyState === "fallback" && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontSize: 12, color: "#BA7517", margin: "0 0 6px" }}>
                    Text neeche pehle se select hai — bas box ko ek baar tap-hold karo aur jo popup menu aaye usmein "Copy" dabao.
                  </p>
                  <textarea
                    ref={fallbackTextareaRef}
                    readOnly
                    value={csvText}
                    onFocus={(e) => e.target.select()}
                    style={{ width: "100%", minHeight: 100, padding: 10, borderRadius: 8, border: "1px solid #e5e4df", fontSize: 11, fontFamily: "monospace" }}
                  />
                </div>
              )}
              <div style={{ overflowX: "auto", border: "1px solid #e5e4df", borderRadius: 8 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead>
                    <tr style={{ background: "#f4f3ef" }}>
                      {columns.map((col) => (
                        <th key={col} style={{ padding: "8px 10px", textAlign: "left", whiteSpace: "nowrap", fontWeight: 500, color: "#6b6b68" }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #f0efeb" }}>
                        {columns.map((col) => (
                          <td key={col} style={{ padding: 0, borderRight: "1px solid #f0efeb" }}>
                            <input
                              value={row[col] ?? ""}
                              onChange={(e) => updateCell(i, col, e.target.value)}
                              style={{ border: "none", padding: "8px 10px", fontSize: 12, width: 140, background: "transparent" }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 12, color: "#9a9a95", marginTop: 12 }}>
                Ye compulsory fields hain. Manufacturer/Packer/Importer jaisi fixed details (jo har listing mein same rehti hain) copy-paste karke apne official template mein daal dena — AI ne unhe generic rakha hai kyunki wo tumhare business ki details hain, guess nahi ki ja sakti.
              </p>
              <p style={{ fontSize: 12, color: "#9a9a95", marginTop: 6 }}>
                Har color ke liye alag "Style/Product ID" aur har size ke liye unique "SKU ID" ban gaya hai — sab colors/sizes ka "Group ID" same rakha hai taaki Meesho isse ek hi catalog listing samjhe (ye teeno rules Meesho ke apne template se liye gaye hain).
              </p>
            </>
          )}
        </>
      )}

      <p style={{ fontSize: 11, color: "#c2c1bc", marginTop: 24, textAlign: "center" }}>GetDigitals Seller Doctor</p>
    </div>
  );
}

export default function SellerDoctorTool({ hasAccess = true, onRequestPayment = () => {} }) {
  const [mode, setMode] = useState("main"); // main | listing
  // mode only ever becomes "listing" via onOpenListingTool, which itself
  // checks hasAccess first — so an unpaid user never actually reaches
  // ListingDraftTool. No extra guard needed here.
  if (mode === "listing") return <ListingDraftTool onBack={() => setMode("main")} />;
  return <ProfitDashboardApp onOpenListingTool={() => setMode("listing")} hasAccess={hasAccess} onRequestPayment={onRequestPayment} />;
}
