const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logHealthData } = require('../utils/logger');
const config = require('../config/config');

const router = express.Router();

// POST /api/v1/data - iOS data upload endpoint (compatibility layer)
router.post('/', async (req, res) => {
    try {
        const batch = req.body;
        
        // Validate batch structure
        if (!batch.id || !batch.timestamp) {
            return res.status(400).json({
                status: "error",
                message: "Missing required fields: id, timestamp",
                timestamp: new Date().toISOString()
            });
        }

        let processedCount = 0;
        const deviceId = "ios_device_001"; // Default iOS device ID
        
        // Ensure device exists
        await ensureDeviceExists(deviceId, "iPhone", "ios");

        // Process heart rate data
        if (batch.heartRateData && Array.isArray(batch.heartRateData)) {
            for (const hrData of batch.heartRateData) {
                try {
                    await runQuery(`
                        INSERT INTO health_data (
                            device_id, data_type, timestamp, value, unit, metadata
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `, [
                        deviceId,
                        'heart_rate',
                        hrData.timestamp ? new Date(hrData.timestamp).getTime() : Date.now(),
                        hrData.value,
                        'bpm',
                        JSON.stringify({ confidence: hrData.confidence })
                    ]);
                    processedCount++;
                } catch (error) {
                    logger.error('Error inserting heart rate data:', error);
                }
            }
        }

        // Process step count data
        if (batch.stepCountData && Array.isArray(batch.stepCountData)) {
            for (const stepData of batch.stepCountData) {
                try {
                    await runQuery(`
                        INSERT INTO health_data (
                            device_id, data_type, timestamp, value, unit, metadata
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `, [
                        deviceId,
                        'steps',
                        stepData.timestamp ? new Date(stepData.timestamp).getTime() : Date.now(),
                        stepData.count,
                        'steps',
                        JSON.stringify({ duration: stepData.duration })
                    ]);
                    processedCount++;
                } catch (error) {
                    logger.error('Error inserting step count data:', error);
                }
            }
        }

        // Process sleep data
        if (batch.sleepData && Array.isArray(batch.sleepData)) {
            for (const sleepData of batch.sleepData) {
                try {
                    await runQuery(`
                        INSERT INTO health_data (
                            device_id, data_type, timestamp, value, unit, metadata
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `, [
                        deviceId,
                        'sleep',
                        sleepData.timestamp ? new Date(sleepData.timestamp).getTime() : Date.now(),
                        sleepData.endTime - sleepData.startTime, // Duration in milliseconds
                        'milliseconds',
                        JSON.stringify({
                            startTime: sleepData.startTime,
                            endTime: sleepData.endTime,
                            stages: sleepData.stages
                        })
                    ]);
                    processedCount++;
                } catch (error) {
                    logger.error('Error inserting sleep data:', error);
                }
            }
        }

        // Process workout data
        if (batch.workoutData && Array.isArray(batch.workoutData)) {
            for (const workoutData of batch.workoutData) {
                try {
                    await runQuery(`
                        INSERT INTO health_data (
                            device_id, data_type, timestamp, value, unit, metadata
                        ) VALUES (?, ?, ?, ?, ?, ?)
                    `, [
                        deviceId,
                        'workout',
                        workoutData.timestamp ? new Date(workoutData.timestamp).getTime() : Date.now(),
                        workoutData.duration,
                        'seconds',
                        JSON.stringify({
                            type: workoutData.type,
                            startTime: workoutData.startTime,
                            endTime: workoutData.endTime,
                            totalDistance: workoutData.totalDistance,
                            totalCalories: workoutData.totalCalories,
                            averageHeartRate: workoutData.averageHeartRate,
                            maxHeartRate: workoutData.maxHeartRate,
                            route: workoutData.route
                        })
                    ]);
                    processedCount++;
                } catch (error) {
                    logger.error('Error inserting workout data:', error);
                }
            }
        }

        // Log the operation
        logHealthData('batch_uploaded', deviceId, 'mixed', processedCount, {
            batchId: batch.id,
            totalItems: processedCount
        });

        res.json({
            status: "success",
            message: "Data saved successfully",
            processedCount: processedCount,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        logger.error('Error processing iOS data batch:', error);
        res.status(500).json({
            status: "error",
            message: "Internal server error",
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/data - iOS data fetch endpoint (compatibility layer)
router.get('/', async (req, res) => {
    try {
        const { since, limit = 1000, types } = req.query;

        if (!since) {
            return res.status(400).json({
                status: "error",
                message: "Missing required parameter: since",
                timestamp: new Date().toISOString()
            });
        }

        const sinceTimestamp = new Date(since).getTime();
        if (isNaN(sinceTimestamp)) {
            return res.status(400).json({
                status: "error",
                message: "Invalid since timestamp",
                timestamp: new Date().toISOString()
            });
        }

        const requestedTypes = types ? types.split(",") : ["heartRate", "stepCount", "sleep", "workout"];
        const limitNum = Math.min(parseInt(limit), config.sync.maxBatchSize);

        // Build result object
        const result = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            heartRateData: [],
            stepCountData: [],
            sleepData: [],
            workoutData: []
        };

        // Fetch heart rate data
        if (requestedTypes.includes("heartRate")) {
            const heartRateRecords = await getRows(`
                SELECT * FROM health_data 
                WHERE data_type = 'heart_rate' 
                AND timestamp > ? 
                ORDER BY timestamp DESC 
                LIMIT ?
            `, [sinceTimestamp, limitNum]);

            result.heartRateData = heartRateRecords.map(record => ({
                id: uuidv4(),
                timestamp: new Date(record.timestamp).toISOString(),
                value: record.value,
                confidence: record.metadata ? JSON.parse(record.metadata).confidence : null
            }));
        }

        // Fetch step count data
        if (requestedTypes.includes("stepCount")) {
            const stepRecords = await getRows(`
                SELECT * FROM health_data 
                WHERE data_type = 'steps' 
                AND timestamp > ? 
                ORDER BY timestamp DESC 
                LIMIT ?
            `, [sinceTimestamp, limitNum]);

            result.stepCountData = stepRecords.map(record => ({
                id: uuidv4(),
                timestamp: new Date(record.timestamp).toISOString(),
                count: record.value,
                duration: record.metadata ? JSON.parse(record.metadata).duration : null
            }));
        }

        // Fetch sleep data
        if (requestedTypes.includes("sleep")) {
            const sleepRecords = await getRows(`
                SELECT * FROM health_data 
                WHERE data_type = 'sleep' 
                AND timestamp > ? 
                ORDER BY timestamp DESC 
                LIMIT ?
            `, [sinceTimestamp, limitNum]);

            result.sleepData = sleepRecords.map(record => {
                const metadata = record.metadata ? JSON.parse(record.metadata) : {};
                return {
                    id: uuidv4(),
                    timestamp: new Date(record.timestamp).toISOString(),
                    startTime: metadata.startTime,
                    endTime: metadata.endTime,
                    stages: metadata.stages || []
                };
            });
        }

        // Fetch workout data
        if (requestedTypes.includes("workout")) {
            const workoutRecords = await getRows(`
                SELECT * FROM health_data 
                WHERE data_type = 'workout' 
                AND timestamp > ? 
                ORDER BY timestamp DESC 
                LIMIT ?
            `, [sinceTimestamp, limitNum]);

            result.workoutData = workoutRecords.map(record => {
                const metadata = record.metadata ? JSON.parse(record.metadata) : {};
                return {
                    id: uuidv4(),
                    timestamp: new Date(record.timestamp).toISOString(),
                    type: metadata.type,
                    startTime: metadata.startTime,
                    endTime: metadata.endTime,
                    duration: record.value,
                    totalDistance: metadata.totalDistance,
                    totalCalories: metadata.totalCalories,
                    averageHeartRate: metadata.averageHeartRate,
                    maxHeartRate: metadata.maxHeartRate,
                    route: metadata.route || []
                };
            });
        }

        result.hasMore = false; // Simplified for this implementation
        result.nextCursor = null;

        res.json(result);

        const totalItems = result.heartRateData.length + result.stepCountData.length + 
                          result.sleepData.length + result.workoutData.length;
        
        logger.info(`iOS: Fetched ${totalItems} health data points since ${since}`);

    } catch (error) {
        logger.error('Error fetching iOS data:', error);
        res.status(500).json({
            status: "error", 
            message: "Internal server error",
            timestamp: new Date().toISOString()
        });
    }
});

// Helper function to ensure device exists
async function ensureDeviceExists(deviceId, deviceName, deviceType) {
    const existingDevice = await getRow('SELECT * FROM devices WHERE id = ?', [deviceId]);

    if (!existingDevice) {
        await runQuery(`
            INSERT INTO devices (id, name, type, last_seen)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `, [deviceId, deviceName, deviceType]);
        
        logger.info(`Created new ${deviceType} device: ${deviceId}`);
    } else {
        // Update last seen
        await runQuery(`
            UPDATE devices 
            SET last_seen = CURRENT_TIMESTAMP, is_active = 1
            WHERE id = ?
        `, [deviceId]);
    }
}

module.exports = router;
