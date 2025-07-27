const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logSyncOperation } = require('../utils/logger');
const { validateDeviceRegistration, validateSyncParams } = require('../utils/validation');
const config = require('../config/config');

const router = express.Router();

// POST /api/v1/sync/register - Register a device for sync
router.post('/register', async (req, res) => {
    try {
        const { deviceId, deviceName, deviceType, metadata } = req.body;

        // Validate device data
        const validation = validateDeviceRegistration({ deviceId, deviceName, deviceType });
        if (!validation.isValid) {
            return res.status(400).json({
                error: validation.error
            });
        }

        // Check if device already exists
        const existingDevice = await getRow('SELECT * FROM devices WHERE id = ?', [deviceId]);

        if (existingDevice) {
            // Update existing device
            await runQuery(`
                UPDATE devices 
                SET name = ?, type = ?, last_seen = CURRENT_TIMESTAMP, 
                    is_active = 1, metadata = ?
                WHERE id = ?
            `, [deviceName, deviceType, JSON.stringify(metadata || {}), deviceId]);

            logSyncOperation('device_updated', deviceId, 'success', {
                deviceName,
                deviceType,
                previouslyRegistered: true
            });

            res.json({
                success: true,
                message: 'Device updated successfully',
                device: {
                    id: deviceId,
                    name: deviceName,
                    type: deviceType,
                    lastSyncTimestamp: existingDevice.last_sync_timestamp
                },
                timestamp: new Date().toISOString()
            });

        } else {
            // Create new device
            await runQuery(`
                INSERT INTO devices (id, name, type, last_seen, metadata)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
            `, [deviceId, deviceName, deviceType, JSON.stringify(metadata || {})]);

            logSyncOperation('device_registered', deviceId, 'success', {
                deviceName,
                deviceType,
                newRegistration: true
            });

            res.status(201).json({
                success: true,
                message: 'Device registered successfully',
                device: {
                    id: deviceId,
                    name: deviceName,
                    type: deviceType,
                    lastSyncTimestamp: 0
                },
                timestamp: new Date().toISOString()
            });
        }

    } catch (error) {
        logger.error('Error registering device:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/sync/status/:deviceId - Get sync status for a device
router.get('/status/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;

        // Get device info
        const device = await getRow(`
            SELECT id, name, type, last_sync_timestamp, last_seen, is_active
            FROM devices 
            WHERE id = ?
        `, [deviceId]);

        if (!device) {
            return res.status(404).json({
                error: 'Device not found'
            });
        }

        // Get latest sync session
        const latestSync = await getRow(`
            SELECT sync_type, status, records_synced, start_time, end_time, error_message
            FROM sync_sessions 
            WHERE device_id = ?
            ORDER BY start_time DESC
            LIMIT 1
        `, [deviceId]);

        // Get health data stats for this device
        const healthStats = await getRows(`
            SELECT data_type, COUNT(*) as count, MAX(timestamp) as latest_timestamp
            FROM health_data 
            WHERE device_id = ?
            GROUP BY data_type
        `, [deviceId]);

        res.json({
            success: true,
            device: {
                id: device.id,
                name: device.name,
                type: device.type,
                lastSyncTimestamp: device.last_sync_timestamp,
                lastSeen: device.last_seen,
                isActive: device.is_active === 1
            },
            latestSync: latestSync || null,
            healthDataStats: healthStats,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error getting sync status:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/v1/sync/start - Start a sync session
router.post('/start', async (req, res) => {
    try {
        const { deviceId, syncType = 'http' } = req.body;

        if (!deviceId) {
            return res.status(400).json({
                error: 'Device ID is required'
            });
        }

        if (!['http', 'bluetooth'].includes(syncType)) {
            return res.status(400).json({
                error: 'Sync type must be either "http" or "bluetooth"'
            });
        }

        // Verify device exists
        const device = await getRow('SELECT id FROM devices WHERE id = ?', [deviceId]);
        if (!device) {
            return res.status(404).json({
                error: 'Device not found. Please register the device first.'
            });
        }

        // Create sync session
        const sessionId = uuidv4();
        await runQuery(`
            INSERT INTO sync_sessions (id, device_id, sync_type, status, start_time)
            VALUES (?, ?, ?, 'started', CURRENT_TIMESTAMP)
        `, [sessionId, deviceId, syncType]);

        logSyncOperation('sync_started', deviceId, 'started', {
            sessionId,
            syncType
        });

        res.json({
            success: true,
            sessionId,
            syncType,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error starting sync session:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/v1/sync/complete - Complete a sync session
router.post('/complete', async (req, res) => {
    try {
        const { sessionId, recordsSynced = 0, errorMessage } = req.body;

        if (!sessionId) {
            return res.status(400).json({
                error: 'Session ID is required'
            });
        }

        // Get session info
        const session = await getRow(`
            SELECT id, device_id, sync_type, status
            FROM sync_sessions 
            WHERE id = ?
        `, [sessionId]);

        if (!session) {
            return res.status(404).json({
                error: 'Sync session not found'
            });
        }

        if (session.status !== 'started') {
            return res.status(400).json({
                error: `Cannot complete session with status: ${session.status}`
            });
        }

        // Update session
        const status = errorMessage ? 'failed' : 'completed';
        await runQuery(`
            UPDATE sync_sessions 
            SET status = ?, records_synced = ?, end_time = CURRENT_TIMESTAMP, error_message = ?
            WHERE id = ?
        `, [status, recordsSynced, errorMessage || null, sessionId]);

        logSyncOperation('sync_completed', session.device_id, status, {
            sessionId,
            syncType: session.sync_type,
            recordsSynced,
            errorMessage
        });

        res.json({
            success: true,
            status,
            recordsSynced,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error completing sync session:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/sync/data/:deviceId - Get data for sync (iOS app endpoint)
router.get('/data/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { since, until, dataType, limit = 1000, offset = 0 } = req.query;

        // Validate parameters
        const paramValidation = validateSyncParams({ since, until, limit, offset });
        if (!paramValidation.isValid) {
            return res.status(400).json({
                error: paramValidation.error
            });
        }

        // Verify device exists
        const device = await getRow('SELECT id, last_sync_timestamp FROM devices WHERE id = ?', [deviceId]);
        if (!device) {
            return res.status(404).json({
                error: 'Device not found'
            });
        }

        // Use device's last sync timestamp if no 'since' parameter provided
        const sinceTimestamp = since ? parseInt(since) : device.last_sync_timestamp;

        // Build query conditions
        const conditions = ['device_id != ?']; // Exclude data from the requesting device
        const params = [deviceId];

        if (sinceTimestamp > 0) {
            conditions.push('timestamp > ?');
            params.push(sinceTimestamp);
        }

        if (until) {
            conditions.push('timestamp <= ?');
            params.push(parseInt(until));
        }

        if (dataType) {
            if (!config.healthData.supportedTypes.includes(dataType)) {
                return res.status(400).json({
                    error: `Unsupported data type: ${dataType}`
                });
            }
            conditions.push('data_type = ?');
            params.push(dataType);
        }

        const limitNum = Math.min(parseInt(limit), config.sync.maxBatchSize);
        const offsetNum = parseInt(offset);

        // Execute query
        const query = `
            SELECT 
                device_id,
                data_type,
                timestamp,
                value,
                unit,
                metadata,
                source_app
            FROM health_data 
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `;

        params.push(limitNum, offsetNum);
        const records = await getRows(query, params);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total 
            FROM health_data 
            WHERE ${conditions.join(' AND ')}
        `;
        const countParams = params.slice(0, -2); // Remove limit and offset
        const countResult = await getRow(countQuery, countParams);

        logSyncOperation('data_retrieved', deviceId, 'success', {
            recordsReturned: records.length,
            sinceTimestamp,
            dataType: dataType || 'all',
            totalAvailable: countResult.total
        });

        res.json({
            success: true,
            data: records.map(record => ({
                ...record,
                metadata: record.metadata ? JSON.parse(record.metadata) : null
            })),
            pagination: {
                total: countResult.total,
                limit: limitNum,
                offset: offsetNum,
                hasMore: (offsetNum + records.length) < countResult.total
            },
            lastSyncTimestamp: sinceTimestamp,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error retrieving sync data:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// PUT /api/v1/sync/timestamp/:deviceId - Update device last sync timestamp
router.put('/timestamp/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { timestamp } = req.body;

        if (!timestamp || isNaN(parseInt(timestamp))) {
            return res.status(400).json({
                error: 'Valid timestamp is required'
            });
        }

        const timestampNum = parseInt(timestamp);

        // Verify device exists
        const device = await getRow('SELECT id FROM devices WHERE id = ?', [deviceId]);
        if (!device) {
            return res.status(404).json({
                error: 'Device not found'
            });
        }

        // Update timestamp
        await runQuery(`
            UPDATE devices 
            SET last_sync_timestamp = ?, last_seen = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [timestampNum, deviceId]);

        logSyncOperation('timestamp_updated', deviceId, 'success', {
            newTimestamp: timestampNum
        });

        res.json({
            success: true,
            lastSyncTimestamp: timestampNum,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error updating sync timestamp:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/sync/devices - List all registered devices
router.get('/devices', async (req, res) => {
    try {
        const devices = await getRows(`
            SELECT 
                id,
                name,
                type,
                last_sync_timestamp,
                last_seen,
                is_active,
                created_at
            FROM devices 
            ORDER BY last_seen DESC
        `);

        // Get sync stats for each device
        const devicesWithStats = await Promise.all(devices.map(async (device) => {
            const syncStats = await getRow(`
                SELECT 
                    COUNT(*) as total_sessions,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_sessions,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sessions,
                    MAX(start_time) as last_sync_attempt
                FROM sync_sessions 
                WHERE device_id = ?
            `, [device.id]);

            const healthDataCount = await getRow(`
                SELECT COUNT(*) as total_records
                FROM health_data 
                WHERE device_id = ?
            `, [device.id]);

            return {
                ...device,
                isActive: device.is_active === 1,
                syncStats: {
                    totalSessions: syncStats.total_sessions || 0,
                    completedSessions: syncStats.completed_sessions || 0,
                    failedSessions: syncStats.failed_sessions || 0,
                    lastSyncAttempt: syncStats.last_sync_attempt
                },
                healthDataRecords: healthDataCount.total_records || 0
            };
        }));

        res.json({
            success: true,
            devices: devicesWithStats,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error listing devices:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// DELETE /api/v1/sync/device/:deviceId - Unregister a device
router.delete('/device/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;

        // Check if device exists
        const device = await getRow('SELECT id, name FROM devices WHERE id = ?', [deviceId]);
        if (!device) {
            return res.status(404).json({
                error: 'Device not found'
            });
        }

        // Soft delete - mark as inactive
        await runQuery(`
            UPDATE devices 
            SET is_active = 0, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [deviceId]);

        logSyncOperation('device_unregistered', deviceId, 'success', {
            deviceName: device.name
        });

        res.json({
            success: true,
            message: 'Device unregistered successfully',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error unregistering device:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
