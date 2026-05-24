# PayGate SMS Forwarder

A Flutter-based Android application that automatically detects incoming bKash SMS notifications and forwards them to a remote HTTP endpoint (e.g., a Cloudflare Worker). Designed for payment monitoring, automated reconciliation, and real-time bKash transaction tracking.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Flutter](https://img.shields.io/badge/Flutter-3.x-blue)](https://flutter.dev)
[![Platform](https://img.shields.io/badge/Platform-Android-green)](https://developer.android.com)

---

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Configure the Backend Endpoint](#2-configure-the-backend-endpoint)
  - [3. Build the App](#3-build-the-app)
  - [4. Install on Device](#4-install-on-device)
  - [5. In-App Setup](#5-in-app-setup)
- [Backend API Contract](#backend-api-contract)
- [Project Structure](#project-structure)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **Real-time SMS forwarding** via `BroadcastReceiver` — fires the moment a bKash SMS arrives
- **Polling fallback** via a foreground `Service` — polls the SMS inbox every 15 seconds to catch any SMS missed by the receiver (e.g., after a reboot)
- **Auto-start on boot** — the polling service restarts automatically after device reboot or app update
- **Smart bKash detection** — identifies bKash SMS by sender number (`01769420420`, `16247`) and message keywords (`TrxID`, `received Tk`, `Cash Out`, etc.)
- **Toggle on/off** from the home screen without uninstalling
- **Settings screen** to update Worker URL and API Key at any time
- **Forward counter and last log** displayed in the UI for quick status checks

---

## How It Works

```
bKash SMS arrives
       │
       ├──► SmsReceiver (BroadcastReceiver)
       │         └── Detects bKash SMS → HTTP POST to Worker URL
       │
       └──► SmsPollingService (Foreground Service, every 15s)
                 └── Reads SMS inbox → Detects new bKash SMS → HTTP POST to Worker URL
```

Both paths forward the same JSON payload to your configured endpoint. The polling service acts as a safety net — Android may delay or drop broadcast intents on some OEM devices (Xiaomi, Oppo, Samsung with aggressive battery management).

---

## Architecture

| Layer | Component | Description |
|---|---|---|
| Flutter UI | `SetupScreen` | First-run configuration wizard |
| Flutter UI | `HomeScreen` | Live status, toggle, forward counter |
| Flutter UI | `SettingsScreen` | Update Worker URL / API Key |
| Android Native | `SmsReceiver.kt` | `BroadcastReceiver` for real-time SMS |
| Android Native | `SmsPollingService.kt` | Foreground service polling SMS inbox |
| Android Native | `BootReceiver.kt` | Restarts service after reboot |
| Android Native | `MainActivity.kt` | Flutter ↔ Kotlin bridge via `MethodChannel` |
| Storage | `FlutterSharedPreferences` | Worker URL, API Key, enable flag, stats |

---

## Prerequisites

Before building, make sure you have the following installed:

| Tool | Version | Install Guide |
|---|---|---|
| Flutter SDK | 3.x or later | https://docs.flutter.dev/get-started/install |
| Dart SDK | Bundled with Flutter | — |
| Android Studio | Latest stable | https://developer.android.com/studio |
| Android SDK | API 21+ (Android 5.0) | Via Android Studio SDK Manager |
| Java JDK | 17 | https://adoptium.net |
| Git | Any recent version | https://git-scm.com |

Verify your Flutter setup before proceeding:

```bash
flutter doctor
```

All items should show a green checkmark. Fix any reported issues before continuing.

---

## Setup Guide

### 1. Clone the Repository

```bash
git clone https://github.com/devfahim00/PayGateApp.git
cd PayGateApp
```

Install Flutter dependencies:

```bash
flutter pub get
```

---

### 2. Configure the Backend Endpoint

PayGate forwards SMS data to an HTTP endpoint of your choice. The simplest option is a **Cloudflare Worker**, but any HTTPS endpoint works.

#### Option A — Cloudflare Worker (recommended)

Create a new Cloudflare Worker and paste the following handler:

```javascript
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const apiKey = request.headers.get('X-API-Key');
    if (apiKey !== env.API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json();
    // body = { sender, message, receivedAt }

    // TODO: store to KV, D1, or forward to your system
    console.log('SMS received:', JSON.stringify(body));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
```

Set an environment variable `API_KEY` in your Worker settings (a long random string, e.g., `openssl rand -hex 32`).

Your Worker URL will look like:
```
https://your-worker-name.your-subdomain.workers.dev
```

#### Option B — Any HTTPS Server

Your server must expose a `POST /api/sms/forward` endpoint. See the [Backend API Contract](#backend-api-contract) section for the expected request format.

---

### 3. Build the App

#### Debug Build (for development/testing)

```bash
flutter build apk --debug
```

Output: `build/app/outputs/flutter-apk/app-debug.apk`

#### Release Build (for production use)

> **Note:** You must sign the APK for release. Follow the steps below to create a signing keystore.

**Step 1 — Create a keystore** (skip if you already have one):

```bash
keytool -genkey -v \
  -keystore ~/paygate-release.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias paygate
```

You will be prompted for a password and some identity information. Keep this file safe — losing it means you cannot update the app.

**Step 2 — Create `android/key.properties`:**

```properties
storePassword=YOUR_STORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=paygate
storeFile=/absolute/path/to/paygate-release.jks
```

**Step 3 — Reference it in `android/app/build.gradle.kts`:**

Add the following before the `android {}` block:

```kotlin
import java.util.Properties
import java.io.FileInputStream

val keyProps = Properties()
val keyPropsFile = rootProject.file("key.properties")
if (keyPropsFile.exists()) {
    keyProps.load(FileInputStream(keyPropsFile))
}
```

Then inside `buildTypes { release { ... } }`:

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

**Step 4 — Build the signed APK:**

```bash
flutter build apk --release
```

Output: `build/app/outputs/flutter-apk/app-release.apk`

---

### 4. Install on Device

Enable **Developer Options** and **USB Debugging** on your Android device, then:

```bash
# Install via USB
flutter install

# Or copy the APK manually
adb install build/app/outputs/flutter-apk/app-release.apk
```

Minimum Android version: **5.0 (API 21)**

---

### 5. In-App Setup

1. **Launch** PayGate SMS on your device.
2. On the **Setup Screen**, enter:
   - **Worker URL** — the base URL of your endpoint (e.g., `https://your-worker.workers.dev`)
   - **API Key** — the secret key configured on your backend
3. Tap **Save & Continue**.
4. **Grant permissions** when prompted:
   - `RECEIVE_SMS` and `READ_SMS` — required to detect and read incoming messages
   - `POST_NOTIFICATIONS` — required on Android 13+ to show the foreground service notification
5. On some devices (Xiaomi, Oppo, Vivo, Samsung), you must also **disable battery optimization** for PayGate:
   - Go to **Settings → Apps → PayGate SMS → Battery → Unrestricted**
6. The app will show a green status indicator and begin forwarding bKash SMS automatically.

To update your Worker URL or API Key later, tap the **Settings** icon on the home screen.

---

## Backend API Contract

PayGate sends an HTTP `POST` request to `{WORKER_URL}/api/sms/forward`.

**Request Headers:**

```
Content-Type: application/json
X-API-Key: <your-api-key>
```

**Request Body:**

```json
{
  "sender": "01769420420",
  "message": "You have received Tk 500.00 from 01XXXXXXXXX. TrxID AB1234567. Balance Tk 1,500.00. bKash your partner.",
  "receivedAt": "2025-05-24T10:30:00Z"
}
```

| Field | Type | Description |
|---|---|---|
| `sender` | `string` | Originating phone number or sender ID |
| `message` | `string` | Full SMS body text |
| `receivedAt` | `string` | ISO 8601 UTC timestamp of when the SMS was received |

**Expected Response:**

Any `2xx` status code is treated as success. Non-2xx causes the app to log a failure in the UI.

---

## Project Structure

```
paygate/
├── lib/
│   └── main.dart                  # All Flutter UI and app logic
├── android/
│   └── app/src/main/
│       ├── AndroidManifest.xml    # Permissions, receivers, service declarations
│       └── kotlin/com/example/paygate/
│           ├── MainActivity.kt        # Flutter ↔ Kotlin MethodChannel bridge
│           ├── SmsReceiver.kt         # BroadcastReceiver for real-time SMS
│           ├── SmsPollingService.kt   # Foreground service, polls every 15s
│           └── BootReceiver.kt        # Restarts service after device reboot
├── test/
│   └── widget_test.dart           # Basic widget smoke test
└── pubspec.yaml                   # Flutter dependencies
```

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `RECEIVE_SMS` | Trigger `SmsReceiver` the moment a new SMS arrives |
| `READ_SMS` | Allow the polling service to read the SMS inbox |
| `INTERNET` | Forward SMS data to the Worker endpoint |
| `FOREGROUND_SERVICE` | Run the polling service in the background |
| `FOREGROUND_SERVICE_DATA_SYNC` | Android 14+ foreground service type requirement |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Keep the service alive on battery-aggressive OEM ROMs |
| `RECEIVE_BOOT_COMPLETED` | Restart the service after device reboot |
| `WAKE_LOCK` | Prevent the CPU from sleeping mid-forward |
| `POST_NOTIFICATIONS` | Show the persistent foreground service notification (Android 13+) |

---

## Troubleshooting

**bKash SMS is received but not forwarded**

- Open the app and confirm the green status is showing.
- Check that **Worker URL** and **API Key** are correctly set in Settings.
- On Xiaomi/Oppo/Samsung: go to `Settings → Apps → PayGate SMS → Battery` and set it to **Unrestricted**. These OEMs aggressively kill background services.
- Confirm `RECEIVE_SMS` permission is granted via `Settings → Apps → PayGate SMS → Permissions`.

**The app says "No permission" even after granting**

- Some devices require restarting the app after granting permissions.
- On Android 13+, `POST_NOTIFICATIONS` must be granted separately — allow it when prompted.

**Forward fails with an error in the log**

- Verify your Worker URL is reachable from the device (open it in a browser).
- Make sure the URL has no trailing slash and the endpoint path is `/api/sms/forward`.
- Double-check the API Key matches exactly what your backend expects.

**Service stops after a while**

- Battery optimization is the most common cause. Disable it for PayGate SMS as described in [Step 5](#5-in-app-setup).
- On some ROMs, you also need to enable **Autostart** permission for the app.

**Build fails with `flutter doctor` errors**

- Run `flutter doctor --verbose` for detailed diagnostics.
- Ensure `JAVA_HOME` points to JDK 17 and the Android SDK is installed via Android Studio.

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
