package com.example.paygate

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import kotlinx.coroutines.*
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.*

class SmsReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "PayGateSMS"
        const val PREFS_NAME = "PayGatePrefs"
        const val KEY_WORKER_URL = "worker_url"
        const val KEY_API_KEY = "api_key"
        const val KEY_ENABLED = "sms_forward_enabled"
        const val KEY_LAST_SMS = "last_sms"
        const val KEY_FORWARD_COUNT = "forward_count"
        const val KEY_LAST_LOG = "last_log"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val enabled = prefs.getBoolean(KEY_ENABLED, true)
        if (!enabled) return

        val workerUrl = prefs.getString(KEY_WORKER_URL, "") ?: ""
        val apiKey = prefs.getString(KEY_API_KEY, "") ?: ""

        if (workerUrl.isEmpty() || apiKey.isEmpty()) {
            Log.w(TAG, "Worker URL or API key not configured")
            return
        }

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        val fullBody = messages.joinToString("") { it.messageBody }
        val sender = messages.firstOrNull()?.originatingAddress ?: "Unknown"

        Log.d(TAG, "SMS received from: $sender")
        Log.d(TAG, "Body: $fullBody")

        if (!isBkashSms(fullBody)) {
            Log.d(TAG, "Not a bKash SMS, skipping")
            return
        }

        Log.d(TAG, "bKash SMS detected, forwarding...")

        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        val receivedAt = sdf.format(Date())

        // goAsync() — Android কে বলে onReceive শেষ হলেও process kill করো না
        val pendingResult = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = forwardSms(workerUrl, apiKey, sender, fullBody, receivedAt)
                val logMsg = if (result) "✅ Forwarded: ${fullBody.take(50)}..."
                             else "❌ Forward failed: ${fullBody.take(50)}..."

                val count = prefs.getInt(KEY_FORWARD_COUNT, 0)
                prefs.edit()
                    .putString(KEY_LAST_SMS, fullBody)
                    .putInt(KEY_FORWARD_COUNT, if (result) count + 1 else count)
                    .putString(KEY_LAST_LOG, "[${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}] $logMsg")
                    .apply()

                Log.d(TAG, logMsg)
            } catch (e: Exception) {
                Log.e(TAG, "Error forwarding SMS: ${e.message}")
                prefs.edit()
                    .putString(KEY_LAST_LOG, "[${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}] ❌ Error: ${e.message}")
                    .apply()
            } finally {
                pendingResult.finish() // process কে release করো
            }
        }
    }

    private fun isBkashSms(body: String): Boolean {
        val lower = body.lowercase()
        return (lower.contains("trkid") || lower.contains("trxid")) &&
               (lower.contains("tk ") || lower.contains("bkash") || lower.contains("received"))
    }

    private fun forwardSms(
        baseUrl: String,
        apiKey: String,
        sender: String,
        message: String,
        receivedAt: String
    ): Boolean {
        val url = baseUrl.trimEnd('/') + "/api/sms/forward"
        val jsonBody = """{"sender":"$sender","message":${escapeJson(message)},"receivedAt":"$receivedAt"}"""

        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("X-API-Key", apiKey)
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 15000

        val writer = OutputStreamWriter(conn.outputStream)
        writer.write(jsonBody)
        writer.flush()
        writer.close()

        val responseCode = conn.responseCode
        Log.d(TAG, "HTTP Response: $responseCode")
        return responseCode in 200..299
    }

    private fun escapeJson(text: String): String {
        return "\"" + text
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t") + "\""
    }
}
