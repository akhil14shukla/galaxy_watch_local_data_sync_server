const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');
const config = require('../config/config');

let db = null;

// Ensure data directory exists
function ensureDataDirectory() {
    const dataDir = path.dirname(config.database.path);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        logger.info(`Created data directory: ${dataDir}`);
    }
}

// Initialize database connection
function initDatabase() {
    return new Promise((resolve, reject) => {
        try {
            ensureDataDirectory();

            db = new sqlite3.Database(config.database.path, (err) => {
                if (err) {
                    logger.error('Failed to connect to database:', err);
                    return reject(err);
                }

                logger.info(`Connected to SQLite database: ${config.database.path}`);
                
                // Set pragma options
                const pragmaQueries = [
                    'PRAGMA journal_mode = WAL',
                    'PRAGMA foreign_keys = ON',
                    'PRAGMA synchronous = NORMAL',
                    'PRAGMA cache_size = -64000', // 64MB
                    'PRAGMA temp_store = MEMORY',
                    'PRAGMA busy_timeout = 30000'
                ];

                const setPragmas = () => {
                    return Promise.all(
                        pragmaQueries.map(query => 
                            new Promise((resolveQuery, rejectQuery) => {
                                db.run(query, (err) => {
                                    if (err) rejectQuery(err);
                                    else resolveQuery();
                                });
                            })
                        )
                    );
                };

                setPragmas()
                    .then(() => createTables())
                    .then(() => {
                        logger.info('Database initialization completed successfully');
                        resolve(db);
                    })
                    .catch(reject);
            });

        } catch (error) {
            logger.error('Database initialization error:', error);
            reject(error);
        }
    });
}

// Create database tables
function createTables() {
    return new Promise((resolve, reject) => {
        const queries = [
            // Devices table - track registered devices
            `CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('wearos', 'ios')),
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_sync_timestamp BIGINT DEFAULT 0,
                is_active BOOLEAN DEFAULT 1,
                metadata JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,

            // Health data table - store all health metrics
            `CREATE TABLE IF NOT EXISTS health_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                data_type TEXT NOT NULL,
                timestamp BIGINT NOT NULL,
                value REAL,
                unit TEXT,
                metadata JSON,
                source_app TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
            )`,

            // Sync sessions table - track sync operations
            `CREATE TABLE IF NOT EXISTS sync_sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                sync_type TEXT NOT NULL CHECK (sync_type IN ('http', 'bluetooth')),
                status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
                records_synced INTEGER DEFAULT 0,
                start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                end_time DATETIME,
                error_message TEXT,
                metadata JSON,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
            )`,

            // Bluetooth sessions table - track BLE connections
            `CREATE TABLE IF NOT EXISTS bluetooth_sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                device_address TEXT,
                connection_status TEXT CHECK (connection_status IN ('connecting', 'connected', 'disconnected', 'failed')),
                start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                end_time DATETIME,
                data_transferred INTEGER DEFAULT 0,
                error_message TEXT,
                metadata JSON
            )`,

            // Device settings table - store device-specific settings including health goals
            `CREATE TABLE IF NOT EXISTS device_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                setting_type TEXT NOT NULL,
                setting_value TEXT NOT NULL,
                updated_at BIGINT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
                UNIQUE(device_id, setting_type)
            )`
        ];

        const indexes = [
            // Performance indexes
            'CREATE INDEX IF NOT EXISTS idx_health_data_device_timestamp ON health_data (device_id, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_health_data_type_timestamp ON health_data (data_type, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_devices_last_sync ON devices (last_sync_timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_sync_sessions_device_time ON sync_sessions (device_id, start_time)',
            'CREATE INDEX IF NOT EXISTS idx_bluetooth_sessions_device ON bluetooth_sessions (device_id, start_time)',
            'CREATE INDEX IF NOT EXISTS idx_device_settings_device_type ON device_settings (device_id, setting_type)'
        ];

        // Create triggers for updated_at timestamp
        const triggers = [
            `CREATE TRIGGER IF NOT EXISTS update_devices_timestamp 
             AFTER UPDATE ON devices
             BEGIN
                 UPDATE devices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
             END`
        ];

        // Execute queries sequentially to ensure proper order
        const executeSequentially = async (queryList, description) => {
            for (const query of queryList) {
                await new Promise((resolveQuery, rejectQuery) => {
                    db.run(query, (err) => {
                        if (err) {
                            logger.error(`Failed to execute ${description}: ${query}`, err);
                            rejectQuery(err);
                        } else {
                            resolveQuery();
                        }
                    });
                });
            }
        };

        // Execute all query groups in sequence
        (async () => {
            try {
                await executeSequentially(queries, 'table creation');
                await executeSequentially(indexes, 'index creation');
                await executeSequentially(triggers, 'trigger creation');
                resolve();
            } catch (error) {
                reject(error);
            }
        })();
    });
}

// Get database instance
function getDatabase() {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}

// Execute query with parameters
function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                logger.error(`Query failed: ${sql}`, err);
                return reject(err);
            }
            resolve({ 
                lastID: this.lastID, 
                changes: this.changes 
            });
        });
    });
}

// Get single row
function getRow(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                logger.error(`Query failed: ${sql}`, err);
                return reject(err);
            }
            resolve(row);
        });
    });
}

// Get multiple rows
function getRows(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                logger.error(`Query failed: ${sql}`, err);
                return reject(err);
            }
            resolve(rows || []);
        });
    });
}

// Close database connection
function closeDatabase() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return resolve();
        }

        db.close((err) => {
            if (err) {
                logger.error('Error closing database:', err);
                return reject(err);
            }
            
            logger.info('Database connection closed');
            db = null;
            resolve();
        });
    });
}

// Database maintenance functions
function vacuum() {
    return runQuery('VACUUM');
}

function analyze() {
    return runQuery('ANALYZE');
}

function getStats() {
    return Promise.all([
        getRow('SELECT COUNT(*) as device_count FROM devices WHERE is_active = 1'),
        getRow('SELECT COUNT(*) as total_health_records FROM health_data'),
        getRow('SELECT COUNT(*) as sync_sessions_today FROM sync_sessions WHERE start_time > datetime("now", "-1 day")'),
        getRow('SELECT COUNT(*) as bluetooth_sessions_today FROM bluetooth_sessions WHERE start_time > datetime("now", "-1 day")')
    ]).then(([devices, healthData, syncSessions, bluetoothSessions]) => ({
        activeDevices: devices.device_count,
        totalHealthRecords: healthData.total_health_records,
        syncSessionsToday: syncSessions.sync_sessions_today,
        bluetoothSessionsToday: bluetoothSessions.bluetooth_sessions_today
    }));
}

module.exports = {
    initDatabase,
    getDatabase,
    runQuery,
    getRow,
    getRows,
    closeDatabase,
    vacuum,
    analyze,
    getStats
};
