/**
 * ============================================================
 *  UNIVERSAL PAYMENT GATEWAY — Cloudflare Worker  v3
 * ============================================================
 *  KV Keys:
 *    admin:password          – SHA-256 hashed password
 *    config:brand            – JSON brand settings
 *    config:bkash            – JSON bKash settings
 *    sessions:<token>        – admin session (TTL 86400s)
 *    product:<id>            – JSON product
 *    products:index          – JSON [] of product IDs
 *    sms:<id>                – JSON raw SMS record (source of truth)
 *    sms:index               – JSON [] of SMS IDs (newest last)
 *    txn:<trxId>             – JSON transaction (only created via SMS forward)
 *    txn:used:<trxId>        – "1" when consumed
 *    txn:index               – JSON [] of trxIds
 * ============================================================
 */

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function nanoid(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

async function requireAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/pg_session=([^;]+)/);
  if (!match) return null;
  return await env.PG_KV.get(`sessions:${match[1]}`) ? match[1] : null;
}

function redirect(url) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function setCookieRedirect(url, name, value, maxAge = 86400) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    },
  });
}

function clearCookieRedirect(url, name) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

async function getConfig(env) {
  const [brandRaw, bkashRaw] = await Promise.all([
    env.PG_KV.get("config:brand"),
    env.PG_KV.get("config:bkash"),
  ]);
  const brand = brandRaw
    ? JSON.parse(brandRaw)
    : { name: "PayGate", logo: "", primaryColor: "#E2136E", tagline: "Fast & Secure Payments" };
  const bkash = bkashRaw
    ? JSON.parse(bkashRaw)
    : { phone: "", vat: 0, enabled: false };
  return { brand, bkash };
}

async function appendToIndex(env, key, id) {
  const raw = await env.PG_KV.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  if (!arr.includes(id)) arr.push(id);
  await env.PG_KV.put(key, JSON.stringify(arr));
}

async function removeFromIndex(env, key, id) {
  const raw = await env.PG_KV.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  await env.PG_KV.put(key, JSON.stringify(arr.filter(x => x !== id)));
}

// ─── SMS Parser ───────────────────────────────────────────────────────────────
// Handles bKash SMS formats:
//   "You have received Tk 500.00 from 01XXXXXXXXX. TrxID A1B2C3D4E5. Balance..."
//   "You have received Tk 30.00 from 01XXXXXXXXX. Fee Tk 0.00. Balance Tk 1,294.36. TrxID DDS3M42DR5 at 28/04/2026 21:23"
//   "Tk 500.00 has been sent from 01XXXXXXXXX. TrxID A1B2C3D4E5..."

function parseBkashSms(text) {
  // TrxID — must have: one or more uppercase letters+digits, at least 6 chars
  const trxMatch = text.match(/TrxID\s+([A-Z0-9]{6,})/i);

  // Amount — first "Tk X" (received amount, before Fee)
  const amtMatch = text.match(/Tk\s+([\d,]+\.?\d*)/i);

  // Sender phone — 11-digit BD number after "from"
  const fromMatch = text.match(/from\s+(01[0-9]{9})/i);

  if (!trxMatch) return null;

  return {
    trxId:       trxMatch[1].toUpperCase(),
    amount:      amtMatch ? parseFloat(amtMatch[1].replace(/,/g, "")) : null,
    senderPhone: fromMatch ? fromMatch[1] : null,
  };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function baseStyle(primary = "#E2136E") {
  return `
<style>
@import url('https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{--primary:${primary};--bg:#0f0f0f;--card:#1a1a1a;--border:#2a2a2a;--text:#f0f0f0;--muted:#888;--success:#22c55e;--danger:#ef4444;--warning:#f59e0b}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--primary);text-decoration:none}a:hover{text-decoration:underline}
input,select,textarea{background:#111;border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;width:100%;font-size:14px;font-family:inherit;outline:none;transition:border .2s}
input:focus,select:focus,textarea:focus{border-color:var(--primary)}
button{cursor:pointer;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;transition:all .2s;font-family:inherit}
.btn-primary{background:var(--primary);color:#fff}.btn-primary:hover{opacity:.85}
.btn-secondary{background:var(--border);color:var(--text)}.btn-secondary:hover{background:#333}
.btn-danger{background:var(--danger);color:#fff}
.btn-success{background:var(--success);color:#fff}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
.alert{padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:16px}
.alert-error{background:#2d1212;border:1px solid var(--danger);color:#fca5a5}
.alert-success{background:#0f2d1a;border:1px solid var(--success);color:#86efac}
.alert-info{background:#0f1e2d;border:1px solid #3b82f6;color:#93c5fd}
.alert-warning{background:#2d1e0a;border:1px solid var(--warning);color:#fde68a}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:500}
.field{margin-bottom:16px}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.badge-success{background:#0f2d1a;color:var(--success)}.badge-danger{background:#2d1212;color:var(--danger)}.badge-warning{background:#2d1e0a;color:var(--warning)}.badge-info{background:#0f1e2d;color:#93c5fd}.badge-manual{background:#1a1030;color:#c4b5fd}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
.copy-btn{background:transparent;border:1px solid var(--border);color:var(--muted);padding:4px 10px;font-size:12px;border-radius:6px;cursor:pointer}
.copy-btn:hover{border-color:var(--primary);color:var(--primary)}
code{background:#111;padding:2px 6px;border-radius:4px;font-size:13px;font-family:monospace;color:#f0f0f0;word-break:break-all}
</style>`;
}

function adminNav(active = "", brand = { primaryColor: "#E2136E" }) {
  const p = brand.primaryColor || "#E2136E";
  const links = [
    { href:"/admin",             label:"Dashboard",     key:"dashboard"    },
    { href:"/admin/brand",       label:"Brand",         key:"brand"        },
    { href:"/admin/bkash",       label:"bKash Config",  key:"bkash"        },
    { href:"/admin/products",    label:"Payment Links", key:"products"     },
    { href:"/admin/sms",         label:"SMS Log",       key:"sms"          },
    { href:"/admin/transactions",label:"Transactions",  key:"transactions" },
    { href:"/admin/api-docs",    label:"API Docs",      key:"api"          },
  ];
  return `
<nav style="background:#111;border-bottom:1px solid #222;padding:0 20px;display:flex;align-items:center;gap:4px;overflow-x:auto;white-space:nowrap">
  <span style="font-weight:700;font-size:15px;color:${p};padding:14px 0;margin-right:12px;flex-shrink:0">⚡ PayGate</span>
  ${links.map(l=>`<a href="${l.href}" style="padding:14px 10px;font-size:13px;font-weight:500;border-bottom:2px solid ${active===l.key?p:"transparent"};color:${active===l.key?"var(--text)":"var(--muted)"}">${l.label}</a>`).join("")}
  <a href="/admin/logout" style="margin-left:auto;padding:14px 10px;font-size:13px;color:var(--muted);flex-shrink:0">Logout</a>
</nav>`;
}

// ─── Admin Pages ──────────────────────────────────────────────────────────────

function loginPage(error = "") {
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title>${baseStyle()}</head><body>
<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
  <div class="card" style="width:100%;max-width:380px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:36px;margin-bottom:8px">⚡</div>
      <h1 style="font-size:22px;font-weight:700">Admin Panel</h1>
      <p style="color:var(--muted);font-size:13px;margin-top:4px">Universal Payment Gateway</p>
    </div>
    ${error?`<div class="alert alert-error">${error}</div>`:""}
    <form method="POST" action="/admin/login">
      <div class="field"><label>Password</label><input type="password" name="password" placeholder="Enter admin password" required autofocus></div>
      <button type="submit" class="btn-primary" style="width:100%;padding:12px">Login →</button>
    </form>
    <p style="margin-top:16px;font-size:12px;color:var(--muted);text-align:center">First time? <code>/setup?secret=SECRET&password=PASS</code></p>
  </div>
</div></body></html>`);
}

async function dashboardPage(env) {
  const { brand, bkash } = await getConfig(env);
  const [productsRaw, txnRaw, smsRaw] = await Promise.all([
    env.PG_KV.get("products:index"),
    env.PG_KV.get("txn:index"),
    env.PG_KV.get("sms:index"),
  ]);
  const productCount = productsRaw ? JSON.parse(productsRaw).length : 0;
  const txnCount     = txnRaw     ? JSON.parse(txnRaw).length     : 0;
  const smsCount     = smsRaw     ? JSON.parse(smsRaw).length     : 0;
  const p = brand.primaryColor || "#E2136E";
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard — ${brand.name}</title>${baseStyle(p)}</head><body>
${adminNav("dashboard", brand)}
<div style="max-width:1100px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:24px">Dashboard</h1>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px">
    <div class="card" style="text-align:center"><div style="font-size:32px;font-weight:700;color:${p}">${productCount}</div><div style="color:var(--muted);font-size:13px;margin-top:4px">Payment Links</div></div>
    <div class="card" style="text-align:center"><div style="font-size:32px;font-weight:700;color:var(--warning)">${smsCount}</div><div style="color:var(--muted);font-size:13px;margin-top:4px">Forwarded SMS</div></div>
    <div class="card" style="text-align:center"><div style="font-size:32px;font-weight:700;color:var(--success)">${txnCount}</div><div style="color:var(--muted);font-size:13px;margin-top:4px">Transactions</div></div>
    <div class="card" style="text-align:center"><div style="font-size:${bkash.enabled?"20":"28"}px;font-weight:700;color:${bkash.enabled?"var(--success)":"var(--danger)"}">${bkash.enabled?"Active":"Off"}</div><div style="color:var(--muted);font-size:13px;margin-top:4px">bKash Gateway</div></div>
  </div>
  <div class="card" style="margin-bottom:24px">
    <h2 style="font-size:16px;font-weight:600;margin-bottom:12px">Quick Actions</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <a href="/admin/products/new"><button class="btn-primary">+ New Payment Link</button></a>
      <a href="/admin/sms"><button class="btn-secondary">📱 SMS Log</button></a>
      <a href="/admin/sms/manual"><button class="btn-secondary">✏️ Manual SMS Entry</button></a>
      <a href="/admin/brand"><button class="btn-secondary">Edit Brand</button></a>
      <a href="/admin/bkash"><button class="btn-secondary">Configure bKash</button></a>
      <a href="/admin/api-docs"><button class="btn-secondary">API Docs</button></a>
    </div>
  </div>
  <div class="card">
    <h2 style="font-size:16px;font-weight:600;margin-bottom:12px">Gateway Status</h2>
    <table>
      <tr><th>Setting</th><th>Value</th></tr>
      <tr><td>Brand Name</td><td>${brand.name}</td></tr>
      <tr><td>bKash Phone</td><td>${bkash.phone||"Not configured"}</td></tr>
      <tr><td>bKash VAT</td><td>${bkash.vat||0}%</td></tr>
      <tr><td>bKash Status</td><td><span class="badge ${bkash.enabled?"badge-success":"badge-danger"}">${bkash.enabled?"Enabled":"Disabled"}</span></td></tr>
    </table>
  </div>
</div></body></html>`);
}

async function brandPage(env, msg="", error="") {
  const { brand } = await getConfig(env);
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brand</title>${baseStyle(brand.primaryColor)}</head><body>
${adminNav("brand",brand)}
<div style="max-width:600px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:24px">Brand Settings</h1>
  ${msg?`<div class="alert alert-success">${msg}</div>`:""}${error?`<div class="alert alert-error">${error}</div>`:""}
  <div class="card">
    <form method="POST" action="/admin/brand">
      <div class="field"><label>Brand Name</label><input name="name" value="${brand.name}" required></div>
      <div class="field"><label>Tagline</label><input name="tagline" value="${brand.tagline||""}"></div>
      <div class="field"><label>Logo URL</label><input name="logo" value="${brand.logo||""}"></div>
      <div class="field"><label>Primary Color</label><input type="color" name="primaryColor" value="${brand.primaryColor||"#E2136E"}" style="height:42px;padding:4px 8px"></div>
      <button type="submit" class="btn-primary" style="width:100%;padding:12px">Save</button>
    </form>
  </div>
</div></body></html>`);
}

async function bkashPage(env, msg="", error="") {
  const { brand, bkash } = await getConfig(env);
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bKash Config</title>${baseStyle(brand.primaryColor)}</head><body>
${adminNav("bkash",brand)}
<div style="max-width:600px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:24px">bKash Gateway Configuration</h1>
  ${msg?`<div class="alert alert-success">${msg}</div>`:""}${error?`<div class="alert alert-error">${error}</div>`:""}
  <div class="card">
    <form method="POST" action="/admin/bkash">
      <div class="field"><label>bKash Number</label><input name="phone" value="${bkash.phone||""}" placeholder="01XXXXXXXXX" required></div>
      <div class="field"><label>Account Type</label>
        <select name="accountType">
          <option value="Personal" ${(bkash.accountType||"Personal")==="Personal"?"selected":""}>Personal</option>
          <option value="Merchant" ${bkash.accountType==="Merchant"?"selected":""}>Merchant</option>
          <option value="Agent"    ${bkash.accountType==="Agent"?"selected":""}>Agent</option>
        </select>
      </div>
      <div class="field"><label>VAT / Service Charge (%)</label><input type="number" name="vat" value="${bkash.vat||0}" min="0" max="100" step="0.01"></div>
      <div class="field"><label>Payment Instructions</label><textarea name="instructions" rows="3">${bkash.instructions||""}</textarea></div>
      <div class="field" style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" name="enabled" id="en" style="width:18px;height:18px" ${bkash.enabled?"checked":""}>
        <label for="en" style="margin:0;color:var(--text)">Enable bKash Gateway</label>
      </div>
      <button type="submit" class="btn-primary" style="width:100%;padding:12px;margin-top:8px">Save</button>
    </form>
  </div>
</div></body></html>`);
}

async function productsPage(env, msg="") {
  const { brand } = await getConfig(env);
  const ids = JSON.parse(await env.PG_KV.get("products:index") || "[]");
  const products = (await Promise.all(ids.map(id=>env.PG_KV.get(`product:${id}`)))).map(r=>r?JSON.parse(r):null).filter(Boolean);
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Links</title>${baseStyle(brand.primaryColor)}
<script>function copyLink(url){navigator.clipboard.writeText(url);event.target.textContent='Copied!';setTimeout(()=>event.target.textContent='Copy',2000)}</script>
</head><body>
${adminNav("products",brand)}
<div style="max-width:1100px;margin:0 auto;padding:32px 24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <h1 style="font-size:22px;font-weight:700">Payment Links</h1>
    <a href="/admin/products/new"><button class="btn-primary">+ New</button></a>
  </div>
  ${msg?`<div class="alert alert-success">${msg}</div>`:""}
  ${products.length===0?`<div class="card" style="text-align:center;padding:48px;color:var(--muted)">No payment links yet.</div>`:`
  <div class="card" style="overflow-x:auto"><table>
    <tr><th>Name</th><th>Price</th><th>Type</th><th>Status</th><th>Link</th><th>Actions</th></tr>
    ${products.map(p=>`<tr>
      <td><strong>${p.name}</strong>${p.description?`<br><span style="color:var(--muted);font-size:12px">${p.description}</span>`:""}</td>
      <td>${p.fixedPrice?`<strong>৳${p.price}</strong>`:`<span style="color:var(--warning)">Open</span>`}</td>
      <td><span class="badge ${p.fixedPrice?"badge-success":"badge-warning"}">${p.fixedPrice?"Fixed":"Open"}</span></td>
      <td><span class="badge ${p.active?"badge-success":"badge-danger"}">${p.active?"Active":"Off"}</span></td>
      <td><code style="font-size:11px">/pay/${p.id}</code> <button class="copy-btn" onclick="copyLink(window.location.origin+'/pay/${p.id}')">Copy</button></td>
      <td style="white-space:nowrap">
        <a href="/admin/products/${p.id}/edit"><button class="btn-secondary" style="padding:6px 12px;font-size:12px">Edit</button></a>
        <form method="POST" action="/admin/products/${p.id}/delete" style="display:inline;margin-left:6px" onsubmit="return confirm('Delete?')">
          <button type="submit" class="btn-danger" style="padding:6px 12px;font-size:12px">Delete</button>
        </form>
      </td>
    </tr>`).join("")}
  </table></div>`}
</div></body></html>`);
}

async function productFormPage(env, product=null, error="") {
  const { brand } = await getConfig(env);
  const isEdit = !!product;
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${isEdit?"Edit":"New"} Payment Link</title>${baseStyle(brand.primaryColor)}
<script>function togglePrice(){document.getElementById('priceField').style.display=document.getElementById('fp').checked?'block':'none'}</script>
</head><body>
${adminNav("products",brand)}
<div style="max-width:600px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:24px">${isEdit?"Edit":"New"} Payment Link</h1>
  ${error?`<div class="alert alert-error">${error}</div>`:""}
  <div class="card">
    <form method="POST" action="${isEdit?`/admin/products/${product.id}/edit`:"/admin/products/new"}">
      <div class="field"><label>Name</label><input name="name" value="${product?.name||""}" required></div>
      <div class="field"><label>Description</label><textarea name="description" rows="2">${product?.description||""}</textarea></div>
      <div class="field" style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" name="fixedPrice" id="fp" style="width:18px;height:18px" ${!product||product.fixedPrice?"checked":""} onchange="togglePrice()">
        <label for="fp" style="margin:0;color:var(--text)">Fixed Price</label>
      </div>
      <div class="field" id="priceField" style="display:${!product||product.fixedPrice?"block":"none"}">
        <label>Price (BDT)</label><input type="number" name="price" value="${product?.price||""}" min="1" step="0.01">
      </div>
      <div class="field"><label>Success Redirect URL</label><input name="successUrl" value="${product?.successUrl||""}"></div>
      <div class="field"><label>Webhook URL</label><input name="webhookUrl" value="${product?.webhookUrl||""}"></div>
      <div class="field" style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" name="active" id="active" style="width:18px;height:18px" ${!product||product.active?"checked":""}>
        <label for="active" style="margin:0;color:var(--text)">Active</label>
      </div>
      <div style="display:flex;gap:12px;margin-top:8px">
        <button type="submit" class="btn-primary" style="flex:1;padding:12px">${isEdit?"Save":"Create"}</button>
        <a href="/admin/products"><button type="button" class="btn-secondary" style="padding:12px 20px">Cancel</button></a>
      </div>
    </form>
  </div>
</div>
<script>togglePrice()</script></body></html>`);
}

// ─── SMS Log Page ─────────────────────────────────────────────────────────────

async function smsLogPage(env, page=1) {
  const { brand } = await getConfig(env);
  const allIds = JSON.parse(await env.PG_KV.get("sms:index") || "[]");
  const PAGE  = 30;
  const pageIds = allIds.slice().reverse().slice((page-1)*PAGE, page*PAGE);
  const smsList = (await Promise.all(pageIds.map(id=>env.PG_KV.get(`sms:${id}`)))).map(r=>r?JSON.parse(r):null).filter(Boolean);
  const totalPages = Math.ceil(allIds.length / PAGE);
  const p = brand.primaryColor || "#E2136E";

  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS Log</title>${baseStyle(p)}</head><body>
${adminNav("sms", brand)}
<div style="max-width:1100px;margin:0 auto;padding:32px 24px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
    <h1 style="font-size:22px;font-weight:700">Forwarded SMS Log <span style="color:var(--muted);font-size:16px">(${allIds.length} total)</span></h1>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a href="/admin/sms/manual"><button class="btn-success" style="padding:8px 16px;font-size:13px">✏️ Manual Entry</button></a>
      <a href="/admin/sms/clear" onclick="return confirm('All SMS logs delete হবে। sure?')"><button class="btn-danger" style="padding:8px 16px;font-size:13px">Clear All</button></a>
    </div>
  </div>

  ${smsList.length===0?`
  <div class="card" style="text-align:center;padding:48px">
    <div style="font-size:48px;margin-bottom:16px">📱</div>
    <h2 style="font-size:18px;margin-bottom:8px">কোনো SMS আসেনি</h2>
    <p style="color:var(--muted);font-size:14px">Android app থেকে SMS forward হলে অথবা manually entry করলে এখানে দেখা যাবে।</p>
    <div style="margin-top:20px">
      <a href="/admin/sms/manual"><button class="btn-success" style="padding:10px 24px">✏️ Manual SMS Entry করুন</button></a>
    </div>
    <div style="margin-top:20px;background:#111;border-radius:8px;padding:16px;text-align:left;font-size:13px;color:var(--muted)">
      <strong style="color:var(--text)">SMS Forwarder App Setup:</strong><br>
      URL: <code>[worker-url]/api/sms/forward</code><br>
      Method: POST | Header: <code>X-API-Key: YOUR_KEY</code><br>
      Filter: <code>TrxID</code> keyword
    </div>
  </div>`:
  `<div class="card" style="overflow-x:auto">
    <table>
      <tr><th>Time</th><th>TrxID</th><th>Amount</th><th>Sender</th><th>Source</th><th>Status</th><th>Raw SMS</th></tr>
      ${smsList.map(s=>{
        const txnUsed = s.trxId && s.trxUsed;
        const statusBadge = !s.parsed
          ? `<span class="badge badge-danger">Parse failed</span>`
          : txnUsed
          ? `<span class="badge badge-warning">Used</span>`
          : `<span class="badge badge-success">Available</span>`;
        const sourceBadge = s.source === "manual"
          ? `<span class="badge badge-manual">Manual</span>`
          : `<span class="badge badge-info">Auto</span>`;
        return `<tr>
          <td style="font-size:12px;color:var(--muted);white-space:nowrap">${new Date(s.receivedAt).toLocaleString("en-BD",{timeZone:"Asia/Dhaka"})}</td>
          <td>${s.trxId?`<code>${s.trxId}</code>`:`<span style="color:var(--danger)">—</span>`}</td>
          <td>${s.amount!=null?`<strong>৳${s.amount}</strong>`:"—"}</td>
          <td style="font-size:13px">${s.senderPhone||"—"}</td>
          <td>${sourceBadge}</td>
          <td>${statusBadge}</td>
          <td style="max-width:240px;font-size:12px;color:var(--muted);word-break:break-word">${s.rawSms||"—"}</td>
        </tr>`;
      }).join("")}
    </table>
  </div>
  ${totalPages>1?`<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
    ${Array.from({length:totalPages},(_,i)=>`<a href="/admin/sms?page=${i+1}"><button class="${page===i+1?"btn-primary":"btn-secondary"}" style="padding:6px 14px">${i+1}</button></a>`).join("")}
  </div>`:""}`}
</div></body></html>`);
}

// ─── Manual SMS Entry Page ────────────────────────────────────────────────────

async function manualSmsPage(env, result=null) {
  const { brand } = await getConfig(env);
  const p = brand.primaryColor || "#E2136E";

  // Preview parsed result if available
  let resultHtml = "";
  if (result) {
    if (result.error) {
      resultHtml = `<div class="alert alert-error">${result.error}</div>`;
    } else if (result.parseFailed) {
      resultHtml = `
        <div class="alert alert-warning">
          ⚠️ SMS save হয়েছে কিন্তু TrxID parse করা যায়নি। 
          Transaction তৈরি হয়নি — শুধু SMS log-এ আছে।<br>
          <small style="opacity:.8">SMS ID: ${result.smsId}</small>
        </div>`;
    } else if (result.duplicate) {
      resultHtml = `
        <div class="alert alert-warning">
          ⚠️ এই TrxID আগেই আছে (duplicate SMS)। নতুন transaction তৈরি হয়নি।<br>
          <code style="font-size:13px">${result.parsed?.trxId}</code>
          ${result.parsed?.amount!=null?` — ৳${result.parsed.amount}`:""}
        </div>`;
    } else {
      resultHtml = `
        <div class="alert alert-success">
          ✅ SMS entry সফল! Transaction তৈরি হয়েছে।<br>
          <strong>TrxID:</strong> <code>${result.parsed?.trxId}</code>
          ${result.parsed?.amount!=null?` &nbsp;|&nbsp; <strong>Amount:</strong> ৳${result.parsed.amount}`:""}
          ${result.parsed?.senderPhone?` &nbsp;|&nbsp; <strong>From:</strong> ${result.parsed.senderPhone}`:""}
        </div>`;
    }
  }

  return html(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manual SMS Entry</title>${baseStyle(p)}
<script>
function previewSms() {
  const sms = document.getElementById('smsText').value.trim();
  const trxMatch  = sms.match(/TrxID\\s+([A-Z0-9]{6,})/i);
  const amtMatch  = sms.match(/Tk\\s+([\\d,]+\\.?\\d*)/i);
  const fromMatch = sms.match(/from\\s+(01[0-9]{9})/i);
  const prev = document.getElementById('preview');
  if (!sms) { prev.style.display='none'; return; }
  prev.style.display='block';
  document.getElementById('prevTrx').textContent  = trxMatch  ? trxMatch[1].toUpperCase() : '— (parse হবে না)';
  document.getElementById('prevAmt').textContent  = amtMatch  ? '৳' + parseFloat(amtMatch[1].replace(/,/g,'')).toFixed(2) : '—';
  document.getElementById('prevFrom').textContent = fromMatch ? fromMatch[1] : '—';
  document.getElementById('prevTrx').style.color  = trxMatch  ? 'var(--success)' : 'var(--danger)';
}
</script>
</head><body>
${adminNav("sms", brand)}
<div style="max-width:640px;margin:0 auto;padding:32px 24px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;flex-wrap:wrap">
    <a href="/admin/sms" style="color:var(--muted);font-size:13px">← SMS Log</a>
    <h1 style="font-size:22px;font-weight:700">Manual SMS Entry</h1>
  </div>

  ${resultHtml}

  <div class="card" style="margin-bottom:20px">
    <h2 style="font-size:15px;font-weight:600;margin-bottom:4px">কখন ব্যবহার করবেন?</h2>
    <p style="font-size:13px;color:var(--muted);line-height:1.7">
      যখন Android SMS Forwarder কাজ করছে না বা কোনো SMS miss হয়েছে, তখন bKash SMS টি
      manually paste করে transaction তৈরি করতে পারবেন।
      Customer তখন ওই TrxID দিয়ে payment verify করতে পারবে।
    </p>
  </div>

  <div class="card">
    <form method="POST" action="/admin/sms/manual">
      <div class="field">
        <label>bKash SMS Body (paste করুন)</label>
        <textarea id="smsText" name="smsText" rows="5" 
          placeholder="You have received Tk 30.00 from 01XXXXXXXXX. Fee Tk 0.00. Balance Tk 1,294.36. TrxID DDS3M42DR5 at 28/04/2026 21:23"
          oninput="previewSms()" style="font-size:13px;line-height:1.6;resize:vertical"></textarea>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">
          bKash confirmation SMS থেকে পুরো text copy করুন
        </div>
      </div>

      <!-- Live preview -->
      <div id="preview" style="display:none;background:#111;border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px">
        <div style="font-weight:600;margin-bottom:10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">Parse Preview</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div><div style="color:var(--muted);font-size:11px;margin-bottom:3px">TrxID</div><code id="prevTrx" style="font-size:14px"></code></div>
          <div><div style="color:var(--muted);font-size:11px;margin-bottom:3px">Amount</div><strong id="prevAmt"></strong></div>
          <div><div style="color:var(--muted);font-size:11px;margin-bottom:3px">Sender</div><span id="prevFrom"></span></div>
        </div>
      </div>

      <div class="field">
        <label>Sender Number (optional override)</label>
        <input name="senderPhone" placeholder="01XXXXXXXXX — SMS থেকে auto-detect না হলে দিন">
      </div>

      <div class="field">
        <label>Custom Date/Time (optional)</label>
        <input type="datetime-local" name="receivedAt">
        <div style="font-size:12px;color:var(--muted);margin-top:4px">খালি রাখলে এখনকার সময় ব্যবহার হবে</div>
      </div>

      <button type="submit" class="btn-primary" style="width:100%;padding:13px;font-size:15px">
        💾 SMS Save করুন
      </button>
    </form>
  </div>

  <div class="card" style="margin-top:20px">
    <h2 style="font-size:14px;font-weight:600;margin-bottom:10px">Example bKash SMS formats</h2>
    <div style="font-size:12px;color:var(--muted);line-height:2;font-family:monospace;background:#111;padding:12px;border-radius:8px">
      You have received Tk 30.00 from 01XXXXXXXXX. Fee Tk 0.00. Balance Tk 1,294.36. TrxID DDS3M42DR5 at 28/04/2026 21:23<br>
      You have received Tk 500.00 from 01XXXXXXXXX. TrxID A1B2C3D4E5. Balance Tk 2000.00<br>
      Tk 500.00 has been sent from 01XXXXXXXXX. TrxID A1B2C3D4E5...
    </div>
  </div>
</div></body></html>`);
}

async function transactionsPage(env, page=1) {
  const { brand } = await getConfig(env);
  const allIds = JSON.parse(await env.PG_KV.get("txn:index") || "[]");
  const PAGE = 20;
  const pageIds = allIds.slice().reverse().slice((page-1)*PAGE, page*PAGE);
  const txns = (await Promise.all(pageIds.map(id=>env.PG_KV.get(`txn:${id}`)))).map(r=>r?JSON.parse(r):null).filter(Boolean);
  const totalPages = Math.ceil(allIds.length / PAGE);
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Transactions</title>${baseStyle(brand.primaryColor)}</head><body>
${adminNav("transactions",brand)}
<div style="max-width:1200px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:24px">Transactions <span style="color:var(--muted);font-size:16px">(${allIds.length})</span></h1>
  ${txns.length===0?`<div class="card" style="text-align:center;padding:48px;color:var(--muted)">No transactions yet.</div>`:`
  <div class="card" style="overflow-x:auto"><table>
    <tr><th>Time</th><th>TrxID</th><th>Amount</th><th>Sender</th><th>Source</th><th>Product</th><th>Status</th></tr>
    ${txns.map(t=>`<tr>
      <td style="font-size:12px;color:var(--muted);white-space:nowrap">${new Date(t.createdAt).toLocaleString("en-BD",{timeZone:"Asia/Dhaka"})}</td>
      <td><code>${t.trxId}</code></td>
      <td><strong>৳${t.amount||"?"}</strong></td>
      <td style="font-size:13px">${t.senderPhone||"—"}</td>
      <td>${t.source==="manual"?`<span class="badge badge-manual">Manual</span>`:`<span class="badge badge-info">Auto</span>`}</td>
      <td style="font-size:13px">${t.productName||"—"}</td>
      <td><span class="badge ${t.status==="verified"?"badge-success":t.status==="used"?"badge-warning":"badge-info"}">${t.status}</span></td>
    </tr>`).join("")}
  </table></div>
  ${totalPages>1?`<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
    ${Array.from({length:totalPages},(_,i)=>`<a href="/admin/transactions?page=${i+1}"><button class="${page===i+1?"btn-primary":"btn-secondary"}" style="padding:6px 14px">${i+1}</button></a>`).join("")}
  </div>`:""}`}
</div></body></html>`);
}

async function apiDocsPage(env, origin) {
  const { brand } = await getConfig(env);
  return html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API Docs</title>${baseStyle(brand.primaryColor)}
<style>
.ep{background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:16px}
.method{display:inline-block;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700;margin-right:8px;font-family:monospace}
.get{background:#0f2d1a;color:var(--success)}.post{background:#0f1e2d;color:#93c5fd}
pre{background:#0a0a0a;border:1px solid #222;border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
h2{font-size:18px;font-weight:700;margin:28px 0 16px;border-bottom:1px solid var(--border);padding-bottom:8px}
h3{font-size:14px;margin:12px 0 6px;color:var(--muted)}
</style></head><body>
${adminNav("api",brand)}
<div style="max-width:900px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:22px;font-weight:700;margin-bottom:8px">API Documentation</h1>
  <p style="color:var(--muted);margin-bottom:20px">All API calls need header: <code>X-API-Key: YOUR_API_KEY</code></p>

  <div class="alert alert-info">
    <strong>Important:</strong> Payment verification শুধুমাত্র তখনই সফল হবে যখন Android SMS Forwarder
    আগে সেই TrxID forward করে রেখেছে অথবা Admin manually entry করেছে।
    Random TrxID দিলে reject হবে।
  </div>

  <h2>1. SMS Forwarder (Android → Server)</h2>
  <div class="ep">
    <span class="method post">POST</span><code>${origin}/api/sms/forward</code>
    <h3>Body</h3>
    <pre>${JSON.stringify({sender:"01XXXXXXXXX",message:"You have received Tk 30.00 from 01XXXXXXXXX. Fee Tk 0.00. Balance Tk 1,294.36. TrxID DDS3M42DR5 at 28/04/2026 21:23",receivedAt:"2024-01-15T10:30:00Z"},null,2)}</pre>
    <h3>Response</h3>
    <pre>${JSON.stringify({success:true,parsed:{trxId:"DDS3M42DR5",amount:30,senderPhone:"01XXXXXXXXX"},message:"SMS recorded. Transaction available for verification."},null,2)}</pre>
  </div>

  <h2>2. Transaction Verify</h2>
  <div class="ep">
    <span class="method post">POST</span><code>${origin}/api/verify</code>
    <h3>Body</h3>
    <pre>${JSON.stringify({trxId:"DDS3M42DR5",amount:30},null,2)}</pre>
    <h3>Success Response</h3>
    <pre>${JSON.stringify({success:true,valid:true,transaction:{trxId:"DDS3M42DR5",amount:30,senderPhone:"01XXXXXXXXX"}},null,2)}</pre>
    <h3>Error — TxID SMS-এ আসেনি</h3>
    <pre>${JSON.stringify({success:false,valid:false,message:"Transaction not found. bKash SMS এখনো receive হয়নি অথবা TrxID ভুল।"},null,2)}</pre>
  </div>

  <h2>3. Website Integration</h2>
  <div class="ep">
    <span class="method post">POST</span><code>${origin}/api/payment/check</code>
    <h3>Body</h3>
    <pre>${JSON.stringify({trxId:"DDS3M42DR5",amount:30,orderId:"ORDER-123"},null,2)}</pre>
  </div>
  <div class="ep"><span class="method get">GET</span><code>${origin}/api/transaction/:trxId</code></div>

  <h2>4. Payment Pages</h2>
  <div class="ep"><span class="method get">GET</span><code>${origin}/pay/:productId</code></div>
  <div class="ep"><span class="method get">GET</span><code>${origin}/pay/:productId?amount=500</code></div>

  <h2>5. JS Snippet (Website)</h2>
  <pre>&lt;script&gt;
async function verifyPayment(trxId, amount) {
  const res = await fetch('${origin}/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'YOUR_KEY' },
    body: JSON.stringify({ trxId, amount })
  });
  const data = await res.json();
  return data; // { success, valid, transaction }
}
&lt;/script&gt;</pre>
</div></body></html>`);
}

// ─── Public Payment Page ──────────────────────────────────────────────────────

async function paymentPage(env, productId, query) {
  const { brand, bkash } = await getConfig(env);
  const productRaw = await env.PG_KV.get(`product:${productId}`);
  if (!productRaw) return html(`<!DOCTYPE html><html><head>${baseStyle()}</head><body>
<div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div class="card" style="text-align:center;padding:48px;max-width:400px">
    <div style="font-size:48px;margin-bottom:16px">❌</div>
    <h2>Payment link not found</h2>
    <p style="color:var(--muted);margin-top:8px">This link may have expired or been removed.</p>
  </div>
</div></body></html>`,404);

  const product = JSON.parse(productRaw);
  if (!product.active) return html(`<!DOCTYPE html><html><head>${baseStyle()}</head><body>
<div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div class="card" style="text-align:center;padding:48px;max-width:400px">
    <div style="font-size:48px;margin-bottom:16px">🚫</div>
    <h2>Payment link inactive</h2>
    <p style="color:var(--muted);margin-top:8px">This payment link is currently unavailable.</p>
  </div>
</div></body></html>`,410);

  const p   = brand.primaryColor || "#E2136E";
  const baseAmt  = product.fixedPrice ? product.price : (query.get("amount") || "");
  const vatAmt   = baseAmt && bkash.vat ? (parseFloat(baseAmt)*parseFloat(bkash.vat)/100).toFixed(2) : 0;
  const totalAmt = baseAmt ? (parseFloat(baseAmt)+parseFloat(vatAmt)).toFixed(2) : "";

  return html(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${product.name} | ${brand.name}</title>
${baseStyle(p)}
<style>
body{background:linear-gradient(135deg,#0f0f0f 0%,#1a0a10 100%)}
.pay-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;width:100%;max-width:460px}
.pay-header{background:${p};padding:24px;text-align:center}
.pay-header h1{font-size:20px;font-weight:700;color:#fff}
.pay-header p{font-size:13px;color:rgba(255,255,255,.8);margin-top:4px}
.pay-body{padding:24px}
.merchant-box{background:#111;border:1px solid ${p}44;border-radius:12px;padding:16px 20px;text-align:center;margin-bottom:20px;position:relative}
.merchant-number{font-size:26px;font-weight:700;letter-spacing:2px;color:${p};font-family:monospace;margin:6px 0}
.amount-box{background:#111;border:1px solid ${p}33;border-radius:10px;padding:14px;text-align:center;margin-bottom:18px}
.step{display:flex;gap:10px;margin-bottom:10px;align-items:flex-start}
.step-num{background:${p};color:#fff;border-radius:50%;width:22px;height:22px;min-width:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.step-text{font-size:13px;color:var(--muted);line-height:1.5}
.copy-btn-float{position:absolute;top:10px;right:10px;background:transparent;border:1px solid ${p}55;color:${p};padding:3px 10px;border-radius:6px;font-size:12px;cursor:pointer}
</style>
<script>
function copyNum(){
  navigator.clipboard.writeText('${bkash.phone}');
  const b=document.getElementById('cBtn');b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',2000);
}
async function submitPayment(){
  const trxId=document.getElementById('trxId').value.trim().toUpperCase();
  ${!product.fixedPrice?"const amtVal=document.getElementById('amtInput').value.trim();":""}
  const btn=document.getElementById('submitBtn');
  const errEl=document.getElementById('errMsg');
  errEl.style.display='none';
  if(!trxId){errEl.textContent='Transaction ID দিন';errEl.style.display='block';return}
  if(trxId.length<6){errEl.textContent='Transaction ID কমপক্ষে ৬ character হতে হবে';errEl.style.display='block';return}
  ${!product.fixedPrice?"if(!amtVal||isNaN(amtVal)||parseFloat(amtVal)<=0){errEl.textContent='পরিমাণ দিন';errEl.style.display='block';return}":""}
  btn.textContent='Verifying...';btn.disabled=true;
  try{
    const res=await fetch('/api/public/submit',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        trxId,
        productId:'${product.id}',
        ${product.fixedPrice?`amount:${totalAmt||product.price},expectedAmount:${totalAmt||product.price}`:"amount:parseFloat(amtVal),expectedAmount:parseFloat(amtVal)"}
      })
    });
    const d=await res.json();
    if(d.success){
      document.getElementById('payForm').style.display='none';
      document.getElementById('successMsg').style.display='block';
      ${product.successUrl?`setTimeout(()=>{window.location.href='${product.successUrl}'},3000);`:""}
    } else {
      errEl.textContent=d.message;errEl.style.display='block';
      btn.textContent='Verify & Confirm';btn.disabled=false;
    }
  }catch(e){
    errEl.textContent='Network error. Please try again.';errEl.style.display='block';
    btn.textContent='Verify & Confirm';btn.disabled=false;
  }
}
</script>
</head><body>
<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
  <div class="pay-card">
    <div class="pay-header">
      ${brand.logo?`<img src="${brand.logo}" style="height:32px;margin-bottom:6px;border-radius:4px">`:""} 
      <h1>${brand.name}</h1>
      <p>${product.name}${product.description?` — ${product.description}`:""}</p>
    </div>
    <div class="pay-body">
      <div id="payForm">
        ${bkash.enabled&&bkash.phone?`
        <div class="merchant-box">
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">bKash ${bkash.accountType||"Personal"} — Send Money To</div>
          <div class="merchant-number">${bkash.phone}</div>
          <button id="cBtn" class="copy-btn-float" onclick="copyNum()">Copy</button>
        </div>`:`<div class="alert alert-error">Gateway not configured. Contact support.</div>`}

        ${totalAmt?`
        <div class="amount-box">
          <div style="font-size:12px;color:var(--muted)">পাঠাতে হবে</div>
          ${bkash.vat>0?`<div style="font-size:12px;color:var(--muted)">৳${baseAmt} + ৳${vatAmt} VAT</div>`:""}
          <div style="font-size:30px;font-weight:700;color:${p}">৳${totalAmt}</div>
        </div>`:""}

        <div style="margin-bottom:18px">
          <div class="step"><div class="step-num">1</div><div class="step-text">bKash app খুলুন → Send Money → <strong>${bkash.phone}</strong></div></div>
          <div class="step"><div class="step-num">2</div><div class="step-text">${totalAmt?`<strong>৳${totalAmt}</strong> পাঠান`:"নির্ধারিত পরিমাণ পাঠান"} — TrxID নোট করুন</div></div>
          <div class="step"><div class="step-num">3</div><div class="step-text">নিচে TrxID দিন → Verify করুন</div></div>
        </div>

        ${bkash.instructions?`<div style="background:#111;border-radius:8px;padding:10px 12px;font-size:13px;color:var(--muted);margin-bottom:16px">${bkash.instructions}</div>`:""}

        <div id="errMsg" class="alert alert-error" style="display:none"></div>

        ${!product.fixedPrice?`<div class="field"><label>Amount (BDT) — আপনি কত পাঠিয়েছেন</label><input type="number" id="amtInput" value="${query.get("amount")||""}" min="1" step="0.01" placeholder="যেমন: 500"></div>`:""}

        <div class="field">
          <label>bKash Transaction ID (TrxID)</label>
          <input id="trxId" placeholder="যেমন: DDS3M42DR5" style="font-size:16px;letter-spacing:1px;text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">
          <div style="font-size:12px;color:var(--muted);margin-top:6px">bKash confirmation SMS-এ TrxID পাবেন</div>
        </div>

        <button id="submitBtn" class="btn-primary" style="width:100%;padding:14px;font-size:15px" onclick="submitPayment()">
          Verify & Confirm Payment
        </button>
      </div>

      <div id="successMsg" style="display:none;text-align:center;padding:20px">
        <div style="font-size:56px;margin-bottom:16px">✅</div>
        <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">Payment Verified!</h2>
        <p style="color:var(--muted)">আপনার payment সফলভাবে confirm হয়েছে।</p>
        ${product.successUrl?`<p style="color:var(--muted);font-size:13px;margin-top:8px">৩ সেকেন্ডে redirect হবে...</p>`:""}
      </div>

      <div style="text-align:center;margin-top:18px;padding-top:18px;border-top:1px solid var(--border)">
        <span style="font-size:12px;color:var(--muted)">Secured by <strong style="color:${p}">${brand.name}</strong></span>
      </div>
    </div>
  </div>
</div></body></html>`);
}

// ─── API Key Check ────────────────────────────────────────────────────────────

function requireApiKey(request, env) {
  const key = request.headers.get("X-API-Key") || request.headers.get("x-api-key");
  return key && key === env.API_KEY;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function handleSetup(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  if (!secret || secret !== env.ADMIN_SECRET)
    return json({ error: "Invalid setup secret" }, 403);
  const pass = url.searchParams.get("password");
  if (!pass || pass.length < 8)
    return json({ error: "password param required (min 8 chars)" }, 400);
  await env.PG_KV.put("admin:password", await sha256(pass));
  const existing = await env.PG_KV.get("config:brand");
  if (!existing) await env.PG_KV.put("config:brand", JSON.stringify({name:"PayGate",logo:"",primaryColor:"#E2136E",tagline:"Fast & Secure Payments"}));
  return json({ success: true, message: "Admin password set. Visit /admin to login." });
}

// ─── Manual SMS Entry Handler ─────────────────────────────────────────────────

async function handleManualSmsPost(request, env) {
  const form = await request.formData();
  const smsText     = (form.get("smsText") || "").trim();
  const senderPhone = (form.get("senderPhone") || "").trim();
  const receivedAtRaw = form.get("receivedAt") || "";

  if (!smsText) {
    return manualSmsPage(env, { error: "SMS text দিন।" });
  }

  const now = receivedAtRaw
    ? new Date(receivedAtRaw).toISOString()
    : new Date().toISOString();

  const smsId  = nanoid(14);
  const parsed = parseBkashSms(smsText);

  const smsRecord = {
    id:         smsId,
    rawSms:     smsText,
    sender:     senderPhone || parsed?.senderPhone || null,
    receivedAt: now,
    parsed:     !!parsed,
    trxId:      parsed?.trxId || null,
    amount:     parsed?.amount ?? null,
    senderPhone:senderPhone || parsed?.senderPhone || null,
    trxUsed:    false,
    source:     "manual",   // ★ mark as manually entered
  };

  await env.PG_KV.put(`sms:${smsId}`, JSON.stringify(smsRecord));
  await appendToIndex(env, "sms:index", smsId);

  if (!parsed || !parsed.trxId) {
    return manualSmsPage(env, { parseFailed: true, smsId });
  }

  // Duplicate TxID check
  const existingTxn = await env.PG_KV.get(`txn:${parsed.trxId}`);
  if (existingTxn) {
    return manualSmsPage(env, { duplicate: true, parsed, smsId });
  }

  // Create transaction record
  const txnRecord = {
    trxId:       parsed.trxId,
    amount:      parsed.amount,
    senderPhone: senderPhone || parsed.senderPhone || null,
    status:      "received",
    createdAt:   now,
    smsId:       smsId,
    source:      "manual",   // ★ mark as manually entered
    productId:   null,
    productName: null,
  };

  await env.PG_KV.put(`txn:${parsed.trxId}`, JSON.stringify(txnRecord));
  await appendToIndex(env, "txn:index", parsed.trxId);

  return manualSmsPage(env, { success: true, parsed, smsId });
}

// ─── Main Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method;

    // Setup
    if (path === "/setup") return handleSetup(request, env);

    // ═════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═════════════════════════════════════════════════════════════════

    if (path === "/api/public/submit" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({success:false,message:"Invalid JSON"},400); }

      const { trxId, productId, amount, expectedAmount } = body;
      if (!trxId) return json({success:false, message:"Transaction ID দিন"});

      const cleanTrxId = trxId.trim().toUpperCase();
      if (cleanTrxId.length < 5) return json({success:false, message:"Transaction ID সঠিক নয়"});

      const used = await env.PG_KV.get(`txn:used:${cleanTrxId}`);
      if (used) return json({success:false, message:"এই Transaction ID আগেই ব্যবহার করা হয়েছে।"});

      const txnRaw = await env.PG_KV.get(`txn:${cleanTrxId}`);
      if (!txnRaw) {
        return json({
          success: false,
          message: "Transaction ID পাওয়া যায়নি। bKash SMS forward হয়নি অথবা TrxID ভুল। কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।"
        });
      }

      const txn = JSON.parse(txnRaw);

      if (expectedAmount && txn.amount != null) {
        const exp = parseFloat(expectedAmount);
        const got = parseFloat(txn.amount);
        if (Math.abs(got - exp) > 0.5) {
          return json({
            success: false,
            message: `Amount মিলছে না। Expected ৳${exp}, কিন্তু SMS-এ পাওয়া গেছে ৳${got}। সঠিক পরিমাণ পাঠান।`
          });
        }
      }

      let productName = null;
      if (productId) {
        const prodRaw = await env.PG_KV.get(`product:${productId}`);
        if (prodRaw) productName = JSON.parse(prodRaw).name;
      }

      txn.status      = "verified";
      txn.verifiedAt  = new Date().toISOString();
      txn.productId   = productId || null;
      txn.productName = productName;
      txn.verifiedAmount = amount || null;

      await env.PG_KV.put(`txn:${cleanTrxId}`, JSON.stringify(txn));
      await env.PG_KV.put(`txn:used:${cleanTrxId}`, "1");

      if (txn.smsId) {
        const smsRaw = await env.PG_KV.get(`sms:${txn.smsId}`);
        if (smsRaw) {
          const sms = JSON.parse(smsRaw);
          sms.trxUsed = true;
          await env.PG_KV.put(`sms:${txn.smsId}`, JSON.stringify(sms));
        }
      }

      if (productId) {
        const prodRaw = await env.PG_KV.get(`product:${productId}`);
        if (prodRaw) {
          const prod = JSON.parse(prodRaw);
          if (prod.webhookUrl) {
            try {
              fetch(prod.webhookUrl, {
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({event:"payment.verified", ...txn}),
              });
            } catch {}
          }
        }
      }

      return json({success:true, message:"Payment verified successfully!", transaction: txn});
    }

    // ═════════════════════════════════════════════════════════════════
    // API — requires API key
    // ═════════════════════════════════════════════════════════════════
    if (path.startsWith("/api/")) {
      if (!requireApiKey(request, env))
        return json({success:false, error:"Unauthorized. X-API-Key header required."}, 401);

      if (path === "/api/sms/forward" && method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({success:false,message:"Invalid JSON"},400); }

        const { sender, message, receivedAt } = body;
        if (!message) return json({success:false,message:"message field required"},400);

        const smsId  = nanoid(14);
        const parsed = parseBkashSms(message);
        const now    = receivedAt || new Date().toISOString();

        const smsRecord = {
          id:         smsId,
          rawSms:     message,
          sender:     sender || null,
          receivedAt: now,
          parsed:     !!parsed,
          trxId:      parsed?.trxId    || null,
          amount:     parsed?.amount   ?? null,
          senderPhone:parsed?.senderPhone || sender || null,
          trxUsed:    false,
          source:     "auto",
        };
        await env.PG_KV.put(`sms:${smsId}`, JSON.stringify(smsRecord));
        await appendToIndex(env, "sms:index", smsId);

        if (!parsed || !parsed.trxId) {
          return json({
            success: false,
            smsId,
            message: "SMS recorded but could not parse TrxID. Check raw SMS format.",
            raw: message,
          });
        }

        const existingTxn = await env.PG_KV.get(`txn:${parsed.trxId}`);
        if (existingTxn) {
          return json({
            success:   true,
            duplicate: true,
            smsId,
            parsed,
            message: "Transaction already recorded (duplicate SMS).",
          });
        }

        const txnRecord = {
          trxId:       parsed.trxId,
          amount:      parsed.amount,
          senderPhone: parsed.senderPhone || sender || null,
          status:      "received",
          createdAt:   now,
          smsId:       smsId,
          source:      "sms_forward",
          productId:   null,
          productName: null,
        };
        await env.PG_KV.put(`txn:${parsed.trxId}`, JSON.stringify(txnRecord));
        await appendToIndex(env, "txn:index", parsed.trxId);

        return json({
          success: true,
          smsId,
          parsed,
          message: "SMS recorded. Transaction available for verification.",
        });
      }

      if (path === "/api/verify" && method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({success:false,message:"Invalid JSON"},400); }
        const { trxId, amount } = body;
        if (!trxId) return json({success:false,valid:false,message:"trxId required"},400);

        const cleanTrxId = trxId.trim().toUpperCase();
        const used = await env.PG_KV.get(`txn:used:${cleanTrxId}`);
        if (used) return json({success:false,valid:false,message:"Transaction ID already used."});

        const txnRaw = await env.PG_KV.get(`txn:${cleanTrxId}`);
        if (!txnRaw) return json({success:false,valid:false,message:"Transaction not found. SMS not received yet or TrxID incorrect."});

        const txn = JSON.parse(txnRaw);
        if (amount != null && txn.amount != null) {
          if (Math.abs(txn.amount - parseFloat(amount)) > 0.5)
            return json({success:false,valid:false,message:`Amount mismatch. Expected ৳${amount}, got ৳${txn.amount}.`});
        }

        txn.status     = "verified";
        txn.verifiedAt = new Date().toISOString();
        await env.PG_KV.put(`txn:${cleanTrxId}`, JSON.stringify(txn));
        await env.PG_KV.put(`txn:used:${cleanTrxId}`, "1");

        return json({success:true,valid:true,message:"Transaction verified.",transaction:txn});
      }

      if (path === "/api/payment/check" && method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({success:false,message:"Invalid JSON"},400); }
        const { trxId, amount, orderId, customerPhone } = body;
        if (!trxId || !amount) return json({success:false,valid:false,message:"trxId and amount required"},400);

        const cleanTrxId = trxId.trim().toUpperCase();
        const used = await env.PG_KV.get(`txn:used:${cleanTrxId}`);
        if (used) return json({success:false,valid:false,orderId,message:"Transaction already used."});

        const txnRaw = await env.PG_KV.get(`txn:${cleanTrxId}`);
        if (!txnRaw) return json({success:false,valid:false,orderId,message:"Transaction not found. bKash SMS not yet received."});

        const txn = JSON.parse(txnRaw);
        if (Math.abs(txn.amount - parseFloat(amount)) > 0.5)
          return json({success:false,valid:false,orderId,message:`Amount mismatch. Expected ৳${amount}, received ৳${txn.amount}.`});

        txn.status       = "verified";
        txn.verifiedAt   = new Date().toISOString();
        txn.orderId      = orderId || null;
        txn.customerPhone= customerPhone || null;
        await env.PG_KV.put(`txn:${cleanTrxId}`, JSON.stringify(txn));
        await env.PG_KV.put(`txn:used:${cleanTrxId}`, "1");

        return json({success:true,valid:true,orderId,message:"Payment confirmed.",transaction:txn});
      }

      const txnMatch = path.match(/^\/api\/transaction\/([A-Z0-9]+)$/i);
      if (txnMatch && method === "GET") {
        const trxId  = txnMatch[1].toUpperCase();
        const txnRaw = await env.PG_KV.get(`txn:${trxId}`);
        if (!txnRaw) return json({success:false,message:"Transaction not found."},404);
        return json({success:true,transaction:JSON.parse(txnRaw)});
      }

      return json({error:"API endpoint not found"},404);
    }

    // ═════════════════════════════════════════════════════════════════
    // Public payment pages
    // ═════════════════════════════════════════════════════════════════
    const payMatch = path.match(/^\/pay\/([a-z0-9]+)$/i);
    if (payMatch) return paymentPage(env, payMatch[1], url.searchParams);

    // ═════════════════════════════════════════════════════════════════
    // Admin routes
    // ═════════════════════════════════════════════════════════════════
    if (path === "/" || path === "") return redirect("/admin");
    if (!path.startsWith("/admin")) return html("<h1>Not Found</h1>",404);

    if (path === "/admin/login") {
      if (method === "GET") return loginPage();
      if (method === "POST") {
        const form       = await request.formData();
        const password   = form.get("password") || "";
        const storedHash = await env.PG_KV.get("admin:password");
        if (!storedHash) return loginPage("Admin not set up. Visit /setup first.");
        if (await sha256(password) !== storedHash) return loginPage("Incorrect password.");
        const token = nanoid(32);
        await env.PG_KV.put(`sessions:${token}`, "1", {expirationTtl:86400});
        return setCookieRedirect("/admin", "pg_session", token);
      }
    }

    if (path === "/admin/logout") return clearCookieRedirect("/admin/login", "pg_session");

    // Auth gate
    const session = await requireAdmin(request, env);
    if (!session) return redirect("/admin/login");

    if (path === "/admin" || path === "/admin/") return dashboardPage(env);

    if (path === "/admin/brand") {
      if (method === "GET") return brandPage(env);
      if (method === "POST") {
        const form  = await request.formData();
        const brand = {
          name:         form.get("name")         || "PayGate",
          tagline:      form.get("tagline")       || "",
          logo:         form.get("logo")          || "",
          primaryColor: form.get("primaryColor")  || "#E2136E",
        };
        await env.PG_KV.put("config:brand", JSON.stringify(brand));
        return brandPage(env, "Brand saved!", "");
      }
    }

    if (path === "/admin/bkash") {
      if (method === "GET") return bkashPage(env);
      if (method === "POST") {
        const form  = await request.formData();
        const bkash = {
          phone:        form.get("phone")        || "",
          accountType:  form.get("accountType")  || "Personal",
          vat:          parseFloat(form.get("vat")||0),
          instructions: form.get("instructions") || "",
          enabled:      form.get("enabled")      === "on",
        };
        await env.PG_KV.put("config:bkash", JSON.stringify(bkash));
        return bkashPage(env, "bKash config saved!", "");
      }
    }

    if (path === "/admin/products") return productsPage(env, url.searchParams.get("msg")||"");

    if (path === "/admin/products/new") {
      if (method === "GET") return productFormPage(env);
      if (method === "POST") {
        const form       = await request.formData();
        const fixedPrice = form.get("fixedPrice") === "on";
        const id         = nanoid(10);
        const product    = {
          id, fixedPrice,
          name:        form.get("name")        || "Untitled",
          description: form.get("description") || "",
          price:       fixedPrice ? parseFloat(form.get("price")||0) : null,
          successUrl:  form.get("successUrl")  || "",
          webhookUrl:  form.get("webhookUrl")  || "",
          active:      form.get("active")      === "on",
          createdAt:   new Date().toISOString(),
        };
        await env.PG_KV.put(`product:${id}`, JSON.stringify(product));
        await appendToIndex(env, "products:index", id);
        return redirect("/admin/products?msg=created");
      }
    }

    const editMatch = path.match(/^\/admin\/products\/([a-z0-9]+)\/edit$/i);
    if (editMatch) {
      const id      = editMatch[1];
      const prodRaw = await env.PG_KV.get(`product:${id}`);
      if (!prodRaw) return html("<h1>Not found</h1>",404);
      const product = JSON.parse(prodRaw);
      if (method === "GET") return productFormPage(env, product);
      if (method === "POST") {
        const form       = await request.formData();
        const fixedPrice = form.get("fixedPrice") === "on";
        const updated    = {
          ...product, fixedPrice,
          name:        form.get("name")        || product.name,
          description: form.get("description") || "",
          price:       fixedPrice ? parseFloat(form.get("price")||0) : null,
          successUrl:  form.get("successUrl")  || "",
          webhookUrl:  form.get("webhookUrl")  || "",
          active:      form.get("active")      === "on",
          updatedAt:   new Date().toISOString(),
        };
        await env.PG_KV.put(`product:${id}`, JSON.stringify(updated));
        return redirect("/admin/products?msg=updated");
      }
    }

    const deleteMatch = path.match(/^\/admin\/products\/([a-z0-9]+)\/delete$/i);
    if (deleteMatch && method === "POST") {
      await env.PG_KV.delete(`product:${deleteMatch[1]}`);
      await removeFromIndex(env, "products:index", deleteMatch[1]);
      return redirect("/admin/products");
    }

    // SMS Log
    if (path === "/admin/sms") {
      const page = parseInt(url.searchParams.get("page")||"1");
      return smsLogPage(env, page);
    }
    if (path === "/admin/sms/clear" && method === "GET") {
      const ids = JSON.parse(await env.PG_KV.get("sms:index")||"[]");
      await Promise.all(ids.map(id=>env.PG_KV.delete(`sms:${id}`)));
      await env.PG_KV.put("sms:index","[]");
      return redirect("/admin/sms");
    }

    // ★ Manual SMS Entry
    if (path === "/admin/sms/manual") {
      if (method === "GET")  return manualSmsPage(env);
      if (method === "POST") return handleManualSmsPost(request, env);
    }

    if (path === "/admin/transactions") {
      const page = parseInt(url.searchParams.get("page")||"1");
      return transactionsPage(env, page);
    }

    if (path === "/admin/api-docs") return apiDocsPage(env, url.origin);

    return html("<h1>Not Found</h1>",404);
  },
};
