const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
    })
);

// Create logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports: [
        // Console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        
        // File transport for all logs
        new winston.transports.File({
            filename: path.join(logsDir, 'app.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        
        // File transport for errors only
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 3,
            tailable: true
        })
    ]
});

// Health data specific logger
const healthDataLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logsDir, 'health-data.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true
        })
    ]
});

// Sync operations logger
const syncLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logsDir, 'sync.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
            tailable: true
        })
    ]
});

// Bluetooth operations logger
const bluetoothLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logsDir, 'bluetooth.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 3,
            tailable: true
        })
    ]
});

// Helper functions
const logHealthData = (action, deviceId, dataType, recordCount, metadata = {}) => {
    healthDataLogger.info({
        action,
        deviceId,
        dataType,
        recordCount,
        timestamp: new Date().toISOString(),
        ...metadata
    });
};

const logSyncOperation = (operation, deviceId, status, details = {}) => {
    syncLogger.info({
        operation,
        deviceId,
        status,
        timestamp: new Date().toISOString(),
        ...details
    });
};

const logBluetoothOperation = (operation, deviceId, status, details = {}) => {
    bluetoothLogger.info({
        operation,
        deviceId,
        status,
        timestamp: new Date().toISOString(),
        ...details
    });
};

module.exports = {
    logger,
    healthDataLogger,
    syncLogger,
    bluetoothLogger,
    logHealthData,
    logSyncOperation,
    logBluetoothOperation
};
