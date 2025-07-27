const path = require('path');

const config = {
    // Server configuration
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || '0.0.0.0', // Bind to all interfaces for local network access
        environment: process.env.NODE_ENV || 'development'
    },

    // Database configuration
    database: {
        type: 'sqlite',
        path: process.env.DB_PATH || path.join(__dirname, '../data/health_sync.db'),
        options: {
            // SQLite-specific options
            busyTimeout: 30000,
            pragma: {
                journal_mode: 'WAL',
                foreign_keys: 'ON',
                synchronous: 'NORMAL',
                cache_size: -64000, // 64MB cache
                temp_store: 'MEMORY'
            }
        }
    },

    // Sync configuration
    sync: {
        maxBatchSize: 1000, // Maximum number of records per sync batch
        syncTimeoutMs: 30000, // 30 seconds timeout for sync operations
        retryAttempts: 3,
        retryDelayMs: 1000,
        // Time window for considering data as "recent" (in milliseconds)
        recentDataWindowMs: 24 * 60 * 60 * 1000 // 24 hours
    },

    // Health data configuration
    healthData: {
        supportedTypes: [
            'heart_rate',
            'steps',
            'sleep',
            'activity',
            'workout',
            'blood_pressure',
            'blood_oxygen',
            'body_temperature',
            'gps_route',
            'calories_burned',
            'distance',
            'floors_climbed'
        ],
        maxRecordAge: 90 * 24 * 60 * 60 * 1000, // 90 days in milliseconds
        validation: {
            heartRate: { min: 30, max: 220 },
            steps: { min: 0, max: 100000 },
            bloodPressure: { 
                systolic: { min: 70, max: 250 },
                diastolic: { min: 40, max: 150 }
            },
            bloodOxygen: { min: 70, max: 100 },
            bodyTemperature: { min: 35.0, max: 42.0 } // Celsius
        }
    },

    // Bluetooth configuration
    bluetooth: {
        enabled: true,
        deviceName: 'GalaxyWatchSync',
        serviceUUID: '12345678-1234-1234-1234-123456789abc',
        characteristics: {
            healthData: '12345678-1234-1234-1234-123456789abd',
            syncStatus: '12345678-1234-1234-1234-123456789abe',
            lastSyncTime: '12345678-1234-1234-1234-123456789abf'
        },
        maxPayloadSize: 512, // bytes
        connectionTimeoutMs: 10000,
        scanTimeoutMs: 30000
    },

    // Security configuration
    security: {
        enableRateLimit: true,
        rateLimitWindow: 15 * 60 * 1000, // 15 minutes
        rateLimitMax: 100, // requests per window
        enableCors: true,
        allowedOrigins: [
            'http://localhost:*',
            'http://127.0.0.1:*',
            'http://192.168.*.*:*',
            'http://10.*.*.*:*',
            'http://172.16.*.*:*' // Private network ranges
        ]
    },

    // Logging configuration
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        file: {
            enabled: true,
            path: path.join(__dirname, '../logs'),
            maxSize: '10m',
            maxFiles: 5
        },
        console: {
            enabled: true,
            colorize: true
        }
    },

    // Cross-platform paths
    paths: {
        data: path.join(__dirname, '../data'),
        logs: path.join(__dirname, '../logs'),
        docs: path.join(__dirname, '../docs'),
        examples: path.join(__dirname, '../examples')
    }
};

module.exports = config;
