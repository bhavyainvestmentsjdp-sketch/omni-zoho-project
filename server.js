// Simple Zoho Dispatch Server (India DC) with Debug Logs
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE = (process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in').replace(/\/+$/, '');
const DUE_HOURS = Number(process.env.TASK_DUE_HOURS || 24);

async function getAccessToken() {
  const url = `https://accounts.zoho.in/oauth/v2/token`;
  const params = {
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  };
  try {
    console.log("🔑 Fetching Zoho Access Token...");
    const res = await axios.post(url, null, { params });
    if (!res.data.access_token) throw new Error('No access_token in response');
    console.log("✅ Access Token received");
    return res.data.access_token;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ Error fetching Zoho Access Token:', detail);
    throw new Error('Zoho token error');
  }
}

async function zoho(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const url = `${BASE}${path}`;
  try {
    console.log(`📡 Zoho API Request → ${method} ${url}`);
    if (body) console.log("📦 Payload:", JSON.stringify(body, null, 2));

    const res = await axios({
      url, method,
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      data: body ? JSON.stringify(body) : undefined
    });

    console.log("✅ Zoho API Response:", JSON.stringify(res.data, null, 2));
    return res.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ Zoho API error:', detail);
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

async function findOrCreateLead({ name, phone, product_line }) {
  try {
    console.log(`🔍 Searching for lead with phone: ${phone}`);
    const search = await zoho(`/crm/v2/Leads/search?phone=${encodeURIComponent(phone)}`);
    if (search?.data?.length) {
      console.log("✅ Lead found:", search.data[0].id);
      return search.data[0].id;
    }
  } catch (err) {
    console.warn("⚠️ Lead not found, creating new:", err.message);
  }

  const payload = {
    data: [
      {
        Last_Name: name || 'Incoming Lead',
        Phone: phone,
        Company: 'Unknown',
        Lead_Source: 'Incoming Call',
        ...(product_line ? { Product_Line: product_line } : {})
      }
    ]
  };
  console.log("➕ Creating new Lead...");
  const created = await zoho('/crm/v2/Leads', { method: 'POST', body: payload });
  const row = created?.data?.[0];
  if (row?.code === 'SUCCESS') {
    console.log("✅ Lead created:", row.details.id);
    return row.details.id;
  }
  throw new Error('Lead create failed');
}

async function createTask(leadId) {
  const due = new Date();
  due.setHours(due.getHours() + DUE_HOURS);
  const payload = {
    data: [
      {
        Subject: 'Follow up on incoming call',
        Status: 'Not Started',
        Who_Id: leadId,
        Due_Date: due.toISOString().split('T')[0]
      }
    ]
  };
  console.log("📝 Creating task for Lead:", leadId);
  const out = await zoho('/crm/v2/Tasks', { method: 'POST', body: payload });
  const row = out?.data?.[0];
  if (row?.code === 'SUCCESS') {
    console.log("✅ Task created:", row.details.id);
    return row.details.id;
  }
  console.error("❌ Task create response:", out);
  throw new Error('Task create failed');
}

app.get('/', (_req, res) => res.send('✅ Omni–Zoho Dispatch Server (India DC) is running!'));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/dispatch-call', async (req, res) => {
  console.log("📩 Incoming Request:", req.body);
  try {
    const { name, phone, product_line } = req.body || {};
    if (!phone) {
      console.error("❌ Missing phone in request");
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const leadId = await findOrCreateLead({ name, phone, product_line });
    const taskId = await createTask(leadId);
    res.json({ success: true, leadId, taskId });
  } catch (err) {
    console.error("❌ Dispatch error:", err.message, err.stack);
    res.status(500).json({ success: false, message: err.message || 'Internal error' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
