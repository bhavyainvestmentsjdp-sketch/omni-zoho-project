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

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
