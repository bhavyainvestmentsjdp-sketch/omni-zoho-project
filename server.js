// ✅ Omni–Zoho Dispatch Server (India DC)
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE = "https://www.zohoapis.in";
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

// Access Token (via Refresh Token)
async function getAccessToken() {
  const url = `https://accounts.zoho.in/oauth/v2/token`;
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
    console.error("Error fetching Zoho Access Token:", detail);
    throw new Error("Zoho token error");
  }
}

// Zoho API helper
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
    console.error("Zoho API error:", detail);
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail)
    );
  }
}

// Lead find/create
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
  const created = await zoho("/crm/v2/Leads", { method:
