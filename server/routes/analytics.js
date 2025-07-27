const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logHealthData } = require('../utils/logger');
const config = require('../config/config');

const router = express.Router();

// Enhanced health data analytics endpoints

// GET /api/v1/analytics/summary - Get health data summary for a device
router.get('/summary/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { timeframe = '7d', includeInsights = 'false' } = req.query;
        
        const days = parseTimeframe(timeframe);
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        
        // Get health data summary
        const summary = await generateHealthSummary(deviceId, startDate);
        
        // Generate insights if requested
        if (includeInsights === 'true') {
            summary.insights = await generateAIInsights(deviceId, 'all');
        }
        
        res.json({
            status: 'success',
            deviceId,
            timeframe,
            summary,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Error generating analytics summary:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate analytics summary',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/analytics/trends - Get health data trends
router.get('/trends/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { dataType = 'heart_rate', period = 'daily', days = '30' } = req.query;
        
        const numDays = parseInt(days);
        const startDate = new Date(Date.now() - numDays * 24 * 60 * 60 * 1000);
        
        const trends = await generateTrends(deviceId, dataType, period, startDate);
        
        res.json({
            status: 'success',
            deviceId,
            dataType,
            period,
            trends,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Error generating trends:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate trends',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/analytics/insights - Get AI-powered health insights
router.get('/insights/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { category = 'all' } = req.query;
        
        const insights = await generateAIInsights(deviceId, category);
        
        res.json({
            status: 'success',
            deviceId,
            category,
            insights,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Error generating insights:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate insights',
            timestamp: new Date().toISOString()
        });
    }
});

// POST /api/v1/analytics/goals - Set health goals for a device
router.post('/goals/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { goals } = req.body;
        
        // Validate goals structure
        if (!goals || typeof goals !== 'object') {
            return res.status(400).json({
                status: 'error',
                message: 'Invalid goals format',
                timestamp: new Date().toISOString()
            });
        }
        
        // Save goals to database
        await saveHealthGoals(deviceId, goals);
        
        res.json({
            status: 'success',
            deviceId,
            goals,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Error saving health goals:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to save health goals',
            timestamp: new Date().toISOString()
        });
    }
});

// GET /api/v1/analytics/goals - Get health goals for a device
router.get('/goals/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        
        const goals = await getHealthGoals(deviceId);
        
        res.json({
            status: 'success',
            deviceId,
            goals,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        logger.error('Error retrieving health goals:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to retrieve health goals',
            timestamp: new Date().toISOString()
        });
    }
});

// Helper Functions

function parseTimeframe(timeframe) {
    const match = timeframe.match(/^(\d+)([dwhmy])$/);
    if (!match) return 7; // Default to 7 days
    
    const [, amount, unit] = match;
    const num = parseInt(amount);
    
    switch (unit) {
        case 'd': return num;
        case 'w': return num * 7;
        case 'm': return num * 30;
        case 'y': return num * 365;
        default: return 7;
    }
}

async function generateHealthSummary(deviceId, startDate) {
    const summary = {
        heartRate: await getHeartRateSummary(deviceId, startDate),
        steps: await getStepsSummary(deviceId, startDate),
        sleep: await getSleepSummary(deviceId, startDate),
        activity: await getActivitySummary(deviceId, startDate)
    };
    
    return summary;
}

async function getHeartRateSummary(deviceId, startDate) {
    const records = await getRows(`
        SELECT value, timestamp FROM health_data 
        WHERE device_id = ? AND data_type = 'heart_rate' 
        AND timestamp > ? 
        ORDER BY timestamp DESC
    `, [deviceId, startDate.getTime()]);
    
    if (records.length === 0) {
        return { count: 0, average: 0, min: 0, max: 0, trend: 'stable' };
    }
    
    const values = records.map(r => r.value);
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    // Calculate trend (simplified)
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    let trend = 'stable';
    if (secondAvg > firstAvg + 5) trend = 'increasing';
    if (secondAvg < firstAvg - 5) trend = 'decreasing';
    
    return {
        count: records.length,
        average: Math.round(average),
        min,
        max,
        trend,
        zone: getHeartRateZone(average)
    };
}

async function getStepsSummary(deviceId, startDate) {
    const records = await getRows(`
        SELECT value, timestamp FROM health_data 
        WHERE device_id = ? AND data_type = 'steps' 
        AND timestamp > ? 
        ORDER BY timestamp DESC
    `, [deviceId, startDate.getTime()]);
    
    if (records.length === 0) {
        return { count: 0, total: 0, dailyAverage: 0, goalDays: 0 };
    }
    
    // Group by day
    const dailySteps = {};
    records.forEach(record => {
        const date = new Date(record.timestamp).toDateString();
        dailySteps[date] = (dailySteps[date] || 0) + record.value;
    });
    
    const dailyValues = Object.values(dailySteps);
    const total = dailyValues.reduce((a, b) => a + b, 0);
    const dailyAverage = total / dailyValues.length;
    const goalDays = dailyValues.filter(steps => steps >= 10000).length;
    
    return {
        count: records.length,
        total,
        dailyAverage: Math.round(dailyAverage),
        goalDays,
        totalDays: dailyValues.length,
        goalPercentage: Math.round((goalDays / dailyValues.length) * 100)
    };
}

async function getSleepSummary(deviceId, startDate) {
    const records = await getRows(`
        SELECT value, metadata, timestamp FROM health_data 
        WHERE device_id = ? AND data_type = 'sleep' 
        AND timestamp > ? 
        ORDER BY timestamp DESC
    `, [deviceId, startDate.getTime()]);
    
    if (records.length === 0) {
        return { count: 0, averageDuration: 0, quality: 0 };
    }
    
    const durations = records.map(r => r.value / 3600); // Convert to hours
    const averageDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    
    // Calculate quality score (simplified)
    const quality = Math.min(100, Math.max(0, (averageDuration - 4) / 5 * 100));
    
    return {
        count: records.length,
        averageDuration: Math.round(averageDuration * 100) / 100,
        quality: Math.round(quality),
        optimalNights: durations.filter(d => d >= 7 && d <= 9).length
    };
}

async function getActivitySummary(deviceId, startDate) {
    const records = await getRows(`
        SELECT data_type, COUNT(*) as count, AVG(value) as average 
        FROM health_data 
        WHERE device_id = ? AND timestamp > ? 
        GROUP BY data_type
    `, [deviceId, startDate.getTime()]);
    
    const summary = {};
    records.forEach(record => {
        summary[record.data_type] = {
            count: record.count,
            average: Math.round(record.average * 100) / 100
        };
    });
    
    return summary;
}

async function generateTrends(deviceId, dataType, period, startDate) {
    let groupBy;
    switch (period) {
        case 'hourly':
            groupBy = "strftime('%Y-%m-%d %H', datetime(timestamp/1000, 'unixepoch'))";
            break;
        case 'daily':
            groupBy = "strftime('%Y-%m-%d', datetime(timestamp/1000, 'unixepoch'))";
            break;
        case 'weekly':
            groupBy = "strftime('%Y-W%W', datetime(timestamp/1000, 'unixepoch'))";
            break;
        default:
            groupBy = "strftime('%Y-%m-%d', datetime(timestamp/1000, 'unixepoch'))";
    }
    
    const trends = await getRows(`
        SELECT ${groupBy} as period, 
               AVG(value) as average,
               MIN(value) as minimum,
               MAX(value) as maximum,
               COUNT(*) as count
        FROM health_data 
        WHERE device_id = ? AND data_type = ? AND timestamp > ?
        GROUP BY ${groupBy}
        ORDER BY period
    `, [deviceId, dataType, startDate.getTime()]);
    
    return trends.map(trend => ({
        period: trend.period,
        average: Math.round(trend.average * 100) / 100,
        minimum: trend.minimum,
        maximum: trend.maximum,
        count: trend.count
    }));
}

async function generateAIInsights(deviceId, category) {
    const insights = [];
    
    // Get recent data for analysis
    const recentData = await getRows(`
        SELECT data_type, value, timestamp, metadata 
        FROM health_data 
        WHERE device_id = ? AND timestamp > ?
        ORDER BY timestamp DESC
        LIMIT 1000
    `, [deviceId, Date.now() - 7 * 24 * 60 * 60 * 1000]);
    
    if (recentData.length === 0) {
        return insights;
    }
    
    // Group data by type
    const dataByType = {};
    recentData.forEach(record => {
        if (!dataByType[record.data_type]) {
            dataByType[record.data_type] = [];
        }
        dataByType[record.data_type].push(record);
    });
    
    // Generate insights for each data type
    if (category === 'all' || category === 'heart_rate') {
        const hrInsights = generateHeartRateInsights(dataByType.heart_rate || []);
        insights.push(...hrInsights);
    }
    
    if (category === 'all' || category === 'steps') {
        const stepInsights = generateStepInsights(dataByType.steps || []);
        insights.push(...stepInsights);
    }
    
    if (category === 'all' || category === 'sleep') {
        const sleepInsights = generateSleepInsights(dataByType.sleep || []);
        insights.push(...sleepInsights);
    }
    
    return insights;
}

function generateHeartRateInsights(heartRateData) {
    const insights = [];
    
    if (heartRateData.length === 0) return insights;
    
    const values = heartRateData.map(d => d.value);
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    
    // Resting heart rate insight
    if (average < 60) {
        insights.push({
            type: 'heart_rate',
            category: 'excellent',
            title: 'Excellent Resting Heart Rate',
            message: `Your average heart rate of ${Math.round(average)} BPM indicates excellent cardiovascular fitness.`,
            actionable: 'Continue your current fitness routine to maintain this healthy level.',
            confidence: 0.9
        });
    } else if (average > 100) {
        insights.push({
            type: 'heart_rate',
            category: 'warning',
            title: 'Elevated Heart Rate Detected',
            message: `Your average heart rate of ${Math.round(average)} BPM is higher than normal.`,
            actionable: 'Consider consulting a healthcare provider and reviewing your stress levels.',
            confidence: 0.8
        });
    }
    
    return insights;
}

function generateStepInsights(stepData) {
    const insights = [];
    
    if (stepData.length === 0) return insights;
    
    // Group by day
    const dailySteps = {};
    stepData.forEach(record => {
        const date = new Date(record.timestamp).toDateString();
        dailySteps[date] = (dailySteps[date] || 0) + record.value;
    });
    
    const dailyValues = Object.values(dailySteps);
    const average = dailyValues.reduce((a, b) => a + b, 0) / dailyValues.length;
    const goalDays = dailyValues.filter(steps => steps >= 10000).length;
    const goalPercentage = (goalDays / dailyValues.length) * 100;
    
    if (goalPercentage >= 80) {
        insights.push({
            type: 'steps',
            category: 'excellent',
            title: 'Outstanding Activity Level',
            message: `You're achieving your step goal ${goalPercentage.toFixed(0)}% of the time!`,
            actionable: 'Keep up the excellent work! Consider increasing your goal to continue challenging yourself.',
            confidence: 0.95
        });
    } else if (goalPercentage < 30) {
        insights.push({
            type: 'steps',
            category: 'improvement',
            title: 'Opportunity to Increase Activity',
            message: `You're averaging ${Math.round(average)} steps per day, below the recommended 10,000.`,
            actionable: 'Try taking short walks throughout the day or using stairs instead of elevators.',
            confidence: 0.85
        });
    }
    
    return insights;
}

function generateSleepInsights(sleepData) {
    const insights = [];
    
    if (sleepData.length === 0) return insights;
    
    const durations = sleepData.map(d => d.value / 3600); // Convert to hours
    const average = durations.reduce((a, b) => a + b, 0) / durations.length;
    
    if (average >= 7 && average <= 9) {
        insights.push({
            type: 'sleep',
            category: 'excellent',
            title: 'Optimal Sleep Duration',
            message: `Your average sleep of ${average.toFixed(1)} hours is in the optimal range.`,
            actionable: 'Maintain your current sleep schedule for continued health benefits.',
            confidence: 0.9
        });
    } else if (average < 6) {
        insights.push({
            type: 'sleep',
            category: 'warning',
            title: 'Insufficient Sleep Detected',
            message: `Your average sleep of ${average.toFixed(1)} hours is below recommended levels.`,
            actionable: 'Try to establish a consistent bedtime routine and limit screen time before bed.',
            confidence: 0.85
        });
    }
    
    return insights;
}

function getHeartRateZone(rate) {
    if (rate < 60) return 'bradycardia';
    if (rate >= 60 && rate <= 100) return 'normal';
    if (rate > 100 && rate <= 150) return 'elevated';
    return 'tachycardia';
}

async function saveHealthGoals(deviceId, goals) {
    const goalsJson = JSON.stringify(goals);
    
    await runQuery(`
        INSERT OR REPLACE INTO device_settings (device_id, setting_type, setting_value, updated_at)
        VALUES (?, 'health_goals', ?, ?)
    `, [deviceId, goalsJson, Date.now()]);
    
    logger.info(`Health goals saved for device ${deviceId}`);
}

async function getHealthGoals(deviceId) {
    const result = await getRow(`
        SELECT setting_value FROM device_settings 
        WHERE device_id = ? AND setting_type = 'health_goals'
    `, [deviceId]);
    
    if (result) {
        return JSON.parse(result.setting_value);
    }
    
    // Return default goals
    return {
        dailySteps: 10000,
        sleepHours: 8,
        activeMinutes: 30,
        caloriesBurned: 500,
        waterIntake: 8, // glasses
        maxRestingHeartRate: 100
    };
}

module.exports = router;
