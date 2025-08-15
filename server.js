import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ Omni-Zoho Automation Server is running!"));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ----- Zoho helper (native fetch) -----
async function zoho(path, { method = "GET", body } = {}) {
  const base = (process.env.ZOHO_BASE_URL || "").replace(/\/+$/, "");
  const url = `${base}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Zoho ${res.status}: ${msg}`);
  }
  return data;
}

// ----- Lead: find by phone or create -----
async function findOrCreateLead({ name, phone, product_line }) {
  // Search first
  try {
    const search = await zoho(`/crm/v2/Leads/search?phone=${encodeURIComponent(phone)}`);
    if (search?.data?.length) return search.data[0].id;
  } catch {
    // 204/400 etc – ignore and create new
  }

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

// ----- Task create -----
async function createTask(leadId) {
  const due = new Date();
  const hours = Number(process.env.TASK_DUE_HOURS || 24);
  due.setHours(due.getHours() + hours);

  const payload = {
    data: [
      {
        Subject: "Follow up on incoming call",
        Who_Id: leadId,
        Status: "Not Started",
        Due_Date: due.toISOString().split("T")[0],
      },
    ],
  };

  const out = await zoho("/crm/v2/Tasks", { method: "POST", body: payload });
  const row = out?.data?.[0];
  if (row?.code === "SUCCESS") return row.details.id;

  throw new Error(`Task create failed: ${JSON.stringify(out)}`);
}

// ----- Dispatch endpoint -----
app.post("/api/dispatch-call", async (req, res) => {
  try {
    const { name, phone, product_line } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

    const leadId = await findOrCreateLead({ name, phone, product_line });
    const taskId = await createTask(leadId);

    res.json({ success: true, leadId, taskId });
  } catch (err) {
    console.error("Dispatch error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
