// Top-level crash logs (to surface 500 reasons in Render logs)
process.on("unhandledRejection", (r) => console.error("UNHANDLED_REJECTION", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));

/* Omni–Zoho Dispatch Server (India DC) */
const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());

// ---- CORS allowlist (comma-separated origins in .env -> ALLOW_ORIGINS) ----
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  // Helpful for proxies/CDN
  res.setHeader("Vary", "Origin");
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      // Allow tools like Postman (no Origin)
      if (!origin) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

const PORT = process.env.PORT || 3000;
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// ---- Zoho DC base URLs (overridable) ----
const ACCOUNTS = (() => {
  const v = process.env.ZOHO_ACCESS_TOKEN_URL;
  if (v) {
    try {
      return new URL(v).origin;
    } catch {
      return String(v).replace(/\/oauth\/v2\/token.*$/, "");
    }
  }
  return "https://accounts.zoho.in"; // India DC
})();

const APIS = (() => {
  const v = process.env.ZOHO_BASE_URL;
  if (v) {
    try {
      return new URL(v).origin;
    } catch {
      return String(v);
    }
  }
  return "https://www.zohoapis.in"; // India DC
})();

// ---- OAuth token cache/refresh ----
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

// ---- Zoho generic caller (auto-refresh on 401/INVALID_TOKEN) ----
async function zoho(path, { method = "GET", body } = {}) {
  let token = await getAccessToken();
  const url = `${APIS}${path}`;

  const call = () =>
    axios({
      url,
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`, // NOTE: Zoho expects this token prefix
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

// ---- Utility: Zoho datetime with local offset (YYYY-MM-DDTHH:mm:ss±HH:mm) ----
function toZohoDateTime(d = new Date()) {
  const iso = d.toISOString().slice(0, 19); // remove trailing Z & ms
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(tzMin) / 60)).padStart(2, "0");
  const mm = String(Math.abs(tzMin) % 60).padStart(2, "0");
  return `${iso}${sign}${hh}:${mm}`;
}

/* ---------------- Lead find/create ---------------- */
async function findOrCreateLead({ name, phone, product_line }) {
  let leadId = null;

  // Try search by Phone
  try {
    const search = await zoho(
      `/crm/v2/Leads/search?criteria=(Phone:equals:${encodeURIComponent(phone)})`
    );
    if (search?.data?.length) leadId = search.data[0].id;
  } catch (_) {
    // ignore 204/400 etc.
  }
  if (leadId) return leadId;

  const productField = process.env.ZOHO_LEAD_PRODUCT_FIELD || "Product_Line";

  const record = {
    Last_Name: name || "Incoming Lead",
    Phone: phone,
    Company: "Unknown",
    Lead_Source: "Incoming Call",
  };
  if (product_line) record[productField] = product_line;

  const created = await zoho("/crm/v2/Leads", { method: "POST", body: { data: [record] } });
  const row = created?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  const err = new Error("Lead create failed");
  err.status = 422;
  err.body = created;
  throw err;
}

/* ---------------- Task create (Who/What fallback) ---------------- */
async function createTask(leadId) {
  if (!leadId || typeof leadId !== "string" || leadId.length < 15) {
    throw Object.assign(new Error(`Invalid leadId: ${leadId}`), { status: 400 });
  }

  const due = new Date();
  due.setHours(due.getHours() + DUE_HOURS);

  const base = {
    Subject: "Follow up on incoming call",
    Status: "Not Started",
    Due_Date: due.toISOString().split("T")[0], // YYYY-MM-DD
  };

  // 1) Who_Id (Lead/Contact)
  let payload = { data: [{ ...base, Who_Id: { id: leadId } }] };
  let out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  let row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  const whoErr =
    Array.isArray(out?.data) &&
    out.data.some((d) => d?.details?.api_name === "Who_Id" || d?.message?.includes?.("Who"));

  // 2) What_Id
  if (whoErr) {
    payload = { data: [{ ...base, What_Id: { id: leadId } }] };
    out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
    row = out?.data?.[0];
    if (row?.code === "SUCCESS") return row.details.id;
  }

  const whatErr =
    Array.isArray(out?.data) &&
    out.data.some((d) => d?.details?.api_name === "What_Id" || d?.message?.includes?.("What"));

  // 3) What_Id + se_module
  if (whoErr || whatErr) {
    payload = { data: [{ ...base, What_Id: { id: leadId }, se_module: "Leads" }] };
    out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
    row = out?.data?.[0];
    if (row?.code === "SUCCESS") return row.details.id;
  }

  // 4) Unlinked fallback
  const fallback = {
    ...base,
    Description: `LeadId: ${leadId} (linking failed via Who_Id/What_Id)`,
  };
  const outFinal = await zoho("/crm/v2/Tasks", {
    method: "POST",
    body: { data: [fallback] },
  });
  const rowFinal = outFinal?.data?.[0];
  if (rowFinal?.code === "SUCCESS") return rowFinal.details.id;

  const err = new Error("Task create failed (Who_Id, What_Id, se_module tried)");
  err.status = 422;
  err.body = { first: out, final: outFinal };
  throw err;
}

/* ---------------- Call Log create (Who/What fallback) ---------------- */
const CALL_PHONE_FIELD = process.env.ZOHO_CALL_PHONE_FIELD || ""; // optional custom field API name

async function createCallLog(leadId, { name, phone } = {}) {
  if (!leadId) throw Object.assign(new Error("leadId missing for call log"), { status: 400 });

  const now = new Date();
  const start = toZohoDateTime(now);

  const subject = `Website call ${phone ? `(${phone})` : ""}`.trim();

  // Base payload; If you have custom phone field put it via env above
  const base = {
    Subject: subject,
    Call_Type: "Outbound",
    Call_Start_Time: start,
    Call_Duration: 0, // seconds (or minutes; Zoho accepts in seconds for v2)
    Description: `Website request — LeadId: ${leadId}${name ? ` | ${name}` : ""}${
      phone ? ` | ${phone}` : ""
    }`,
  };

  if (CALL_PHONE_FIELD && phone) {
    base[CALL_PHONE_FIELD] = phone;
  }

  // 1) Try Who_Id
  let payload = { data: [{ ...base, Who_Id: { id: leadId } }] };
  let out = await zoho("/crm/v2/Calls", { method: "POST", body: payload });
  let row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  const whoErr =
    Array.isArray(out?.data) &&
    out.data.some((d) => d?.details?.api_name === "Who_Id" || d?.message?.includes?.("Who"));

  // 2) Try What_Id
  if (whoErr) {
    payload = { data: [{ ...base, What_Id: { id: leadId } }] };
    out = await zoho("/crm/v2/Calls", { method: "POST", body: payload });
    row = out?.data?.[0];
    if (row?.code === "SUCCESS") return row.details.id;
  }

  const whatErr =
    Array.isArray(out?.data) &&
    out.data.some((d) => d?.details?.api_name === "What_Id" || d?.message?.includes?.("What"));

  // 3) What_Id + se_module
  if (whoErr || whatErr) {
    payload = { data: [{ ...base, What_Id: { id: leadId }, se_module: "Leads" }] };
    out = await zoho("/crm/v2/Calls", { method: "POST", body: payload });
    row = out?.data?.[0];
    if (row?.code === "SUCCESS") return row.details.id;
  }

  // 4) Unlinked fallback
  const outFinal = await zoho("/crm/v2/Calls", { method: "POST", body: { data: [base] } });
  const rowFinal = outFinal?.data?.[0];
  if (rowFinal?.code === "SUCCESS") return rowFinal.details.id;

  const err = new Error("Call log create failed (Who_Id, What_Id, se_module tried)");
  err.status = 422;
  err.body = { first: out, final: outFinal };
  throw err;
}

/* ---------------- (Optional) Omni outbound call ---------------- */
const OMNI = {
  base: process.env.OMNI_BASE_URL || "https://api.omnidimension.ai",
  startPath: process.env.OMNI_CALLS_START_PATH || "/calls/start",
  apiKey: process.env.OMNIDIM_API_KEY,
  agentId: process.env.OMNIDIM_AGENT_ID,
};

function omniEnabled() {
  return Boolean(OMNI.apiKey && OMNI.agentId);
}

async function startOmniCall({ to, leadId, taskId, name }) {
  if (!omniEnabled()) return null;

  const url = `${OMNI.base}${OMNI.startPath}`;
  const body = {
    agent_id: OMNI.agentId,
    to, // E.164 or your provider’s format
    metadata: { leadId, taskId, name },
  };

  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${OMNI.apiKey}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  if (res.status >= 200 && res.status < 300) return res.data;
  const err = new Error(`Omni call failed ${res.status}`);
  err.status = res.status;
  err.body = res.data;
  throw err;
}

/* ---------------- Routes ---------------- */
app.get("/", (_req, res) => res.send("✅ Omni–Zoho Dispatch Server (India DC) is running!"));

app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

app.post("/api/dispatch-call", async (req, res) => {
  try {
    const { name, phone: rawPhone, product_line } = req.body || {};
    if (!rawPhone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    // Normalize Indian 10-digit as +91XXXXXXXXXX
    let phone = String(rawPhone).trim();
    if (/^\d{10}$/.test(phone)) phone = "+91" + phone;

    const leadId = await findOrCreateLead({ name, phone, product_line });
    const taskId = await createTask(leadId);
    const callId = await createCallLog(leadId, { name, phone });

    // Optional provider call
    try {
      await startOmniCall({ to: phone, leadId, taskId, name });
    } catch (omniErr) {
      console.error("OMNI WARN:", omniErr?.status || "", omniErr?.body || omniErr.message);
      // Do not fail the request if Omni fails; CRM objects are already created
    }

    return res.json({ success: true, leadId, taskId, callId });
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

/* ---- Start server ---- */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server listening on", PORT);
  console.log("Zoho ACCOUNTS:", ACCOUNTS, "APIS:", APIS);
});
