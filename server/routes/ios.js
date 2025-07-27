const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runQuery, getRow, getRows } = require('../database/init');
const { logger, logHealthData } = require('../utils/logger');
const { validateHealthData, sanitizeHealthData } = require('../utils/validation');
const config = require('../config/config');

const router = express.Router();

// iOS-compatible endpoints for backward compatibility with the reference implementation

module.exports = router;
