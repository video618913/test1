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
        // Flutter shared_preferences uses FlutterSharedPreferences file with "flutter." prefix
        const val PREFS_NAME = "FlutterSharedPreferences"
        const val KEY_WORKER_URL = "flutter.worker_url"
        const val KEY_API_KEY = "flutter.api_key"
        const val KEY_ENABLED = "flutter.sms_forward_enabled"
        const val KEY_FORWARD_COUNT = "flutter.forward_count"
        const val KEY_LAST_LOG = "flutter.last_log"
        // Internal tracking key — no flutter. prefix (not a Flutter pref)
        const val KEY_LAST_SMS_DATE = "last_sms_date_polled"
        const val PREFS_INTERNAL = "PayGateInternal"
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
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        pollingJob?.cancel()
        serviceScope.cancel()
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }

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
        val flutterPrefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val internalPrefs = getSharedPreferences(PREFS_INTERNAL, Context.MODE_PRIVATE)

        val enabled = flutterPrefs.getBoolean(KEY_ENABLED, true)
        if (!enabled) return

        val workerUrl = flutterPrefs.getString(KEY_WORKER_URL, "") ?: ""
        val apiKey = flutterPrefs.getString(KEY_API_KEY, "") ?: ""
        if (workerUrl.isEmpty() || apiKey.isEmpty()) return

        // Use internal prefs for polling state (not Flutter prefs)
        val lastCheckedDate = internalPrefs.getLong(KEY_LAST_SMS_DATE, System.currentTimeMillis() - 60_000)

        val uri = Uri.parse("content://sms/inbox")
        val cursor: Cursor? = contentResolver.query(
            uri,
            arrayOf("_id", "address", "body", "date"),
            "date > ?",
            arrayOf(lastCheckedDate.toString()),
            "date ASC"  // ASC so we process oldest first
        )

        var forwarded = 0
        var latestDate = lastCheckedDate

        cursor?.use {
            while (it.moveToNext()) {
                val body = it.getString(it.getColumnIndexOrThrow("body")) ?: continue
                val sender = it.getString(it.getColumnIndexOrThrow("address")) ?: "Unknown"
                val date = it.getLong(it.getColumnIndexOrThrow("date"))

                // Track latest date regardless of whether it's bKash
                if (date > latestDate) latestDate = date

                if (!isBkashSms(sender, body)) continue

                Log.d(TAG, "Poller found bKash SMS from: $sender")

                val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
                sdf.timeZone = TimeZone.getTimeZone("UTC")
                val receivedAt = sdf.format(Date(date))

                val result = forwardSms(workerUrl, apiKey, sender, body, receivedAt)
                if (result) {
                    forwarded++
                    val count = flutterPrefs.getInt(KEY_FORWARD_COUNT, 0)
                    flutterPrefs.edit()
                        .putInt(KEY_FORWARD_COUNT, count + 1)
                        .putString(KEY_LAST_LOG,
                            "[${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())}] ✅ Polled & Forwarded: ${body.take(50)}...")
                        .apply()
                }
            }
        }

        // Always advance the pointer to avoid re-processing same SMS
        if (latestDate > lastCheckedDate) {
            internalPrefs.edit().putLong(KEY_LAST_SMS_DATE, latestDate + 1).apply()
        }

        val notifText = if (forwarded > 0)
            "✅ $forwarded টি নতুন SMS forward করা হয়েছে"
        else
            "SMS Forwarding চলছে... (প্রতি ১৫ সেকেন্ডে check)"

        updateNotification(notifText)
        Log.d(TAG, "Poll done — forwarded: $forwarded")
    }

    private fun isBkashSms(sender: String, body: String): Boolean {
        val lowerBody = body.lowercase()
        val lowerSender = sender.lowercase()

        val isBkashSender = lowerSender.contains("bkash") ||
                            lowerSender == "01769-420420" ||
                            lowerSender == "01769420420" ||
                            lowerSender == "16247"

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
