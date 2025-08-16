// Top-level crash logs so 502/crashes show a reason
process.on("unhandledRejection", (r) => console.error("UNHANDLED_REJECTION", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));

/* Omni–Zoho Dispatch Server (India DC) */
const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());

// ---------- CORS (allowlist) ----------
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Helpful for proxies/CDN
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// Use function (origin, cb) form
app.use(cors({
  origin(origin, cb) {
    // Postman/cURL / same-origin / server-side requests
    if (!origin) return cb(null, true);
    if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
// Preflight
app.options("*", cors());

const PORT = process.env.PORT || 3000;
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// ---------- Zoho DC Endpoints ----------
const ACCOUNTS = (() => {
  const v = process.env.ZOHO_ACCESS_TOKEN_URL;
  if (v) {
    try { return new URL(v).origin; } catch { return String(v).replace(/\/oauth\/v2\/token.*$/,''); }
  }
  return "https://accounts.zoho.in"; // India DC
})();
const APIS = (() => {
  const v = process.env.ZOHO_BASE_URL;
  if (v) {
    try { return new URL(v).origin; } catch { return String(v); }
  }
  return "https://www.zohoapis.in"; // India DC
})();

// ---------- OAuth token cache ----------
let TOKEN_CACHE = { token: null, expiry: 0 };
const tokenValid = () => TOKEN_CACHE.token && Date.now() < TOKEN_CACHE.expiry - 60_000;

async function refreshAccessToken() {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });

  const res = await axios.post(`${ACCOUNTS}/oauth/v2/token`, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: () => true,
  });

  if (res.status !== 200 || !res.data?.access_token) {
    const detail = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const err = new Error(`Refresh failed ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = res.data;
    throw err;
  }

  const { access_token, expires_in } = res.data;
  TOKEN_CACHE.token = access_token;
  TOKEN_CACHE.expiry = Date.now() + Number(expires_in || 3600) * 1000;
  return TOKEN_CACHE.token;
}
async function getAccessToken(force = false) {
  if (!force && tokenValid()) return TOKEN_CACHE.token;
  return refreshAccessToken();
}

// ---------- Generic Zoho caller ----------
async function zoho(path, { method = "GET", body } = {}) {
  let token = await getAccessToken();
  const url = `${APIS}${path}`;

  const call = () => axios({
    url,
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`, // NOTE: not 'Bearer'
      "Content-Type": "application/json",
    },
    data: body ? JSON.stringify(body) : undefined,
    validateStatus: () => true,
  });

  let res = await call();
  const invalid =
    res.status === 401 ||
    res?.data?.code === "INVALID_TOKEN" ||
    res?.data?.message === "INVALID_TOKEN";

  if (invalid) {
    token = await getAccessToken(true);
    res = await call();
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`Zoho CRM ${res.status}`);
    err.status = res.status;
    err.body = res.data;
    throw err;
  }
  return res.data;
}

// ---------- Helpers ----------
function safeString(v) {
  return (v == null ? "" : String(v)).trim();
}
function makeLeadDescription({ message, source_url, utm }) {
  const parts = [];
  if (message) parts.push(`Message: ${message}`);
  if (source_url) parts.push(`Source URL: ${source_url}`);
  if (utm && (utm.utm_source || utm.utm_medium || utm.utm_campaign)) {
    parts.push(
      `UTM -> source=${utm.utm_source || ""}, medium=${utm.utm_medium || ""}, campaign=${utm.utm_campaign || ""}`
    );
  }
  return parts.join("\n");
}

// ---------- Lead find/create ----------
async function findOrCreateLead({ name, phone, email, product_line, message, source_url, utm }) {
  let leadId = null;

  try {
    const search = await zoho(
      `/crm/v2/Leads/search?criteria=${encodeURIComponent(`(Phone:equals:${phone})`)}`
    );
    if (search?.data?.length) leadId = search.data[0].id;
  } catch (_) {
    // 204/NOT_FOUND/400 etc → ignore
  }
  if (leadId) return leadId;

  const productField = process.env.ZOHO_LEAD_PRODUCT_FIELD || "Product_Line";

  const record = {
    Last_Name: safeString(name) || "Incoming Lead",
    Phone: phone,
    Company: "Unknown",
    Lead_Source: "Website",
  };

  if (email) record.Email = email;
  if (product_line) record[productField] = product_line;

  const desc = makeLeadDescription({ message, source_url, utm });
  if (desc) record.Description = desc;

  const created = await zoho("/crm/v2/Leads", { method: "POST", body: { data: [record] } });
  const row = created?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  const err = new Error("Lead create failed");
  err.status = 422;
  err.body = created;
  throw err;
}

// ---------- Task: avoid duplicates & include phone in Subject ----------
async function findOpenTaskForLead(leadId) {
  // What_Id = leadId AND Status in (Not Started, In Progress)
  const crit =
    `(What_Id:equals:${leadId}) and (Status:equals:Not Started or Status:equals:In Progress)`;
  try {
    const resp = await zoho(`/crm/v2/Tasks/search?criteria=${encodeURIComponent(crit)}`);
    const row = resp?.data?.[0];
    return row?.id || null;
  } catch (_) {
    return null; // 204 / NOT_FOUND etc
  }
}

async function ensureFollowupTask(leadId, phone) {
  if (!leadId) throw Object.assign(new Error("Invalid leadId"), { status: 400 });

  const existing = await findOpenTaskForLead(leadId);
  if (existing) return existing;

  const due = new Date();
  due.setHours(due.getHours() + DUE_HOURS);

  // Base payload with Subject including phone
  const base = {
    Subject: `Follow up on incoming call – ${phone}`,
    Status: "Not Started",
    Due_Date: due.toISOString().split("T")[0],
  };

  // Primary attempt: What_Id + se_module=Leads
  let payload = { data: [{ ...base, What_Id: { id: leadId }, se_module: "Leads" }] };
  let out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  let row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  // Fallback: Who_Id (some orgs accept this linkage)
  payload = { data: [{ ...base, Who_Id: { id: leadId } }] };
  out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  // Final fallback: unlinked task so workflow continues
  const finalPayload = {
    data: [{
      ...base,
      Description: `LeadId: ${leadId} (linking failed)`,
    }]
  };
  const outFinal = await zoho("/crm/v2/Tasks", { method: "POST", body: finalPayload });
  const rowFinal = outFinal?.data?.[0];
  if (rowFinal?.code === "SUCCESS") return rowFinal.details.id;

  const err = new Error("Task create failed (What_Id/Who_Id/se_module tried)");
  err.status = 422;
  err.body = { first: out, final: outFinal };
  throw err;
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.send("✅ Omni–Zoho Dispatch Server (India DC) is running!"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/dispatch-call", async (req, res) => {
  try {
    // Accept extra fields from the website form
    const {
      name,
      phone,
      email,
      product_line,
      message,
      source_url,
      utm_source,
      utm_medium,
      utm_campaign,
    } = req.body || {};

    if (!phone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    const utm = { utm_source, utm_medium, utm_campaign };

    const leadId = await findOrCreateLead({
      name, phone, email, product_line, message, source_url, utm,
    });

    // Task subject now contains phone + duplicate prevention
    const taskId = await ensureFollowupTask(leadId, phone);

    return res.json({ success: true, leadId, taskId });
  } catch (err) {
    const status = err.status || err.response?.status || 500;
    console.error("ERROR:", status, err.body || err.response?.data || err.message);
    return res.status(status).json({
      success: false,
      message: err.message || "Internal error",
      zoho: err.body || err.response?.data || null,
    });
  }
});

// ---------- Start server ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server listening on", PORT);
  console.log("Zoho ACCOUNTS:", ACCOUNTS, "APIS:", APIS);
});
