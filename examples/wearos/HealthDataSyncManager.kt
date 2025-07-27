// WearOS (Android/Kotlin) Integration Example
// This file demonstrates how to integrate the sync server with a WearOS app

package com.example.galaxywatchsync

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
data class HealthRecord(
        val timestamp: Long,
        val value: Double,
        val unit: String? = null,
        val metadata: Map<String, String>? = null,
        val sourceApp: String? = null
)

@Serializable
data class SyncRequest(
        val deviceId: String,
        val deviceName: String,
        val deviceType: String,
        val dataType: String,
        val records: List<HealthRecord>
)

@Serializable
data class SyncResponse(
        val success: Boolean,
        val processed: ProcessedData? = null,
        val errors: List<ErrorInfo>? = null,
        val timestamp: String
)

@Serializable data class ProcessedData(val total: Int, val inserted: Int, val errors: Int)

@Serializable data class ErrorInfo(val index: Int, val error: String)

class HealthDataSyncManager(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client =
            OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .writeTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .build()

    // Server discovery - try multiple common local IP ranges
    private val possibleServerIPs =
            listOf("192.168.1.100", "192.168.0.100", "192.168.1.101", "10.0.0.100", "172.16.0.100")
    private val serverPort = 3000
    private var discoveredServerUrl: String? = null

    // Device identification
    private val deviceId =
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    private val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}"

    /** Discover the local sync server by trying common IP addresses */
    suspend fun discoverServer(): String? =
            withContext(Dispatchers.IO) {
                if (discoveredServerUrl != null) return@withContext discoveredServerUrl

                for (ip in possibleServerIPs) {
                    val testUrl = "http://$ip:$serverPort"
                    try {
                        val request = Request.Builder().url("$testUrl/health").get().build()

                        client.newCall(request).execute().use { response ->
                            if (response.isSuccessful) {
                                discoveredServerUrl = testUrl
                                Log.i("HealthSync", "Discovered server at: $testUrl")
                                return@withContext testUrl
                            }
                        }
                    } catch (e: Exception) {
                        Log.d("HealthSync", "Server not found at $testUrl: ${e.message}")
                    }
                }

                Log.w("HealthSync", "No local server discovered")
                null
            }

    /** Register this device with the sync server */
    suspend fun registerDevice(): Boolean =
            withContext(Dispatchers.IO) {
                val serverUrl = discoverServer() ?: return@withContext false

                try {
                    val registrationData =
                            mapOf(
                                    "deviceId" to deviceId,
                                    "deviceName" to deviceName,
                                    "deviceType" to "wearos",
                                    "metadata" to
                                            mapOf(
                                                    "manufacturer" to Build.MANUFACTURER,
                                                    "model" to Build.MODEL,
                                                    "androidVersion" to Build.VERSION.RELEASE,
                                                    "appVersion" to BuildConfig.VERSION_NAME
                                            )
                            )

                    val json = Json.encodeToString(registrationData)
                    val request =
                            Request.Builder()
                                    .url("$serverUrl/api/v1/sync/register")
                                    .post(json.toRequestBody("application/json".toMediaType()))
                                    .build()

                    client.newCall(request).execute().use { response ->
                        if (response.isSuccessful) {
                            Log.i("HealthSync", "Device registered successfully")
                            return@withContext true
                        } else {
                            Log.e("HealthSync", "Registration failed: ${response.code}")
                            return@withContext false
                        }
                    }
                } catch (e: Exception) {
                    Log.e("HealthSync", "Registration error", e)
                    false
                }
            }

    /** Sync heart rate data to the server */
    suspend fun syncHeartRateData(heartRateRecords: List<HeartRateRecord>): SyncResult =
            withContext(Dispatchers.IO) {
                val serverUrl = discoverServer() ?: return@withContext SyncResult.ServerNotFound

                if (!isNetworkAvailable()) {
                    Log.i("HealthSync", "Network unavailable, falling back to Bluetooth")
                    return@withContext syncViaBluetooth(heartRateRecords)
                }

                try {
                    val healthRecords =
                            heartRateRecords.map { record ->
                                HealthRecord(
                                        timestamp = record.timestamp,
                                        value = record.beatsPerMinute.toDouble(),
                                        unit = "bpm",
                                        metadata =
                                                mapOf(
                                                        "accuracy" to record.accuracy.toString(),
                                                        "source" to "samsung_health"
                                                ),
                                        sourceApp = "com.samsung.android.app.health"
                                )
                            }

                    val syncRequest =
                            SyncRequest(
                                    deviceId = deviceId,
                                    deviceName = deviceName,
                                    deviceType = "wearos",
                                    dataType = "heart_rate",
                                    records = healthRecords
                            )

                    val requestJson = json.encodeToString(syncRequest)
                    val request =
                            Request.Builder()
                                    .url("$serverUrl/api/v1/health-data")
                                    .post(
                                            requestJson.toRequestBody(
                                                    "application/json".toMediaType()
                                            )
                                    )
                                    .build()

                    client.newCall(request).execute().use { response ->
                        val responseBody = response.body?.string()

                        if (response.isSuccessful && responseBody != null) {
                            val syncResponse = json.decodeFromString<SyncResponse>(responseBody)
                            Log.i(
                                    "HealthSync",
                                    "Sync successful: ${syncResponse.processed?.inserted} records"
                            )

                            // Update last sync timestamp
                            updateLastSyncTimestamp(System.currentTimeMillis())

                            return@withContext SyncResult.Success(
                                    syncResponse.processed?.inserted ?: 0
                            )
                        } else {
                            Log.e("HealthSync", "Sync failed: ${response.code} - $responseBody")
                            return@withContext SyncResult.HttpError(response.code)
                        }
                    }
                } catch (e: Exception) {
                    Log.e("HealthSync", "Sync error", e)
                    SyncResult.NetworkError(e)
                }
            }

    /** Sync step count data */
    suspend fun syncStepData(stepRecords: List<StepRecord>): SyncResult =
            withContext(Dispatchers.IO) {
                val serverUrl = discoverServer() ?: return@withContext SyncResult.ServerNotFound

                try {
                    val healthRecords =
                            stepRecords.map { record ->
                                HealthRecord(
                                        timestamp = record.timestamp,
                                        value = record.steps.toDouble(),
                                        unit = "steps",
                                        metadata =
                                                mapOf(
                                                        "duration_minutes" to
                                                                record.durationMinutes.toString(),
                                                        "source" to "samsung_health"
                                                )
                                )
                            }

                    val syncRequest =
                            SyncRequest(
                                    deviceId = deviceId,
                                    deviceName = deviceName,
                                    deviceType = "wearos",
                                    dataType = "steps",
                                    records = healthRecords
                            )

                    val requestJson = json.encodeToString(syncRequest)
                    val request =
                            Request.Builder()
                                    .url("$serverUrl/api/v1/health-data")
                                    .post(
                                            requestJson.toRequestBody(
                                                    "application/json".toMediaType()
                                            )
                                    )
                                    .build()

                    client.newCall(request).execute().use { response ->
                        val responseBody = response.body?.string()

                        if (response.isSuccessful && responseBody != null) {
                            val syncResponse = json.decodeFromString<SyncResponse>(responseBody)
                            updateLastSyncTimestamp(System.currentTimeMillis())
                            return@withContext SyncResult.Success(
                                    syncResponse.processed?.inserted ?: 0
                            )
                        } else {
                            return@withContext SyncResult.HttpError(response.code)
                        }
                    }
                } catch (e: Exception) {
                    Log.e("HealthSync", "Step sync error", e)
                    SyncResult.NetworkError(e)
                }
            }

    /**
     * Fallback Bluetooth sync (placeholder implementation) In a real implementation, this would use
     * BLE to discover and connect to the server
     */
    private suspend fun syncViaBluetooth(records: List<Any>): SyncResult {
        Log.i("HealthSync", "Bluetooth sync not yet implemented")
        // TODO: Implement Bluetooth LE sync
        // 1. Scan for the server's BLE advertisement
        // 2. Connect to the custom health data service
        // 3. Write data to characteristics in chunks
        // 4. Handle acknowledgments
        return SyncResult.BluetoothNotImplemented
    }

    /** Check network connectivity */
    private fun isNetworkAvailable(): Boolean {
        val connectivityManager =
                context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return false
        val networkCapabilities =
                connectivityManager.getNetworkCapabilities(network) ?: return false
        return networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Store the last successful sync timestamp */
    private fun updateLastSyncTimestamp(timestamp: Long) {
        val prefs = context.getSharedPreferences("health_sync", Context.MODE_PRIVATE)
        prefs.edit().putLong("last_sync_timestamp", timestamp).apply()
    }

    /** Get the last successful sync timestamp */
    fun getLastSyncTimestamp(): Long {
        val prefs = context.getSharedPreferences("health_sync", Context.MODE_PRIVATE)
        return prefs.getLong("last_sync_timestamp", 0)
    }
}

/** Sync operation results */
sealed class SyncResult {
    data class Success(val recordsSynced: Int) : SyncResult()
    data class HttpError(val code: Int) : SyncResult()
    data class NetworkError(val exception: Exception) : SyncResult()
    object ServerNotFound : SyncResult()
    object BluetoothNotImplemented : SyncResult()
}

/** Sample data classes (replace with your actual health data models) */
data class HeartRateRecord(val timestamp: Long, val beatsPerMinute: Int, val accuracy: String)

data class StepRecord(val timestamp: Long, val steps: Int, val durationMinutes: Int)

/** Usage example in an Activity or Service */
class HealthSyncService : Service() {
    private lateinit var syncManager: HealthDataSyncManager

    override fun onCreate() {
        super.onCreate()
        syncManager = HealthDataSyncManager(this)
    }

    fun startSync() {
        CoroutineScope(Dispatchers.IO).launch {
            // Register device first
            if (!syncManager.registerDevice()) {
                Log.e("HealthSync", "Failed to register device")
                return@launch
            }

            // Get sample heart rate data (replace with actual data fetching)
            val heartRateData =
                    listOf(
                            HeartRateRecord(System.currentTimeMillis() - 3600000, 72, "high"),
                            HeartRateRecord(System.currentTimeMillis() - 1800000, 85, "high"),
                            HeartRateRecord(System.currentTimeMillis(), 68, "high")
                    )

            // Sync the data
            when (val result = syncManager.syncHeartRateData(heartRateData)) {
                is SyncResult.Success -> {
                    Log.i("HealthSync", "Synced ${result.recordsSynced} heart rate records")
                }
                is SyncResult.HttpError -> {
                    Log.e("HealthSync", "HTTP error: ${result.code}")
                }
                is SyncResult.NetworkError -> {
                    Log.e("HealthSync", "Network error", result.exception)
                }
                SyncResult.ServerNotFound -> {
                    Log.e("HealthSync", "Server not found on local network")
                }
                SyncResult.BluetoothNotImplemented -> {
                    Log.w("HealthSync", "Bluetooth fallback not implemented")
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
