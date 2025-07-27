// iOS (Swift) Integration Example
// This file demonstrates how to integrate the sync server with an iOS app

import Foundation
import HealthKit
import Network

// MARK: - Data Models

struct HealthRecord: Codable {
    let timestamp: Int64
    let value: Double
    let unit: String?
    let metadata: [String: String]?
    let sourceApp: String?
}

struct SyncRequest: Codable {
    let deviceId: String
    let deviceName: String
    let deviceType: String
    let dataType: String
    let records: [HealthRecord]
}

struct SyncDataResponse: Codable {
    let success: Bool
    let data: [HealthDataRecord]
    let pagination: PaginationInfo
    let lastSyncTimestamp: Int64
    let timestamp: String
}

struct HealthDataRecord: Codable {
    let deviceId: String
    let dataType: String
    let timestamp: Int64
    let value: Double
    let unit: String?
    let metadata: [String: String]?
    let sourceApp: String?
}

struct PaginationInfo: Codable {
    let total: Int
    let limit: Int
    let offset: Int
    let hasMore: Bool
}

struct DeviceRegistration: Codable {
    let deviceId: String
    let deviceName: String
    let deviceType: String
    let metadata: [String: String]
}

// MARK: - Main Sync Manager

class HealthDataSyncManager: NSObject {
    
    // MARK: - Properties
    
    private let healthStore = HKHealthStore()
    private let session = URLSession.shared
    private let networkMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "NetworkMonitor")
    
    // Server discovery
    private let possibleServerIPs = [
        "192.168.1.100", "192.168.0.100", "192.168.1.101",
        "10.0.0.100", "172.16.0.100"
    ]
    private let serverPort = 3000
    private var discoveredServerURL: String?
    
    // Device identification
    private lazy var deviceId: String = {
        return UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
    }()
    
    private lazy var deviceName: String = {
        return UIDevice.current.name
    }()
    
    private var isNetworkAvailable = true
    
    // MARK: - Initialization
    
    override init() {
        super.init()
        setupNetworkMonitoring()
        requestHealthKitPermissions()
    }
    
    // MARK: - Network Monitoring
    
    private func setupNetworkMonitoring() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            self?.isNetworkAvailable = path.status == .satisfied
            print("Network status: \(path.status)")
        }
        networkMonitor.start(queue: monitorQueue)
    }
    
    // MARK: - HealthKit Setup
    
    private func requestHealthKitPermissions() {
        guard HKHealthStore.isHealthDataAvailable() else {
            print("HealthKit not available")
            return
        }
        
        let readTypes: Set<HKObjectType> = [
            HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            HKQuantityType.quantityType(forIdentifier: .stepCount)!,
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
        ]
        
        let writeTypes: Set<HKSampleType> = [
            HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            HKQuantityType.quantityType(forIdentifier: .stepCount)!,
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
        ]
        
        healthStore.requestAuthorization(toShare: writeTypes, read: readTypes) { success, error in
            if let error = error {
                print("HealthKit authorization error: \(error)")
            } else {
                print("HealthKit authorization: \(success)")
            }
        }
    }
    
    // MARK: - Server Discovery
    
    func discoverServer() async -> String? {
        if let discoveredURL = discoveredServerURL {
            return discoveredURL
        }
        
        for ip in possibleServerIPs {
            let testURL = "http://\(ip):\(serverPort)"
            
            do {
                let url = URL(string: "\(testURL)/health")!
                let (_, response) = try await session.data(from: url)
                
                if let httpResponse = response as? HTTPURLResponse,
                   httpResponse.statusCode == 200 {
                    discoveredServerURL = testURL
                    print("Discovered server at: \(testURL)")
                    return testURL
                }
            } catch {
                print("Server not found at \(testURL): \(error)")
            }
        }
        
        print("No local server discovered")
        return nil
    }
    
    // MARK: - Device Registration
    
    func registerDevice() async -> Bool {
        guard let serverURL = await discoverServer() else { return false }
        
        let registration = DeviceRegistration(
            deviceId: deviceId,
            deviceName: deviceName,
            deviceType: "ios",
            metadata: [
                "model": UIDevice.current.model,
                "systemName": UIDevice.current.systemName,
                "systemVersion": UIDevice.current.systemVersion,
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
            ]
        )
        
        do {
            let url = URL(string: "\(serverURL)/api/v1/sync/register")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(registration)
            
            let (_, response) = try await session.data(for: request)
            
            if let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode == 200 || httpResponse.statusCode == 201 {
                print("Device registered successfully")
                return true
            } else {
                print("Registration failed")
                return false
            }
        } catch {
            print("Registration error: \(error)")
            return false
        }
    }
    
    // MARK: - Data Sync from Server
    
    func syncDataFromServer() async -> SyncResult {
        guard let serverURL = await discoverServer() else {
            return .serverNotFound
        }
        
        guard isNetworkAvailable else {
            print("Network unavailable, attempting Bluetooth sync")
            return await syncViaBluetooth()
        }
        
        do {
            let lastSyncTimestamp = getLastSyncTimestamp()
            let url = URL(string: "\(serverURL)/api/v1/sync/data/\(deviceId)?since=\(lastSyncTimestamp)")!
            
            let (data, response) = try await session.data(from: url)
            
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                return .httpError(httpResponse?.statusCode ?? 0)
            }
            
            let syncResponse = try JSONDecoder().decode(SyncDataResponse.self, from: data)
            
            // Process and save health data to HealthKit
            let savedCount = await saveHealthDataToHealthKit(syncResponse.data)
            
            // Update last sync timestamp
            updateLastSyncTimestamp(syncResponse.lastSyncTimestamp)
            
            print("Synced \(savedCount) records from server")
            return .success(savedCount)
            
        } catch {
            print("Sync error: \(error)")
            return .networkError(error)
        }
    }
    
    // MARK: - Save to HealthKit
    
    private func saveHealthDataToHealthKit(_ records: [HealthDataRecord]) async -> Int {
        var savedCount = 0
        
        for record in records {
            do {
                let sample = try createHealthKitSample(from: record)
                try await saveToHealthKit(sample)
                savedCount += 1
            } catch {
                print("Failed to save record: \(error)")
            }
        }
        
        return savedCount
    }
    
    private func createHealthKitSample(from record: HealthDataRecord) throws -> HKSample {
        let date = Date(timeIntervalSince1970: TimeInterval(record.timestamp / 1000))
        
        switch record.dataType {
        case "heart_rate":
            let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate)!
            let heartRateUnit = HKUnit(from: "count/min")
            let quantity = HKQuantity(unit: heartRateUnit, doubleValue: record.value)
            
            return HKQuantitySample(
                type: heartRateType,
                quantity: quantity,
                start: date,
                end: date,
                metadata: convertMetadata(record.metadata)
            )
            
        case "steps":
            let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount)!
            let stepUnit = HKUnit.count()
            let quantity = HKQuantity(unit: stepUnit, doubleValue: record.value)
            
            return HKQuantitySample(
                type: stepType,
                quantity: quantity,
                start: date,
                end: date,
                metadata: convertMetadata(record.metadata)
            )
            
        case "distance":
            let distanceType = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!
            let distanceUnit = HKUnit.meter()
            let quantity = HKQuantity(unit: distanceUnit, doubleValue: record.value)
            
            return HKQuantitySample(
                type: distanceType,
                quantity: quantity,
                start: date,
                end: date,
                metadata: convertMetadata(record.metadata)
            )
            
        case "calories_burned":
            let calorieType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!
            let calorieUnit = HKUnit.kilocalorie()
            let quantity = HKQuantity(unit: calorieUnit, doubleValue: record.value)
            
            return HKQuantitySample(
                type: calorieType,
                quantity: quantity,
                start: date,
                end: date,
                metadata: convertMetadata(record.metadata)
            )
            
        case "sleep":
            let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!
            let endDate = date.addingTimeInterval(TimeInterval(record.value * 60)) // value in minutes
            
            return HKCategorySample(
                type: sleepType,
                value: HKCategoryValueSleepAnalysis.asleep.rawValue,
                start: date,
                end: endDate,
                metadata: convertMetadata(record.metadata)
            )
            
        default:
            throw SyncError.unsupportedDataType(record.dataType)
        }
    }
    
    private func convertMetadata(_ metadata: [String: String]?) -> [String: Any]? {
        guard let metadata = metadata else { return nil }
        
        var hkMetadata: [String: Any] = [:]
        hkMetadata[HKMetadataKeyExternalUUID] = UUID().uuidString
        
        // Add custom metadata
        for (key, value) in metadata {
            hkMetadata["GalaxyWatch_\(key)"] = value
        }
        
        return hkMetadata
    }
    
    private func saveToHealthKit(_ sample: HKSample) async throws {
        return try await withCheckedThrowingContinuation { continuation in
            healthStore.save(sample) { success, error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
    
    // MARK: - Bluetooth Fallback
    
    private func syncViaBluetooth() async -> SyncResult {
        print("Bluetooth sync not yet implemented")
        // TODO: Implement Bluetooth LE sync
        // 1. Scan for the server's BLE service
        // 2. Connect and subscribe to characteristics
        // 3. Read health data from characteristics
        // 4. Save to HealthKit
        return .bluetoothNotImplemented
    }
    
    // MARK: - Timestamp Management
    
    private func getLastSyncTimestamp() -> Int64 {
        return UserDefaults.standard.object(forKey: "lastSyncTimestamp") as? Int64 ?? 0
    }
    
    private func updateLastSyncTimestamp(_ timestamp: Int64) {
        UserDefaults.standard.set(timestamp, forKey: "lastSyncTimestamp")
    }
    
    // MARK: - Periodic Sync
    
    func startPeriodicSync(interval: TimeInterval = 300) { // 5 minutes default
        Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in
            Task {
                _ = await self.syncDataFromServer()
            }
        }
    }
}

// MARK: - Supporting Types

enum SyncResult {
    case success(Int)
    case httpError(Int)
    case networkError(Error)
    case serverNotFound
    case bluetoothNotImplemented
}

enum SyncError: Error {
    case unsupportedDataType(String)
    case healthKitNotAvailable
    case permissionDenied
}

// MARK: - Usage Example

class ViewController: UIViewController {
    private let syncManager = HealthDataSyncManager()
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
    }
    
    private func setupUI() {
        // Create sync button
        let syncButton = UIButton(type: .system)
        syncButton.setTitle("Sync Health Data", for: .normal)
        syncButton.addTarget(self, action: #selector(syncButtonTapped), for: .touchUpInside)
        
        // Add to view and set constraints
        view.addSubview(syncButton)
        syncButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            syncButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            syncButton.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }
    
    @objc private func syncButtonTapped() {
        Task {
            // Register device first
            let registered = await syncManager.registerDevice()
            guard registered else {
                showAlert(title: "Error", message: "Failed to register device")
                return
            }
            
            // Perform sync
            let result = await syncManager.syncDataFromServer()
            
            DispatchQueue.main.async {
                switch result {
                case .success(let count):
                    self.showAlert(title: "Success", message: "Synced \(count) health records")
                case .serverNotFound:
                    self.showAlert(title: "Error", message: "Server not found on local network")
                case .httpError(let code):
                    self.showAlert(title: "Error", message: "HTTP error: \(code)")
                case .networkError(let error):
                    self.showAlert(title: "Error", message: "Network error: \(error.localizedDescription)")
                case .bluetoothNotImplemented:
                    self.showAlert(title: "Info", message: "Bluetooth sync not yet implemented")
                }
            }
        }
    }
    
    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

// MARK: - App Delegate Integration

class AppDelegate: UIResponder, UIApplicationDelegate {
    private let syncManager = HealthDataSyncManager()
    
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        
        // Start periodic sync in background
        syncManager.startPeriodicSync(interval: 300) // 5 minutes
        
        return true
    }
    
    func applicationDidEnterBackground(_ application: UIApplication) {
        // Schedule background sync if needed
        let identifier = "com.yourapp.healthsync"
        let request = UNNotificationRequest(
            identifier: identifier,
            content: UNMutableNotificationContent(),
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: true) // 1 hour
        )
        
        UNUserNotificationCenter.current().add(request)
    }
}
