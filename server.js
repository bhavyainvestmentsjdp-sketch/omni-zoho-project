import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let accessToken = null;
let tokenExpiry = 0; // epoch ms

// Fetch a fresh access token using refresh token
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiry - 60_000) {
    return accessToken; // reuse until 60s before expiry
  }

  const tokenUrl = `https://accounts.zoho.${process.env.ZOHO_DOMAIN || "in"}/oauth/v2/token`;
  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token"
  });

  const res = await fetch(tokenUrl, { method: "POST", body });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new Error(`Failed to get access token: ${res.status} ${JSON.stringify(data)}`);
  }

  accessToken = data.access_token;
  // Zoho tokens generally valid ~1 hour. Set expiry conservatively to 55 minutes.
  tokenExpiry = now + 55 * 60 * 1000;
  return accessToken;
}

// Minimal Zoho API wrapper
async function zoho(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const base = (process.env.ZOHO_BASE_URL || "https://www.zohoapis.in").replace(/\/+$/, "");
  const url = `${base}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Zoho ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Search lead by phone or create
async function findOrCreateLead({ name, phone, product_line }) {
  // Try search
  try {
    const search = await zoho(`/crm/v2/Leads/search?phone=${encodeURIComponent(phone)}`);
    if (search?.data?.length) return search.data[0].id;
  } catch (e) {
    // ignore search failures (204, 400 etc.) and create fresh
  }

  const payload = {
    data: [{
      Last_Name: name || "Incoming Lead",
      Phone: phone,
      Company: "Unknown",
      Lead_Source: "Incoming Call",
      ...(product_line ? { Product_Line: product_line } : {})
    }]
  };

  const created = await zoho("/crm/v2/Leads", { method: "POST", body: payload });
  const row = created?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  throw new Error(`Lead create failed: ${JSON.stringify(created)}`);
}

// Create follow-up Task linked to the Lead
async function createTask(leadId) {
  const due = new Date();
  const hours = Number(process.env.TASK_DUE_HOURS || 24);
  due.setHours(due.getHours() + hours);

  const payload = {
    data: [{
      Subject: "Follow up on incoming call",
      Who_Id: leadId,
      Status: "Not Started",
      Due_Date: due.toISOString().split("T")[0]
    }]
  };

  const out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  const row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  throw new Error(`Task create failed: ${JSON.stringify(out)}`);
}

// Health checks
app.get("/", (req, res) => res.send("✅ Omni-Zoho Dispatch Server is running!"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Main endpoint: creates/updates lead and adds follow-up task
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
    console.error("Dispatch error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
