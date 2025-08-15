// ===== Import Dependencies =====
const express = require("express");
const axios = require("axios");
require("dotenv").config();

// ===== Initialize App =====
const app = express();
app.use(express.json());

// ===== Health Check Route =====
app.get("/", (req, res) => {
  res.send("✅ Zoho Dispatch API Server is Running");
});

// ===== Dispatch Call Endpoint =====
app.post("/dispatch", async (req, res) => {
  try {
    const { phone, name, message } = req.body;

    // Validation
    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Zoho OAuth Access Token
    const ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN;
    if (!ZOHO_ACCESS_TOKEN) {
      return res
        .status(500)
        .json({ error: "Zoho Access Token missing in .env" });
    }

    // Zoho API URL
    const zohoUrl = "https://www.zohoapis.in/voice/v1/call";

    // Request Payload (Zoho API Structure)
    const payload = {
      to: phone,
      play: message || `Hello ${name || "User"}, this is a Zoho Dispatch Call.`,
    };

    // API Call to Zoho
    const response = await axios.post(zohoUrl, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // Send back Zoho's response
    res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error("Zoho Dispatch Error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to make dispatch call",
      details: error.response?.data || error.message,
    });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
