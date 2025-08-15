import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================
// Health Check Route
// =============================
app.get("/", (req, res) => {
  res.send("✅ Omni-Zoho Automation Server is running!");
});

// =============================
// ZOHO API HELPERS
// =============================

// Find existing lead by phone OR create new lead
async function findOrCreateLead(phone) {
  const headers = {
    Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  // Search for lead
  let searchRes = await fetch(
    `${process.env.ZOHO_BASE_URL}/crm/v2/Leads/search?phone=${phone}`,
    { headers }
  );
  let searchData = await searchRes.json();

  if (searchData.data && searchData.data.length > 0) {
    return searchData.data[0].id; // Lead found
  }

  // Create new lead
  let createRes = await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Leads`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        {
          Last_Name: "Incoming Lead",
          Phone: phone,
          Company: "Unknown",
        },
      ],
    }),
  });
  let createData = await createRes.json();
  return createData.data[0].details.id;
}

// Create a task linked to a lead
async function createTask(leadId, subject) {
  const headers = {
    Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        {
          Subject: subject,
          Who_Id: leadId,
          Due_Date: new Date(
            Date.now() +
              (parseInt(process.env.TASK_DUE_HOURS) || 24) *
                60 *
                60 *
                1000
          )
            .toISOString()
            .split("T")[0],
          Status: "Not Started",
        },
      ],
    }),
  });
}

// Create new lead with custom fields
async function createZohoLead(name, phone, productLine) {
  const response = await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Leads`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [
        {
          Last_Name: name || "Incoming Lead",
          Phone: phone,
          Product_Line: productLine || "General Inquiry",
          Lead_Source: "Incoming Call",
        },
      ],
    }),
  });

  const data = await response.json();
  if (data.data && data.data[0].code === "SUCCESS") {
    return data.data[0].details.id;
  } else {
    throw new Error("Failed to create lead");
  }
}

// Create follow-up task
async function createZohoTask(leadId) {
  const dueTime = new Date();
  dueTime.setHours(
    dueTime.getHours() + (parseInt(process.env.TASK_DUE_HOURS) || 2)
  );

  const response = await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Tasks`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: [
        {
          Subject: "Follow up on incoming call",
          Due_Date: dueTime.toISOString().split("T")[0],
          What_Id: leadId,
        },
      ],
    }),
  });

  const data = await response.json();
  if (data.data && data.data[0].code === "SUCCESS") {
    return data.data[0].details.id;
  } else {
    throw new Error("Failed to create task");
  }
}

// =============================
// ROUTES
// =============================

// Incoming Call Webhook (from Omni)
app.post("/incoming-call", async (req, res) => {
  try {
    const phone = req.body.callerNumber;
    if (!phone) {
      return res.status(400).json({ error: "Missing callerNumber" });
    }

    const leadId = await findOrCreateLead(phone);
    await createTask(leadId, "Follow up on incoming call");

    res.json({ success: true, leadId });
  } catch (err) {
    console.error("Error in /incoming-call:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Dispatch Call API
app.post("/api/dispatch-call", async (req, res) => {
  try {
    const { name, phone, product_line } = req.body;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }

    const leadId = await createZohoLead(name, phone, product_line);
    const taskId = await createZohoTask(leadId);

    res.json({
      success: true,
      message: "Lead and follow-up task created successfully",
      leadId,
      taskId,
    });
  } catch (err) {
    console.error("Error in /api/dispatch-call:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================
// START SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
