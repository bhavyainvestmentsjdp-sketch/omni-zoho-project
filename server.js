// ✅ Omni–Zoho Dispatch Server (India DC)
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// ---- Zoho DC endpoints (.in) ----
const ACCOUNTS = "https://accounts.zoho.in";       // OAuth
const APIS = "https://www.zohoapis.in";            // CRM APIs
const BASE = APIS;                                 // for consistency

// ---- Token cache (avoid refreshing on every call) ----
let TOKEN_CACHE = { token: null, expiry: 0 }; // expiry = epoch ms

function tokenIsValid() {
  return TOKEN_CACHE.token && Date.now() < TOKEN_CACHE.expiry - 60_000; // 60s skew
}

// 🔑 Access Token (via Refresh Token) — form-urlencoded
async function fetchAccessTokenViaRefresh() {
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

  if (res.status !== 200) {
    throw new Error(`Refresh failed ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const { access_token, expires_in } = res.data || {};
  if (!access_token) throw new Error(`No access_token in response: ${JSON.stringify(res.data)}`);

  // cache with expiry
  TOKEN_CACHE.token = access_token;
  TOKEN_CACHE.expiry = Date.now() + (Number(expires_in || 3600) * 1000);
  return TOKEN_CACHE.token;
}

async function getAccessToken(force = false) {
  if (!force && tokenIsValid()) return TOKEN_CACHE.token;
  return fetchAccessTokenViaRefresh();
}

// 🔗 Zoho API helper (auto-refresh on 401/INVALID_TOKEN)
async function zoho(path, { method = "GET", body } = {}) {
  const url = `${BASE}${path}`;
  let token = await getAccessToken();

  const call = () =>
    axios({
      url,
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`, // Bearer नहीं
        "Content-Type": "application/json",
      },
      data: body ? JSON.stringify(body) : undefined,
      validateStatus: () => true, // handle errors ourselves
    });

  // 1st attempt
  let res = await call();

  // Token invalid/expired → refresh once & retry
  const invalidToken =
    res.status === 401 ||
    (res.data && (res.data.code === "INVALID_TOKEN" || res.data.message === "INVALID_TOKEN"));

  if (invalidToken) {
    try {
      token = await getAccessToken(true); // force refresh
      res = await call();
    } catch (e) {
      // fall through to error handling below
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const err = new Error(`Zoho CRM ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = res.data;
    throw err;
  }

  return res.data;
}

// 🔎 Lead find/create
async function findOrCreateLead({ name, phone, product_line }) {
  // Try search by phone
  try {
    const search = await zoho(`/crm/v2/Leads/search?phone=${encodeURIComponent(phone)}`);
    if (search?.data?.length) return search.data[0].id;
  } catch (_) {
    // ignore not-found / 204 etc and proceed to create
  }

  // Create lead
  const payload = {
    data: [
      {
        Last_Name: name || "Incoming Lead",
        Phone: phone,
        Company: "Unknown",
        Lead_Source: "Incoming Call",
        ...(product_line ? { Product_Line: product_line } : {}),
      },
    ],
  };

  const created = await zoho("/crm/v2/Leads", { method: "POST", body: payload });
  const row = created?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;
  throw new Error(`Lead create failed: ${JSON.stringify(created)}`);
}

// 📌 Task create (Due_Date = YYYY-MM-DD)
async function createTask(leadId) {
  const due = new Date();
  due.setHours(due.getHours() + DUE_HOURS);
  const payload = {
    data: [
      {
        Subject: "Follow up on incoming call",
        Status: "Not Started",
        Who_Id: leadId, // Lead/Contact lookup
        Due_Date: due.toISOString().split("T")[0],
      },
    ],
  };

  const out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  const row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;
  throw new Error(`Task create failed: ${JSON.stringify(out)}`);
}

// 🌐 Routes
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
    res.json({ success: true, leadId, taskId });
  } catch (err) {
    const status = err.status || err.response?.status || 500;
    res.status(status).json({
      success: false,
      message: err.message || "Internal error",
      // detail: err.body || err.response?.data, // uncomment if you want more debug info
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
