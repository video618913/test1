package com.paygate.f

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
        // Flutter shared_preferences uses FlutterSharedPreferences file with "flutter." prefix
        const val PREFS_NAME = "FlutterSharedPreferences"
        const val KEY_WORKER_URL = "flutter.worker_url"
        const val KEY_API_KEY = "flutter.api_key"
        const val KEY_ENABLED = "flutter.sms_forward_enabled"
        const val KEY_FORWARD_COUNT = "flutter.forward_count"
        const val KEY_LAST_LOG = "flutter.last_log"
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

        if (!isBkashSms(sender, fullBody)) {
            Log.d(TAG, "Not a bKash SMS, skipping")
            return
        }

        Log.d(TAG, "bKash SMS detected, forwarding...")

        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        val receivedAt = sdf.format(Date())

        val pendingResult = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val result = forwardSms(workerUrl, apiKey, sender, fullBody, receivedAt)
                val logMsg = if (result) "✅ Forwarded: ${fullBody.take(50)}..."
                             else "❌ Forward failed: ${fullBody.take(50)}..."

                val count = prefs.getInt(KEY_FORWARD_COUNT, 0)
                prefs.edit()
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
                pendingResult.finish()
            }
        }
    }

    private fun isBkashSms(sender: String, body: String): Boolean {
        val lowerBody = body.lowercase()
        val lowerSender = sender.lowercase()

        // bKash official sender numbers/names
        val isBkashSender = lowerSender.contains("bkash") ||
                            lowerSender == "01769-420420" ||
                            lowerSender == "01769420420" ||
                            lowerSender == "16247"

        // bKash SMS keywords — TrxID (not TrkID!)
        val hasTrxId = lowerBody.contains("trxid") || lowerBody.contains("trx id")
        val hasBkashKeyword = lowerBody.contains("bkash") ||
                              lowerBody.contains("received tk") ||
                              lowerBody.contains("sent tk") ||
                              lowerBody.contains("payment") ||
                              lowerBody.contains("cash out")

        return isBkashSender || (hasTrxId && hasBkashKeyword)
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

        OutputStreamWriter(conn.outputStream).use { w ->
            w.write(jsonBody)
            w.flush()
        }

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
