# Zoho Dispatch Server (India DC)

Minimal Express server that:
- Accepts POST **/api/dispatch-call** with `{ name, phone, product_line }`
- Finds/creates a Lead in Zoho CRM
- Creates a follow-up Task linked to that Lead
- Uses **refresh token** to auto-generate access tokens (no manual updates needed)

## 1) Local run (optional)
```bash
npm install
cp .env.example .env   # fill your values
npm start
```
Visit: http://localhost:3000/health

## 2) Deploy on Render
- Push this folder to a **new GitHub repo**.
- Render → New → Web Service → Connect repo
- **Build command**: (leave empty)
- **Start command**: `npm start`
- **Environment**: Node
- Add following Environment Variables (from your Zoho console):
  - `ZOHO_CLIENT_ID`
  - `ZOHO_CLIENT_SECRET`
  - `ZOHO_REFRESH_TOKEN`
  - `ZOHO_BASE_URL` = `https://www.zohoapis.in`
  - `ZOHO_DOMAIN` = `in`
  - `TASK_DUE_HOURS` = `24` (optional)
  - `PORT` = `3000` (Render sets automatically; keep for local)

## 3) Test with Postman / curl
```
POST https://<your-service>.onrender.com/api/dispatch-call
Content-Type: application/json

{
  "name": "Test User",
  "phone": "+919876543210",
  "product_line": "life_insurance"
}
```

**Success response**
```json
{
  "success": true,
  "leadId": "xxxxxxxxxxxx",
  "taskId": "yyyyyyyyyyyy"
}
```

If you get 401/invalid token, re-check `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, and domain `.in` settings.
