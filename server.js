// ✅ Omni–Zoho Dispatch Server (India DC)
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE = "https://www.zohoapis.in"; // CRM APIs के लिए
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// 🔑 Access Token (via Refresh Token)
async function getAccessToken() {
  const url = `https://accounts.zoho.in/oauth/v2/token`; // ✅ FIXED
  const params = {
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  };
  try {
    const res = await axios.post(url, null, { params });
    if (!res.data.access_token) throw new Error("No access_token in response");
    return res.data.access_token;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Error fetching Zoho Access Token:", detail);
    throw new Error("Zoho token error");
  }
}

// 🔗 Zoho API helper
async function zoho(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const url = `${BASE}${path}`;
  try {
    const res = await axios({
      url,
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      data: body ? JSON.stringify(body) : undefined,
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("❌ Zoho API error:", detail);
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail)
    );
  }
}

// 🔎 Lead find/create
async function findOrCreateLead({ name, phone, product_line }) {
  try {
    const search = await zoho(
      `/crm/v2/Leads/search?phone=${encodeURIComponent(phone)}`
    );
    if (search?.data?.length) return search.data[0].id;
  } catch (_) {}
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
  throw new Error("Lead create failed");
}

// 📌 Task create
async function createTask(leadId) {
  const due = new Date();
  due.setHours(due.getHours() + DUE_HOURS);
  const payload = {
    data: [
      {
        Subject: "Follow up on incoming call",
        Status: "Not Started",
        Who_Id: leadId,
        Due_Date: due.toISOString().split("T")[0],
      },
    ],
  };
  const out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  const row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;
  throw new Error("Task create failed");
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
    if (!phone)
      return res
        .status(400)
        .json({ success: false, message: "phone is required" });
    const leadId = await findOrCreateLead({ name, phone, product_line });
    const taskId = await createTask(leadId);
    res.json({ success: true, leadId, taskId });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || "Internal error" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
