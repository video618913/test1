package com.paygate.f

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Log.d("PayGateBoot", "Boot/update completed — starting polling service")
            // Phone restart বা app update এর পর Foreground Service চালু করো
            SmsPollingService.start(context)
        }
    }
}
