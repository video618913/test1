package com.example.paygate

import android.app.*
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.*

class SmsPollingService : Service() {

    companion object {
        const val TAG = "PayGatePoller"
        const val CHANNEL_ID = "paygate_foreground"
        const val NOTIF_ID = 1001
        const val PREFS_NAME = "PayGatePrefs"
        const val KEY_WORKER_URL = "worker_url"
        const val KEY_API_KEY = "api_key"
        const val KEY_ENABLED = "sms_forward_enabled"
        const val KEY_FORWARD_COUNT = "forward_count"
        const val KEY_LAST_LOG = "last_log"
        const val KEY_LAST_SMS_DATE = "last_sms_date_polled"
        const val POLL_INTERVAL_MS = 15_000L

        fun start(context: Context) {
            val intent = Intent(context, SmsPollingService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SmsPollingService::class.java))
        }
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var pollingJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIF_ID, buildNotification("SMS Forwarding চলছে..."))
        Log.d(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startPolling()
        return START_STICKY // system restart করলেও service আবার চালু হবে
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        pollingJob?.cancel()
        serviceScope.cancel()
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }

    // ─── Polling Loop ────────────────────────────────────────────────────────

    private fun startPolling() {
        pollingJob?.cancel()
        pollingJob = serviceScope.launch {
            while (isActive) {
                try {
                    pollSmsInbox()
                } catch (e: Exception) {
                    Log.e(TAG, "Poll error: ${e.message}")
                }
                delay(POLL_INTERVAL_MS)
            }
        }
        Log.d(TAG, "Polling started (interval: ${POLL_INTERVAL_MS}ms)")
    }

    private suspend fun pollSmsInbox() {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val enabled = prefs.getBoolean(KEY_ENABLED, true)
        if (!enabled) return

        val workerUrl = prefs.getString(KEY_WORKER_URL, "") ?: ""
        val apiKey = prefs.getString(KEY_API_KEY, "") ?: ""
        if (workerUrl.isEmpty() || apiKey.isEmpty()) return

        // শেষবার কোন সময়ের SMS চেক করেছি
        val lastCheckedDate = prefs.getLong(KEY_LAST_SMS_DATE, System.currentTimeMillis() - 60_000)

        val uri = Uri.parse("content://sms/inbox")
        val cursor: Cursor? = contentResolver.query(
            uri,
            arrayOf("_id", "address", "body", "date"),
            "date > ?",
            arrayOf(lastCheckedDate.toString()),
            "date DESC"
        )

        var forwarded = 0
        var latestDate = lastCheckedDate

        cursor?.use {
            while (it.moveToNext()) {
                val body = it.getString(it.getColumnIndexOrThrow("body")) ?: continue
                val sender = it.getString(it.getColumnIndexOrThrow("address")) ?: "Unknown"
                val date = it.getLong(it.getColumnIndexOrThrow("date"))

                if (date > latestDate) latestDate = date

                if (!isBkashSms(body)) continue

                Log.d(TAG, "Poller found bKash SMS from: $sender")

                val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
                sdf.timeZone = TimeZone.getTimeZone("UTC")
                val receivedAt = sdf.format(Date(date))

                val result = forwardSms(workerUrl, apiKey, sender, body, receivedAt)
                if (result) {
                    forwarded++
                    val count = prefs.getInt(KEY_FORWARD_COUNT, 0)
                    prefs.edit()
                        .putInt(KEY_FORWARD_COUNT, count + 1)
                        .putString(KEY_LAST_LOG,
                            "[${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}] ✅ Polled & Forwarded: ${body.take(50)}...")
                        .apply()
                }
            }
        }

        // পরবর্তী poll এর জন্য timestamp save করো
        if (latestDate > lastCheckedDate) {
            prefs.edit().putLong(KEY_LAST_SMS_DATE, latestDate).apply()
        }

        // Notification update করো
        val notifText = if (forwarded > 0)
            "✅ $forwarded টি নতুন SMS forward করা হয়েছে"
        else
            "SMS Forwarding চলছে... (প্রতি ১৫ সেকেন্ডে check)"

        updateNotification(notifText)
        Log.d(TAG, "Poll done — forwarded: $forwarded")
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

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
        return try {
            val url = baseUrl.trimEnd('/') + "/api/sms/forward"
            val jsonBody = """{"sender":"$sender","message":${escapeJson(message)},"receivedAt":"$receivedAt"}"""

            val conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-API-Key", apiKey)
            conn.doOutput = true
            conn.connectTimeout = 10000
            conn.readTimeout = 10000

            OutputStreamWriter(conn.outputStream).use { w ->
                w.write(jsonBody)
                w.flush()
            }

            val code = conn.responseCode
            Log.d(TAG, "Forward HTTP: $code")
            code in 200..299
        } catch (e: Exception) {
            Log.e(TAG, "Forward error: ${e.message}")
            false
        }
    }

    private fun escapeJson(text: String): String {
        return "\"" + text
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t") + "\""
    }

    // ─── Notification ─────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PayGate SMS Forwarder",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "bKash SMS forwarding service"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PayGate SMS")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }
}
