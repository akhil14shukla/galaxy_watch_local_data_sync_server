const express = require('express');

const router = express.Router();

// GET /api/v1/health - iOS health status endpoint (compatibility layer)
router.get('/', (req, res) => {
    res.json({
        status: "ok",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        services: {
            database: "connected",
            bluetooth: "ready",
            sync: "active"
        }
    });
});

module.exports = router;
