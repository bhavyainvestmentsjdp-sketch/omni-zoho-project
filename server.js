process.on("unhandledRejection", (r) => console.error("UNHANDLED_REJECTION", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));

// ✅ Omni–Zoho Dispatch Server (India DC)
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// ---- Endpoints (env override supported) ----
const ACCOUNTS = (() => {
  const v = process.env.ZOHO_ACCESS_TOKEN_URL;
  if (v) {
    try { return new URL(v).origin; } catch { return String(v).replace(/\/oauth\/v2\/token.*$/,''); }
  }
  return "https://accounts.zoho.in";
})();

const APIS = (() => {
  const v = process.env.ZOHO_BASE_URL;
  if (v) {
    try { return new URL(v).origin; } catch { return String(v); }
  }
  return "https://www.zohoapis.in";
})();

// ---- Token cache ----
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

// ---- Generic Zoho caller (auto-refresh on 401/INVALID_TOKEN) ----
async function zoho(path, { method = "GET", body } = {}) {
  let token = await getAccessToken();
  const url = `${APIS}${path}`;

  const call = () => axios({
    url,
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`, // NOTE: not "Bearer"
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

// ---- Lead find/create ----
async function findOrCreateLead({ name, phone, product_line }) {
  let leadId = null;

  // Search by criteria (more reliable than phone param)
  try {
    const search = await zoho(
      `/crm/v2/Leads/search?criteria=(Phone:equals:${encodeURIComponent(phone)})`
    );
    if (search?.data?.length) leadId = search.data[0].id;
  } catch (_) {
    // 204/NOT_FOUND etc → ignore and create
  }
  if (leadId) return leadId;

  // Allow custom API name for product field via env
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

// ---- Task create (try Who_Id, fallback to What_Id) ----
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

  // 1) Try Who_Id (Lead/Contact)
  let payload = { data: [ { ...base, Who_Id: { id: leadId } } ] };
  let out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  let row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  const whoErr = Array.isArray(out?.data) && out.data.some(
    d => d?.details?.api_name === "Who_Id" || d?.message?.includes?.("Who")
  );

  // 2) If Who_Id rejected, try What_Id (some orgs disallow Leads on Who_Id)
  if (whoErr) {
    payload = { data: [ { ...base, What_Id: { id: leadId } } ] };
    const out2 = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
    const row2 = out2?.data?.[0];
    if (row2?.code === "SUCCESS") return row2.details.id;

    const err2 = new Error("Task create failed (Who_Id & What_Id both rejected)");
    err2.status = 422;
    err2.body = { first: out, second: out2 };
    throw err2;
  }

  const err = new Error("Task create failed");
  err.status = 422;
  err.body = out;
  throw err;
}

// ---- Routes ----
app.get("/", (_req, res) =>
  res.send("✅ Omni–Zoho Dispatch Server (India DC) is running!")
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

app.post("/api/dispatch-call", async (req, res) => {
  try {
    const { name, phone, product_line } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, message: "phone is required" });
    }

    const leadId = await findOrCreateLead({ name, phone, product_line });
    const taskId = await createTask(leadId);

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

// 🔊 Bind to 0.0.0.0 and log on boot (helps avoid 502)
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server listening on", PORT);
  console.log("Zoho ACCOUNTS:", ACCOUNTS, "APIS:", APIS);
});
