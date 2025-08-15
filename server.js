import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Omni-Zoho Automation Server is running!");
});

// Function to create or find lead in Zoho
async function findOrCreateLead(phone) {
  const headers = {
    Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };

  // Search for existing lead
  let searchRes = await fetch(
    `${process.env.ZOHO_BASE_URL}/crm/v2/Leads/search?phone=${phone}`,
    { headers }
  );
  let searchData = await searchRes.json();

  if (searchData.data && searchData.data.length > 0) {
    return searchData.data[0].id;
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
          Company: "Unknown"
        }
      ]
    })
  });
  let createData = await createRes.json();
  return createData.data[0].details.id;
}

// Function to create a task in Zoho
async function createTask(leadId, subject) {
  const headers = {
    Authorization: `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
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
            Date.now() + (process.env.TASK_DUE_HOURS || 24) * 60 * 60 * 1000
          )
            .toISOString()
            .split("T")[0],
          Status: "Not Started"
        }
      ]
    })
  });
}

// Webhook from OmniDimension
app.post("/incoming-call", async (req, res) => {
  try {
    const phone = req.body.callerNumber;
    if (!phone) return res.status(400).send({ error: "Missing callerNumber" });

    const leadId = await findOrCreateLead(phone);
    await createTask(leadId, "Follow up on incoming call");

    res.send({ success: true, leadId });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send({ error: "Internal Server Error" });
  }
});
// =============================
// Dispatch Call API
// =============================

// Helper: Create Lead in Zoho CRM
async function createZohoLead(name, phone, productLine) {
    try {
        const response = await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Leads`, {
            method: "POST",
            headers: {
                "Authorization": `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                data: [{
                    Last_Name: name || "Incoming Lead",
                    Phone: phone,
                    Product_Line: productLine || "General Inquiry",
                    Lead_Source: "Incoming Call"
                }]
            })
        });

        const data = await response.json();
        if (data.data && data.data[0].code === "SUCCESS") {
            return data.data[0].details.id; // Lead ID
        } else {
            console.error("Zoho Lead creation failed:", data);
            throw new Error("Failed to create lead");
        }
    } catch (err) {
        console.error("Error in createZohoLead:", err);
        throw err;
    }
}

// Helper: Create Follow-up Task
async function createZohoTask(leadId) {
    try {
        const dueTime = new Date();
        dueTime.setHours(dueTime.getHours() + (parseInt(process.env.TASK_DUE_HOURS) || 2));

        const response = await fetch(`${process.env.ZOHO_BASE_URL}/crm/v2/Tasks`, {
            method: "POST",
            headers: {
                "Authorization": `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                data: [{
                    Subject: "Follow up on incoming call",
                    Due_Date: dueTime.toISOString().split("T")[0],
                    What_Id: leadId // link to lead
                }]
            })
        });

        const data = await response.json();
        if (data.data && data.data[0].code === "SUCCESS") {
            return data.data[0].details.id; // Task ID
        } else {
            console.error("Zoho Task creation failed:", data);
            throw new Error("Failed to create task");
        }
    } catch (err) {
        console.error("Error in createZohoTask:", err);
        throw err;
    }
}

// Route: Dispatch Call
app.post("/api/dispatch-call", async (req, res) => {
    const { name, phone, product_line } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    try {
        // 1. Create lead
        const leadId = await createZohoLead(name, phone, product_line);

        // 2. Create follow-up task
        const taskId = await createZohoTask(leadId);

        res.json({
            success: true,
            message: "Lead and follow-up task created successfully",
            leadId,
            taskId
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
