# PayGate SMS Forwarder

A two-part open-source payment gateway system for bKash. An Android app (Flutter) automatically detects incoming bKash SMS and forwards them to a Cloudflare Worker backend that verifies transactions and serves payment pages.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Flutter](https://img.shields.io/badge/Flutter-3.x-blue)](https://flutter.dev)
[![Platform](https://img.shields.io/badge/Platform-Android-green)](https://developer.android.com)
[![Cloudflare Workers](https://img.shields.io/badge/Backend-Cloudflare%20Workers-orange)](https://workers.cloudflare.com)

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Repository Structure](#repository-structure)
- [Part 1 — Cloudflare Worker Setup](#part-1--cloudflare-worker-setup)
  - [Prerequisites](#worker-prerequisites)
  - [1. Create a KV Namespace](#1-create-a-kv-namespace)
  - [2. Deploy the Worker](#2-deploy-the-worker)
  - [3. Set Environment Variables](#3-set-environment-variables)
  - [4. Initialize Admin Password](#4-initialize-admin-password)
  - [5. Admin Panel Walkthrough](#5-admin-panel-walkthrough)
- [Part 2 — Android App Setup](#part-2--android-app-setup)
  - [Prerequisites](#app-prerequisites)
  - [1. Clone & Install Dependencies](#1-clone--install-dependencies)
  - [2. Build the APK](#2-build-the-apk)
  - [3. Install on Device](#3-install-on-device)
  - [4. In-App Configuration](#4-in-app-configuration)
- [Backend API Reference](#backend-api-reference)
- [Worker KV Data Model](#worker-kv-data-model)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

PayGate solves a common problem for small businesses and developers in Bangladesh: verifying bKash payments without access to the official bKash Payment Gateway API.

**How it works:**

1. A customer sends money via bKash to your personal/merchant number.
2. bKash sends a confirmation SMS to your Android phone.
3. The **Android app** detects the SMS and instantly forwards it to your **Cloudflare Worker**.
4. The Worker parses the TrxID and amount, stores the transaction, and marks it as available for verification.
5. The customer enters their TrxID on your **payment page** — the Worker verifies it against the stored record.

No official API access required. No third-party services. Everything runs on your own infrastructure.

---

## System Architecture

```
Customer pays via bKash
        │
        ▼
bKash SMS → Your Android Phone
        │
        ▼ HTTP POST (real-time)
┌───────────────────────────────────┐
│     Cloudflare Worker             │
│  worker/worker.js                 │
│                                   │
│  ┌─────────────────────────────┐  │
│  │  KV Store (PG_KV)           │  │
│  │  • SMS records              │  │
│  │  • Transaction records      │  │
│  │  • Products / Payment Links │  │
│  │  • Admin session + config   │  │
│  └─────────────────────────────┘  │
│                                   │
│  Routes:                          │
│  /admin         → Admin panel     │
│  /pay/:id       → Payment page    │
│  /api/sms/forward → Receive SMS   │
│  /api/verify    → Verify TrxID    │
│  /api/payment/check → Website API │
└───────────────────────────────────┘
        │                   │
        ▼                   ▼
 Customer enters       Your website
 TrxID on /pay/:id     calls /api/verify
```

**Two forwarding mechanisms run in parallel on the Android app:**

```
bKash SMS arrives
       │
       ├──► SmsReceiver (BroadcastReceiver) — fires instantly
       │
       └──► SmsPollingService (polls inbox every 15s) — safety net
```

---

## Repository Structure

```
PayGateApp/
├── lib/
│   └── main.dart                      # Flutter UI + app logic
├── android/
│   └── app/src/main/
│       ├── AndroidManifest.xml        # Permissions & component declarations
│       └── kotlin/com/example/paygate/
│           ├── MainActivity.kt        # Flutter ↔ Kotlin MethodChannel bridge
│           ├── SmsReceiver.kt         # Real-time SMS BroadcastReceiver
│           ├── SmsPollingService.kt   # Foreground polling service (15s interval)
│           └── BootReceiver.kt        # Auto-restart after reboot
├── worker/
│   └── worker.js                      # Cloudflare Worker — full backend
├── test/
│   └── widget_test.dart
└── pubspec.yaml
```

---

## Part 1 — Cloudflare Worker Setup

### Worker Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org) 18+ installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed:

```bash
npm install -g wrangler
wrangler login
```

---

### 1. Create a KV Namespace

The Worker stores all data in Cloudflare KV. Create a namespace:

```bash
wrangler kv:namespace create PG_KV
```

Note the `id` value from the output — you'll need it in the next step.

Also create a preview namespace for local development:

```bash
wrangler kv:namespace create PG_KV --preview
```

---

### 2. Deploy the Worker

Create a `wrangler.toml` file in the project root (next to the `worker/` folder):

```toml
name = "paygate"
main = "worker/worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "PG_KV"
id = "YOUR_KV_NAMESPACE_ID"           # from step 1
preview_id = "YOUR_PREVIEW_KV_ID"     # from step 1 (preview)
```

Deploy:

```bash
wrangler deploy
```

Your Worker will be live at:
```
https://paygate.<your-subdomain>.workers.dev
```

---

### 3. Set Environment Variables

The Worker requires two secrets. Set them via Wrangler (never hardcode them):

```bash
# A long random string — used to authorize the Android app
wrangler secret put API_KEY
# Paste a strong random key when prompted, e.g.: openssl rand -hex 32

# A one-time secret used only to set the admin password
wrangler secret put ADMIN_SECRET
# Paste any secret string, e.g.: my-setup-secret-2025
```

| Variable | Purpose |
|---|---|
| `API_KEY` | Authenticates requests from the Android SMS Forwarder app and your backend |
| `ADMIN_SECRET` | One-time secret for the `/setup` endpoint to initialize the admin password |

---

### 4. Initialize Admin Password

Visit this URL once in your browser to set the admin panel password:

```
https://paygate.<your-subdomain>.workers.dev/setup?secret=YOUR_ADMIN_SECRET&password=YOUR_ADMIN_PASSWORD
```

- Replace `YOUR_ADMIN_SECRET` with the value you set in step 3.
- Replace `YOUR_ADMIN_PASSWORD` with your desired admin password (min 8 characters).

A successful response looks like:

```json
{ "success": true, "message": "Admin password set. Visit /admin to login." }
```

> **Security note:** After setup, the `ADMIN_SECRET` is no longer needed for day-to-day use. The admin password is stored as a SHA-256 hash in KV.

---

### 5. Admin Panel Walkthrough

Visit `https://paygate.<your-subdomain>.workers.dev/admin` and log in with your admin password.

**Brand Settings** (`/admin/brand`)

Configure your brand name, logo URL, tagline, and primary color. These appear on all public payment pages.

**bKash Configuration** (`/admin/bkash`)

| Field | Description |
|---|---|
| bKash Number | Your personal/merchant bKash number that customers send money to |
| Account Type | Personal, Merchant, or Agent |
| VAT / Service Charge | Percentage added on top of the product price (displayed to customer) |
| Payment Instructions | Custom text shown on the payment page |
| Enable bKash Gateway | Toggle to activate/deactivate the payment pages |

**Payment Links** (`/admin/products`)

Each payment link is a public URL (`/pay/:id`) you can share with customers.

- **Fixed Price** — amount is pre-set; customer pays exactly that amount
- **Open Price** — customer enters the amount themselves (useful for donations or variable orders)
- **Success Redirect URL** — where to send the customer after successful payment verification
- **Webhook URL** — your server receives a POST with the transaction details after each verified payment

**SMS Log** (`/admin/sms`)

Shows every SMS forwarded by the Android app, with parsed TrxID, amount, and status. You can also add entries manually if the app missed an SMS.

**Manual SMS Entry** (`/admin/sms/manual`)

Paste a raw bKash SMS body to manually create a transaction record. Useful when the Android app is offline or a payment SMS was missed.

**Transactions** (`/admin/transactions`)

Full history of all verified and pending transactions with source (auto/manual), amount, TrxID, and linked product.

---

## Part 2 — Android App Setup

### App Prerequisites

| Tool | Version | Install Guide |
|---|---|---|
| Flutter SDK | 3.x or later | https://docs.flutter.dev/get-started/install |
| Android Studio | Latest stable | https://developer.android.com/studio |
| Android SDK | API 21+ | Via Android Studio SDK Manager |
| Java JDK | 17 | https://adoptium.net |
| Git | Any recent | https://git-scm.com |

Verify your environment:

```bash
flutter doctor
```

All items must show a green checkmark before proceeding.

---

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/devfahim00/PayGateApp.git
cd PayGateApp
flutter pub get
```

---

### 2. Build the APK

#### Debug Build (for testing)

```bash
flutter build apk --debug
```

Output: `build/app/outputs/flutter-apk/app-debug.apk`

#### Release Build (for production)

**Step 1 — Create a signing keystore:**

```bash
keytool -genkey -v \
  -keystore ~/paygate-release.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias paygate
```

Keep this `.jks` file safe — you need it for every future update.

**Step 2 — Create `android/key.properties`:**

```properties
storePassword=YOUR_STORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=paygate
storeFile=/absolute/path/to/paygate-release.jks
```

**Step 3 — Reference it in `android/app/build.gradle.kts`:**

Add before the `android {}` block:

```kotlin
import java.util.Properties
import java.io.FileInputStream

val keyProps = Properties()
val keyPropsFile = rootProject.file("key.properties")
if (keyPropsFile.exists()) { keyProps.load(FileInputStream(keyPropsFile)) }
```

Inside `buildTypes { release { ... } }`:

```kotlin
release {
    signingConfig = signingConfigs.create("release") {
        keyAlias = keyProps["keyAlias"] as String
        keyPassword = keyProps["keyPassword"] as String
        storeFile = file(keyProps["storeFile"] as String)
        storePassword = keyProps["storePassword"] as String
    }
    isMinifyEnabled = false
}
```

**Step 4 — Build:**

```bash
flutter build apk --release
```

Output: `build/app/outputs/flutter-apk/app-release.apk`

---

### 3. Install on Device

Enable **Developer Options** and **USB Debugging** on your Android device, then:

```bash
# Install directly via USB
flutter install

# Or via adb
adb install build/app/outputs/flutter-apk/app-release.apk
```

Minimum Android version: **5.0 (API 21)**

---

### 4. In-App Configuration

1. **Launch** the app. The Setup Screen appears on first run.

2. Enter your **Worker URL** — the base URL of your deployed Cloudflare Worker:
   ```
   https://paygate.<your-subdomain>.workers.dev
   ```

3. Enter your **API Key** — the same value you set as `API_KEY` in Wrangler secrets.

4. Tap **Save & Continue**.

5. **Grant all permissions** when prompted:
   - `RECEIVE_SMS` and `READ_SMS` — required to detect bKash messages
   - `POST_NOTIFICATIONS` — required on Android 13+ for the foreground service notification

6. **Disable battery optimization** for PayGate — this is critical on most Android devices:
   - Go to **Settings → Apps → PayGate SMS → Battery → Unrestricted**
   - On Xiaomi/MIUI: also enable **Autostart** under **Settings → Apps → Manage apps → PayGate SMS → Autostart**
   - On Samsung One UI: disable **Adaptive Battery** restrictions for the app

7. The home screen shows a **green status indicator** when everything is running. The app will now forward every incoming bKash SMS to your Worker automatically.

To update the Worker URL or API Key later: tap the **Settings** (⚙) icon on the home screen.

---

## Backend API Reference

All API endpoints (except `/api/public/submit`) require the header:

```
X-API-Key: YOUR_API_KEY
```

---

### POST `/api/sms/forward`

Receives a forwarded bKash SMS from the Android app. Parses the TrxID and amount, stores the SMS record, and creates a pending transaction.

**Request body:**

```json
{
  "sender": "01769420420",
  "message": "You have received Tk 30.00 from 01XXXXXXXXX. Fee Tk 0.00. Balance Tk 1,294.36. TrxID DDS3M42DR5 at 28/04/2026 21:23",
  "receivedAt": "2026-04-28T21:23:00Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sender` | string | No | Originating number or sender ID |
| `message` | string | **Yes** | Full SMS body text |
| `receivedAt` | string | No | ISO 8601 UTC timestamp — defaults to current time |

**Success response:**

```json
{
  "success": true,
  "smsId": "abc123def456gh",
  "parsed": {
    "trxId": "DDS3M42DR5",
    "amount": 30,
    "senderPhone": "01XXXXXXXXX"
  },
  "message": "SMS recorded. Transaction available for verification."
}
```

**Parse failure response** (SMS saved but TrxID not found):

```json
{
  "success": false,
  "smsId": "abc123def456gh",
  "message": "SMS recorded but could not parse TrxID. Check raw SMS format."
}
```

---

### POST `/api/verify`

Verifies a transaction by TrxID. Marks it as used — cannot be verified again.

**Request body:**

```json
{
  "trxId": "DDS3M42DR5",
  "amount": 30
}
```

**Success response:**

```json
{
  "success": true,
  "valid": true,
  "message": "Transaction verified.",
  "transaction": {
    "trxId": "DDS3M42DR5",
    "amount": 30,
    "senderPhone": "01XXXXXXXXX",
    "status": "verified",
    "verifiedAt": "2026-04-28T21:25:00Z"
  }
}
```

**Failure responses:**

```json
{ "success": false, "valid": false, "message": "Transaction not found. SMS not received yet or TrxID incorrect." }
{ "success": false, "valid": false, "message": "Transaction ID already used." }
{ "success": false, "valid": false, "message": "Amount mismatch. Expected ৳500, got ৳30." }
```

---

### POST `/api/payment/check`

Website integration endpoint. Verifies payment and links it to an order ID.

**Request body:**

```json
{
  "trxId": "DDS3M42DR5",
  "amount": 500,
  "orderId": "ORDER-123",
  "customerPhone": "01XXXXXXXXX"
}
```

**Response:** same structure as `/api/verify` with `orderId` included.

---

### GET `/api/transaction/:trxId`

Fetches the full transaction record without consuming it.

```
GET /api/transaction/DDS3M42DR5
```

---

### GET `/pay/:productId`

Public payment page for customers. No API key required.

```
GET /pay/abc123def4        → fixed price payment page
GET /pay/abc123def4?amount=500  → open price, pre-filled with 500
```

---

### JavaScript Integration Snippet

```html
<script>
async function verifyPayment(trxId, amount) {
  const res = await fetch('https://paygate.<your-subdomain>.workers.dev/api/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'YOUR_API_KEY'
    },
    body: JSON.stringify({ trxId, amount })
  });
  return await res.json();
  // returns: { success, valid, transaction }
}

// Usage
const result = await verifyPayment('DDS3M42DR5', 500);
if (result.success && result.valid) {
  // payment confirmed — proceed with order
} else {
  alert(result.message);
}
</script>
```

---

## Worker KV Data Model

All data is stored in the `PG_KV` namespace using the following key patterns:

| Key Pattern | Value | Description |
|---|---|---|
| `admin:password` | SHA-256 hash string | Hashed admin password |
| `config:brand` | JSON object | Brand name, logo, color, tagline |
| `config:bkash` | JSON object | bKash phone, VAT, account type, enabled flag |
| `sessions:<token>` | `"1"` (TTL 86400s) | Active admin session token |
| `product:<id>` | JSON object | Payment link / product record |
| `products:index` | JSON array of IDs | All product IDs |
| `sms:<id>` | JSON object | Raw SMS record (source of truth) |
| `sms:index` | JSON array of IDs | All SMS IDs in insertion order |
| `txn:<trxId>` | JSON object | Transaction record (created from SMS) |
| `txn:used:<trxId>` | `"1"` | Set when a transaction is consumed/verified |
| `txn:index` | JSON array of TrxIDs | All transaction IDs |

**Transaction record structure:**

```json
{
  "trxId": "DDS3M42DR5",
  "amount": 30.00,
  "senderPhone": "01XXXXXXXXX",
  "status": "received | verified | used",
  "createdAt": "2026-04-28T21:23:00Z",
  "verifiedAt": "2026-04-28T21:25:00Z",
  "smsId": "abc123def456gh",
  "source": "sms_forward | manual",
  "productId": "abc123def4",
  "productName": "Monthly Subscription"
}
```

---

## Permissions

The Android app requests the following permissions:

| Permission | Why it's needed |
|---|---|
| `RECEIVE_SMS` | Trigger `SmsReceiver` the moment a bKash SMS arrives |
| `READ_SMS` | Allow the polling service to query the SMS inbox |
| `INTERNET` | Forward SMS data to the Cloudflare Worker |
| `FOREGROUND_SERVICE` | Run the polling service continuously in the background |
| `FOREGROUND_SERVICE_DATA_SYNC` | Required for foreground service type on Android 14+ |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Prevent OEM ROMs from killing the service |
| `RECEIVE_BOOT_COMPLETED` | Restart the service after device reboot |
| `WAKE_LOCK` | Keep CPU awake during an HTTP forward request |
| `POST_NOTIFICATIONS` | Show the persistent foreground service notification (Android 13+) |

---

## Troubleshooting

**bKash SMS received but not showing in the Worker's SMS log**

- Confirm the app shows a green status on the home screen.
- Go to Settings in the app and verify the Worker URL has no trailing slash (`https://...workers.dev` not `https://...workers.dev/`).
- Verify the API Key in the app matches the `API_KEY` secret in your Worker exactly.
- On Xiaomi / Oppo / Samsung: set battery optimization to **Unrestricted** for PayGate SMS.
- Enable **Autostart** for the app on MIUI and ColorOS.

**Worker returns 401 Unauthorized**

- The `X-API-Key` header value does not match the `API_KEY` secret on the Worker.
- Re-check with `wrangler secret list` and update the app's API Key in Settings.

**TrxID parse fails (SMS saved but no transaction created)**

- Check the raw SMS text in the Admin SMS Log.
- The parser expects the keyword `TrxID` followed by the transaction ID (e.g., `TrxID DDS3M42DR5`).
- If bKash changes their SMS format, use **Manual SMS Entry** as a workaround and open a GitHub issue.

**Payment verification says "Transaction not found"**

- The SMS has not been forwarded yet — the Android app may be offline or battery-restricted.
- Use `/admin/sms/manual` to add the transaction manually.
- Wait a few seconds and retry — the polling service runs every 15 seconds.

**Service stops working after a while**

- Battery optimization is the most common cause on Android 8+.
- Path: **Settings → Apps → PayGate SMS → Battery → Unrestricted**.
- On some Samsung devices, also disable **Sleeping apps** and **Deep sleeping apps** lists.

**Build fails: `flutter doctor` errors**

- Run `flutter doctor --verbose` for detailed output.
- Ensure `JAVA_HOME` points to JDK 17 (`java -version` should show `17.x.x`).
- Ensure Android SDK Build Tools are installed via Android Studio SDK Manager.

---

## License

```
PayGate SMS Forwarder
Copyright (C) 2025  PayGate Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
```
