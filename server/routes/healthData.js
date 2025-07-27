const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logHealthData } = require('../utils/logger');
const { validateHealthData, sanitizeHealthData } = require('../utils/validation');
const config = require('../config/config');

const router = express.Router();

// POST /api/v1/health-data - Receive health data from devices
router.post('/', async (req, res) => {
    try {
        const { deviceId, dataType, records } = req.body;

        // Validate required fields
        if (!deviceId || !dataType || !Array.isArray(records)) {
            return res.status(400).json({
                error: 'Missing required fields: deviceId, dataType, records (array)'
            });
        }

        // Check if data type is supported
        if (!config.healthData.supportedTypes.includes(dataType)) {
            return res.status(400).json({
                error: `Unsupported data type: ${dataType}`,
                supportedTypes: config.healthData.supportedTypes
            });
        }

        // Validate batch size
        if (records.length > config.sync.maxBatchSize) {
            return res.status(400).json({
                error: `Batch size exceeds maximum allowed (${config.sync.maxBatchSize})`
            });
        }

        // Ensure device exists or create it
        await ensureDeviceExists(deviceId, req.body.deviceName, req.body.deviceType || 'wearos');

        // Process and validate records
        const validRecords = [];
        const errors = [];

        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            
            try {
                // Validate record structure
                const validationResult = validateHealthData(dataType, record);
                if (!validationResult.isValid) {
                    errors.push({
                        index: i,
                        error: validationResult.error
                    });
                    continue;
                }

                // Sanitize record data
                const sanitizedRecord = sanitizeHealthData(dataType, record);
                validRecords.push(sanitizedRecord);

            } catch (error) {
                errors.push({
                    index: i,
                    error: error.message
                });
            }
        }

        // Insert valid records
        let insertedCount = 0;
        if (validRecords.length > 0) {
            insertedCount = await insertHealthRecords(deviceId, dataType, validRecords);
        }

        // Update device last sync timestamp
        const maxTimestamp = validRecords.length > 0 
            ? Math.max(...validRecords.map(r => r.timestamp))
            : Date.now();
        
        await updateDeviceLastSync(deviceId, maxTimestamp);

        // Log the operation
        logHealthData('received', deviceId, dataType, insertedCount, {
            totalSubmitted: records.length,
            validRecords: validRecords.length,
            errors: errors.length
        });

        // Send response
        res.status(200).json({
            success: true,
            processed: {
                total: records.length,
                inserted: insertedCount,
                errors: errors.length
            },
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error processing health data:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/health-data - Retrieve health data for devices
router.get('/', async (req, res) => {
    try {
        const { 
            deviceId, 
            dataType, 
            since, 
            until, 
            limit = 1000, 
            offset = 0 
        } = req.query;

        // Build query conditions
        const conditions = [];
        const params = [];

        if (deviceId) {
            conditions.push('device_id = ?');
            params.push(deviceId);
        }

        if (dataType) {
            if (!config.healthData.supportedTypes.includes(dataType)) {
                return res.status(400).json({
                    error: `Unsupported data type: ${dataType}`,
                    supportedTypes: config.healthData.supportedTypes
                });
            }
            conditions.push('data_type = ?');
            params.push(dataType);
        }

        if (since) {
            const sinceTimestamp = parseInt(since);
            if (isNaN(sinceTimestamp)) {
                return res.status(400).json({
                    error: 'Invalid since timestamp'
                });
            }
            conditions.push('timestamp >= ?');
            params.push(sinceTimestamp);
        }

        if (until) {
            const untilTimestamp = parseInt(until);
            if (isNaN(untilTimestamp)) {
                return res.status(400).json({
                    error: 'Invalid until timestamp'
                });
            }
            conditions.push('timestamp <= ?');
            params.push(untilTimestamp);
        }

        // Validate limit
        const limitNum = Math.min(parseInt(limit) || 1000, config.sync.maxBatchSize);
        const offsetNum = parseInt(offset) || 0;

        // Build and execute query
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `
            SELECT 
                device_id,
                data_type,
                timestamp,
                value,
                unit,
                metadata,
                source_app,
                created_at
            FROM health_data 
            ${whereClause}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `;

        params.push(limitNum, offsetNum);

        const records = await getRows(query, params);

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) as total FROM health_data ${whereClause}`;
        const countParams = params.slice(0, -2); // Remove limit and offset
        const countResult = await getRow(countQuery, countParams);

        // Log the operation
        logHealthData('retrieved', deviceId || 'all', dataType || 'all', records.length, {
            filters: { since, until, limit: limitNum, offset: offsetNum },
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
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error retrieving health data:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/health-data/types - Get supported data types
router.get('/types', (req, res) => {
    res.json({
        supportedTypes: config.healthData.supportedTypes,
        validation: config.healthData.validation,
        timestamp: new Date().toISOString()
    });
});

// GET /api/v1/health-data/stats - Get health data statistics
router.get('/stats', async (req, res) => {
    try {
        const { deviceId, dataType } = req.query;

        const conditions = [];
        const params = [];

        if (deviceId) {
            conditions.push('device_id = ?');
            params.push(deviceId);
        }

        if (dataType) {
            conditions.push('data_type = ?');
            params.push(dataType);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const stats = await getRows(`
            SELECT 
                data_type,
                COUNT(*) as record_count,
                MIN(timestamp) as earliest_record,
                MAX(timestamp) as latest_record,
                COUNT(DISTINCT device_id) as device_count
            FROM health_data 
            ${whereClause}
            GROUP BY data_type
            ORDER BY record_count DESC
        `, params);

        const totalQuery = `SELECT COUNT(*) as total FROM health_data ${whereClause}`;
        const totalResult = await getRow(totalQuery, params);

        res.json({
            success: true,
            stats: {
                total_records: totalResult.total,
                by_type: stats
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error getting health data stats:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// DELETE /api/v1/health-data - Delete health data (for development/testing)
router.delete('/', async (req, res) => {
    try {
        const { deviceId, dataType, before } = req.query;

        if (config.server.environment === 'production') {
            return res.status(403).json({
                error: 'Data deletion not allowed in production'
            });
        }

        const conditions = [];
        const params = [];

        if (deviceId) {
            conditions.push('device_id = ?');
            params.push(deviceId);
        }

        if (dataType) {
            conditions.push('data_type = ?');
            params.push(dataType);
        }

        if (before) {
            const beforeTimestamp = parseInt(before);
            if (isNaN(beforeTimestamp)) {
                return res.status(400).json({
                    error: 'Invalid before timestamp'
                });
            }
            conditions.push('timestamp < ?');
            params.push(beforeTimestamp);
        }

        if (conditions.length === 0) {
            return res.status(400).json({
                error: 'At least one filter (deviceId, dataType, or before) is required'
            });
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const result = await runQuery(`DELETE FROM health_data ${whereClause}`, params);

        logger.info(`Deleted ${result.changes} health data records`, { deviceId, dataType, before });

        res.json({
            success: true,
            deleted_records: result.changes,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error deleting health data:', error);
        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

// Helper functions
async function ensureDeviceExists(deviceId, deviceName, deviceType) {
    const existingDevice = await getRow('SELECT id FROM devices WHERE id = ?', [deviceId]);
    
    if (!existingDevice) {
        await runQuery(`
            INSERT INTO devices (id, name, type, last_seen, metadata)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
        `, [
            deviceId,
            deviceName || `${deviceType} Device`,
            deviceType,
            JSON.stringify({ auto_created: true })
        ]);
        
        logger.info(`Created new device: ${deviceId} (${deviceType})`);
    } else {
        // Update last seen
        await runQuery(`
            UPDATE devices 
            SET last_seen = CURRENT_TIMESTAMP 
            WHERE id = ?
        `, [deviceId]);
    }
}

async function insertHealthRecords(deviceId, dataType, records) {
    const insertQuery = `
        INSERT INTO health_data (
            device_id, data_type, timestamp, value, unit, metadata, source_app
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    let insertedCount = 0;
    
    for (const record of records) {
        try {
            await runQuery(insertQuery, [
                deviceId,
                dataType,
                record.timestamp,
                record.value,
                record.unit || null,
                record.metadata ? JSON.stringify(record.metadata) : null,
                record.sourceApp || null
            ]);
            insertedCount++;
        } catch (error) {
            logger.error(`Failed to insert health record:`, error);
        }
    }

    return insertedCount;
}

async function updateDeviceLastSync(deviceId, timestamp) {
    await runQuery(`
        UPDATE devices 
        SET last_sync_timestamp = ?
        WHERE id = ?
    `, [timestamp, deviceId]);
}

module.exports = router;
