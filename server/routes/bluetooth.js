const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logBluetoothOperation } = require('../utils/logger');
const config = require('../config/config');

const router = express.Router();

// Bluetooth service status
let bluetoothService = {
    isEnabled: config.bluetooth.enabled,
    isAdvertising: false,
    connectedDevices: new Map(),
    lastError: null
};

// GET /api/v1/bluetooth/status - Get Bluetooth service status
router.get('/status', (req, res) => {
    res.json({
        success: true,
        bluetooth: {
            enabled: bluetoothService.isEnabled,
            advertising: bluetoothService.isAdvertising,
            connectedDevices: Array.from(bluetoothService.connectedDevices.keys()),
            serviceUUID: config.bluetooth.serviceUUID,
            deviceName: config.bluetooth.deviceName,
            lastError: bluetoothService.lastError
        },
        timestamp: new Date().toISOString()
    });
});

// POST /api/v1/bluetooth/start - Start Bluetooth advertising
router.post('/start', async (req, res) => {
    try {
        if (!bluetoothService.isEnabled) {
            return res.status(400).json({
                error: 'Bluetooth is disabled in configuration'
            });
        }

        if (bluetoothService.isAdvertising) {
            return res.json({
                success: true,
                message: 'Bluetooth advertising is already active',
                timestamp: new Date().toISOString()
            });
        }

        // Start Bluetooth advertising (implementation would go here)
        await startBluetoothAdvertising();

        bluetoothService.isAdvertising = true;
        bluetoothService.lastError = null;

        logBluetoothOperation('advertising_started', null, 'success', {
            serviceUUID: config.bluetooth.serviceUUID,
            deviceName: config.bluetooth.deviceName
        });

        res.json({
            success: true,
            message: 'Bluetooth advertising started',
            serviceUUID: config.bluetooth.serviceUUID,
            deviceName: config.bluetooth.deviceName,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error starting Bluetooth advertising:', error);
        bluetoothService.lastError = error.message;
        bluetoothService.isAdvertising = false;

        res.status(500).json({
            error: 'Failed to start Bluetooth advertising',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/v1/bluetooth/stop - Stop Bluetooth advertising
router.post('/stop', async (req, res) => {
    try {
        if (!bluetoothService.isAdvertising) {
            return res.json({
                success: true,
                message: 'Bluetooth advertising is not active',
                timestamp: new Date().toISOString()
            });
        }

        // Stop Bluetooth advertising and disconnect all devices
        await stopBluetoothAdvertising();

        bluetoothService.isAdvertising = false;
        bluetoothService.connectedDevices.clear();

        logBluetoothOperation('advertising_stopped', null, 'success');

        res.json({
            success: true,
            message: 'Bluetooth advertising stopped',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error stopping Bluetooth advertising:', error);
        bluetoothService.lastError = error.message;

        res.status(500).json({
            error: 'Failed to stop Bluetooth advertising',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/bluetooth/sessions - Get Bluetooth session history
router.get('/sessions', async (req, res) => {
    try {
        const { limit = 50, offset = 0, deviceId } = req.query;

        const conditions = [];
        const params = [];

        if (deviceId) {
            conditions.push('device_id = ?');
            params.push(deviceId);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limitNum = Math.min(parseInt(limit), 100);
        const offsetNum = parseInt(offset) || 0;

        const sessions = await getRows(`
            SELECT 
                id,
                device_id,
                device_address,
                connection_status,
                start_time,
                end_time,
                data_transferred,
                error_message,
                metadata
            FROM bluetooth_sessions 
            ${whereClause}
            ORDER BY start_time DESC
            LIMIT ? OFFSET ?
        `, [...params, limitNum, offsetNum]);

        const totalQuery = `SELECT COUNT(*) as total FROM bluetooth_sessions ${whereClause}`;
        const totalResult = await getRow(totalQuery, params);

        res.json({
            success: true,
            sessions: sessions.map(session => ({
                ...session,
                metadata: session.metadata ? JSON.parse(session.metadata) : null
            })),
            pagination: {
                total: totalResult.total,
                limit: limitNum,
                offset: offsetNum,
                hasMore: (offsetNum + sessions.length) < totalResult.total
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error retrieving Bluetooth sessions:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/v1/bluetooth/session - Create new Bluetooth session
router.post('/session', async (req, res) => {
    try {
        const { deviceId, deviceAddress } = req.body;

        if (!deviceId || !deviceAddress) {
            return res.status(400).json({
                error: 'Device ID and device address are required'
            });
        }

        const sessionId = uuidv4();
        
        await runQuery(`
            INSERT INTO bluetooth_sessions (
                id, device_id, device_address, connection_status, start_time
            ) VALUES (?, ?, ?, 'connecting', CURRENT_TIMESTAMP)
        `, [sessionId, deviceId, deviceAddress]);

        logBluetoothOperation('session_created', deviceId, 'connecting', {
            sessionId,
            deviceAddress
        });

        res.status(201).json({
            success: true,
            sessionId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error creating Bluetooth session:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// PUT /api/v1/bluetooth/session/:sessionId - Update Bluetooth session
router.put('/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { connectionStatus, dataTransferred, errorMessage } = req.body;

        if (!connectionStatus || !['connected', 'disconnected', 'failed'].includes(connectionStatus)) {
            return res.status(400).json({
                error: 'Valid connection status is required (connected, disconnected, failed)'
            });
        }

        const session = await getRow('SELECT device_id FROM bluetooth_sessions WHERE id = ?', [sessionId]);
        if (!session) {
            return res.status(404).json({
                error: 'Bluetooth session not found'
            });
        }

        const updateData = ['connection_status = ?'];
        const params = [connectionStatus];

        if (connectionStatus === 'disconnected' || connectionStatus === 'failed') {
            updateData.push('end_time = CURRENT_TIMESTAMP');
        }

        if (dataTransferred !== undefined) {
            updateData.push('data_transferred = ?');
            params.push(parseInt(dataTransferred) || 0);
        }

        if (errorMessage) {
            updateData.push('error_message = ?');
            params.push(errorMessage);
        }

        params.push(sessionId);

        await runQuery(`
            UPDATE bluetooth_sessions 
            SET ${updateData.join(', ')}
            WHERE id = ?
        `, params);

        logBluetoothOperation('session_updated', session.device_id, connectionStatus, {
            sessionId,
            dataTransferred,
            errorMessage
        });

        res.json({
            success: true,
            sessionId,
            connectionStatus,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error updating Bluetooth session:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/bluetooth/config - Get Bluetooth configuration
router.get('/config', (req, res) => {
    res.json({
        success: true,
        config: {
            enabled: config.bluetooth.enabled,
            deviceName: config.bluetooth.deviceName,
            serviceUUID: config.bluetooth.serviceUUID,
            characteristics: config.bluetooth.characteristics,
            maxPayloadSize: config.bluetooth.maxPayloadSize,
            connectionTimeout: config.bluetooth.connectionTimeoutMs,
            scanTimeout: config.bluetooth.scanTimeoutMs
        },
        timestamp: new Date().toISOString()
    });
});

// POST /api/v1/bluetooth/test - Test Bluetooth functionality
router.post('/test', async (req, res) => {
    try {
        const testResults = {
            bluetoothAvailable: false,
            canAdvertise: false,
            serviceCreated: false,
            characteristicsCreated: false,
            errors: []
        };

        // Test Bluetooth availability
        try {
            testResults.bluetoothAvailable = await testBluetoothAvailability();
        } catch (error) {
            testResults.errors.push(`Bluetooth availability: ${error.message}`);
        }

        // Test advertising capability
        if (testResults.bluetoothAvailable) {
            try {
                testResults.canAdvertise = await testAdvertisingCapability();
            } catch (error) {
                testResults.errors.push(`Advertising capability: ${error.message}`);
            }
        }

        // Test service creation
        if (testResults.canAdvertise) {
            try {
                testResults.serviceCreated = await testServiceCreation();
            } catch (error) {
                testResults.errors.push(`Service creation: ${error.message}`);
            }
        }

        // Test characteristics creation
        if (testResults.serviceCreated) {
            try {
                testResults.characteristicsCreated = await testCharacteristicsCreation();
            } catch (error) {
                testResults.errors.push(`Characteristics creation: ${error.message}`);
            }
        }

        const overallSuccess = testResults.bluetoothAvailable && 
                              testResults.canAdvertise && 
                              testResults.serviceCreated && 
                              testResults.characteristicsCreated;

        res.json({
            success: overallSuccess,
            testResults,
            recommendation: overallSuccess 
                ? 'Bluetooth functionality is working correctly'
                : 'Some Bluetooth features are not available. Check errors for details.',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error testing Bluetooth functionality:', error);
        res.status(500).json({
            error: 'Failed to test Bluetooth functionality',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Bluetooth implementation functions (placeholders)
async function startBluetoothAdvertising() {
    // This would implement the actual Bluetooth advertising logic
    // Using noble/bleno or another Node.js Bluetooth library
    logger.info('Starting Bluetooth advertising...');
    
    // For now, simulate successful start
    return new Promise((resolve) => {
        setTimeout(() => {
            logger.info('Bluetooth advertising started successfully');
            resolve();
        }, 1000);
    });
}

async function stopBluetoothAdvertising() {
    logger.info('Stopping Bluetooth advertising...');
    
    // For now, simulate successful stop
    return new Promise((resolve) => {
        setTimeout(() => {
            logger.info('Bluetooth advertising stopped successfully');
            resolve();
        }, 500);
    });
}

async function testBluetoothAvailability() {
    // Test if Bluetooth is available on the system
    // This would check for Bluetooth adapter presence
    logger.info('Testing Bluetooth availability...');
    
    // For development, assume Bluetooth is available
    // In production, this would check actual hardware
    return true;
}

async function testAdvertisingCapability() {
    // Test if the system can advertise BLE services
    logger.info('Testing BLE advertising capability...');
    
    // For development, assume advertising is supported
    return true;
}

async function testServiceCreation() {
    // Test creating a BLE service
    logger.info('Testing BLE service creation...');
    
    // For development, assume service creation works
    return true;
}

async function testCharacteristicsCreation() {
    // Test creating BLE characteristics
    logger.info('Testing BLE characteristics creation...');
    
    // For development, assume characteristics creation works
    return true;
}

module.exports = router;
