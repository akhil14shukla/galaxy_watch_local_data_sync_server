const config = require('../config/config');

// Health data validation functions
function validateHealthData(dataType, record) {
    try {
        // Check required fields
        if (!record.timestamp || !record.value) {
            return {
                isValid: false,
                error: 'Missing required fields: timestamp and value'
            };
        }

        // Validate timestamp
        const timestamp = parseInt(record.timestamp);
        if (isNaN(timestamp) || timestamp < 0) {
            return {
                isValid: false,
                error: 'Invalid timestamp'
            };
        }

        // Check if timestamp is not too old
        const maxAge = config.healthData.maxRecordAge;
        const now = Date.now();
        if (now - timestamp > maxAge) {
            return {
                isValid: false,
                error: `Record too old (max age: ${maxAge}ms)`
            };
        }

        // Check if timestamp is not in the future (allow 5 minutes grace period)
        if (timestamp > now + (5 * 60 * 1000)) {
            return {
                isValid: false,
                error: 'Timestamp cannot be in the future'
            };
        }

        // Validate value based on data type
        const valueValidation = validateValueByType(dataType, record.value, record.metadata);
        if (!valueValidation.isValid) {
            return valueValidation;
        }

        return { isValid: true };

    } catch (error) {
        return {
            isValid: false,
            error: `Validation error: ${error.message}`
        };
    }
}

function validateValueByType(dataType, value, metadata = {}) {
    const numValue = parseFloat(value);
    
    switch (dataType) {
        case 'heart_rate':
            const heartRateConfig = config.healthData.validation.heartRate;
            if (isNaN(numValue) || numValue < heartRateConfig.min || numValue > heartRateConfig.max) {
                return {
                    isValid: false,
                    error: `Heart rate must be between ${heartRateConfig.min} and ${heartRateConfig.max} bpm`
                };
            }
            break;

        case 'steps':
            const stepsConfig = config.healthData.validation.steps;
            if (isNaN(numValue) || numValue < stepsConfig.min || numValue > stepsConfig.max) {
                return {
                    isValid: false,
                    error: `Steps must be between ${stepsConfig.min} and ${stepsConfig.max}`
                };
            }
            break;

        case 'blood_pressure':
            if (!metadata.systolic || !metadata.diastolic) {
                return {
                    isValid: false,
                    error: 'Blood pressure requires systolic and diastolic values in metadata'
                };
            }
            
            const bpConfig = config.healthData.validation.bloodPressure;
            const systolic = parseFloat(metadata.systolic);
            const diastolic = parseFloat(metadata.diastolic);
            
            if (isNaN(systolic) || systolic < bpConfig.systolic.min || systolic > bpConfig.systolic.max) {
                return {
                    isValid: false,
                    error: `Systolic pressure must be between ${bpConfig.systolic.min} and ${bpConfig.systolic.max} mmHg`
                };
            }
            
            if (isNaN(diastolic) || diastolic < bpConfig.diastolic.min || diastolic > bpConfig.diastolic.max) {
                return {
                    isValid: false,
                    error: `Diastolic pressure must be between ${bpConfig.diastolic.min} and ${bpConfig.diastolic.max} mmHg`
                };
            }
            break;

        case 'blood_oxygen':
            const oxygenConfig = config.healthData.validation.bloodOxygen;
            if (isNaN(numValue) || numValue < oxygenConfig.min || numValue > oxygenConfig.max) {
                return {
                    isValid: false,
                    error: `Blood oxygen must be between ${oxygenConfig.min}% and ${oxygenConfig.max}%`
                };
            }
            break;

        case 'body_temperature':
            const tempConfig = config.healthData.validation.bodyTemperature;
            if (isNaN(numValue) || numValue < tempConfig.min || numValue > tempConfig.max) {
                return {
                    isValid: false,
                    error: `Body temperature must be between ${tempConfig.min}°C and ${tempConfig.max}°C`
                };
            }
            break;

        case 'sleep':
            // Sleep data should have duration in minutes
            if (isNaN(numValue) || numValue < 0 || numValue > (24 * 60)) {
                return {
                    isValid: false,
                    error: 'Sleep duration must be between 0 and 1440 minutes (24 hours)'
                };
            }
            break;

        case 'activity':
        case 'workout':
            // Activity/workout duration in minutes
            if (isNaN(numValue) || numValue < 0 || numValue > (12 * 60)) {
                return {
                    isValid: false,
                    error: 'Activity duration must be between 0 and 720 minutes (12 hours)'
                };
            }
            break;

        case 'calories_burned':
            if (isNaN(numValue) || numValue < 0 || numValue > 10000) {
                return {
                    isValid: false,
                    error: 'Calories burned must be between 0 and 10000'
                };
            }
            break;

        case 'distance':
            if (isNaN(numValue) || numValue < 0 || numValue > 1000000) {
                return {
                    isValid: false,
                    error: 'Distance must be between 0 and 1000000 meters'
                };
            }
            break;

        case 'floors_climbed':
            if (isNaN(numValue) || numValue < 0 || numValue > 1000) {
                return {
                    isValid: false,
                    error: 'Floors climbed must be between 0 and 1000'
                };
            }
            break;

        case 'gps_route':
            // GPS route validation - value should be number of points
            if (isNaN(numValue) || numValue < 0 || numValue > 50000) {
                return {
                    isValid: false,
                    error: 'GPS route points must be between 0 and 50000'
                };
            }
            
            // Validate GPS coordinates in metadata if present
            if (metadata.coordinates && Array.isArray(metadata.coordinates)) {
                for (const coord of metadata.coordinates) {
                    if (!validateGPSCoordinate(coord)) {
                        return {
                            isValid: false,
                            error: 'Invalid GPS coordinates in metadata'
                        };
                    }
                }
            }
            break;

        default:
            // For unknown data types, just check if value is a valid number
            if (isNaN(numValue)) {
                return {
                    isValid: false,
                    error: 'Value must be a valid number'
                };
            }
    }

    return { isValid: true };
}

function validateGPSCoordinate(coord) {
    if (!coord || typeof coord !== 'object') return false;
    
    const lat = parseFloat(coord.latitude);
    const lng = parseFloat(coord.longitude);
    
    if (isNaN(lat) || isNaN(lng)) return false;
    if (lat < -90 || lat > 90) return false;
    if (lng < -180 || lng > 180) return false;
    
    return true;
}

// Sanitize health data
function sanitizeHealthData(dataType, record) {
    const sanitized = {
        timestamp: parseInt(record.timestamp),
        value: parseFloat(record.value),
        unit: sanitizeString(record.unit),
        sourceApp: sanitizeString(record.sourceApp)
    };

    // Sanitize metadata
    if (record.metadata && typeof record.metadata === 'object') {
        sanitized.metadata = sanitizeMetadata(record.metadata);
    }

    return sanitized;
}

function sanitizeString(str) {
    if (typeof str !== 'string') return null;
    
    // Remove any potentially harmful characters
    return str
        .replace(/[<>\"'&]/g, '') // Remove HTML/XML chars
        .trim()
        .substring(0, 255); // Limit length
}

function sanitizeMetadata(metadata) {
    const sanitized = {};
    
    for (const [key, value] of Object.entries(metadata)) {
        const sanitizedKey = sanitizeString(key);
        if (!sanitizedKey) continue;
        
        if (typeof value === 'string') {
            sanitized[sanitizedKey] = sanitizeString(value);
        } else if (typeof value === 'number' && !isNaN(value)) {
            sanitized[sanitizedKey] = value;
        } else if (typeof value === 'boolean') {
            sanitized[sanitizedKey] = value;
        } else if (Array.isArray(value)) {
            // For arrays (like GPS coordinates), sanitize each element
            sanitized[sanitizedKey] = value
                .filter(item => item && typeof item === 'object')
                .map(item => sanitizeMetadata(item))
                .slice(0, 1000); // Limit array size
        } else if (value && typeof value === 'object') {
            sanitized[sanitizedKey] = sanitizeMetadata(value);
        }
    }
    
    return sanitized;
}

// Validate device registration data
function validateDeviceRegistration(deviceData) {
    const { deviceId, deviceName, deviceType } = deviceData;
    
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 100) {
        return {
            isValid: false,
            error: 'Device ID must be a string between 1 and 100 characters'
        };
    }
    
    if (!deviceName || typeof deviceName !== 'string' || deviceName.length < 1 || deviceName.length > 255) {
        return {
            isValid: false,
            error: 'Device name must be a string between 1 and 255 characters'
        };
    }
    
    if (!deviceType || !['wearos', 'ios'].includes(deviceType)) {
        return {
            isValid: false,
            error: 'Device type must be either "wearos" or "ios"'
        };
    }
    
    return { isValid: true };
}

// Validate sync request parameters
function validateSyncParams(params) {
    const { since, until, limit, offset } = params;
    
    if (since !== undefined) {
        const sinceNum = parseInt(since);
        if (isNaN(sinceNum) || sinceNum < 0) {
            return {
                isValid: false,
                error: 'Since parameter must be a valid timestamp'
            };
        }
    }
    
    if (until !== undefined) {
        const untilNum = parseInt(until);
        if (isNaN(untilNum) || untilNum < 0) {
            return {
                isValid: false,
                error: 'Until parameter must be a valid timestamp'
            };
        }
    }
    
    if (limit !== undefined) {
        const limitNum = parseInt(limit);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > config.sync.maxBatchSize) {
            return {
                isValid: false,
                error: `Limit must be between 1 and ${config.sync.maxBatchSize}`
            };
        }
    }
    
    if (offset !== undefined) {
        const offsetNum = parseInt(offset);
        if (isNaN(offsetNum) || offsetNum < 0) {
            return {
                isValid: false,
                error: 'Offset must be a non-negative number'
            };
        }
    }
    
    return { isValid: true };
}

module.exports = {
    validateHealthData,
    validateValueByType,
    validateGPSCoordinate,
    sanitizeHealthData,
    sanitizeString,
    sanitizeMetadata,
    validateDeviceRegistration,
    validateSyncParams
};
