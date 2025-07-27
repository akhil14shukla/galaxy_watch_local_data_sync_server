const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

// Import custom modules
const healthDataRoutes = require('./routes/healthData');
const syncRoutes = require('./routes/sync');
const bluetoothRoutes = require('./routes/bluetooth');
const iosDataRoutes = require('./routes/iosData'); // iOS data compatibility routes
const iosHealthRoutes = require('./routes/iosHealth'); // iOS health compatibility routes
const analyticsRoutes = require('./routes/analytics'); // Enhanced analytics routes
const { initDatabase } = require('./database/init');
const { logger } = require('./utils/logger');
const config = require('./config/config');

class GalaxyWatchSyncServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = null;
        this.clients = new Set();
        this.connectedDevices = new Map();
        this.healthDataStreams = new Map();
        this.realtimeMetrics = {
            totalDevices: 0,
            activeConnections: 0,
            dataPointsToday: 0,
            lastSyncTime: null
        };
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.setupErrorHandling();
        this.startMetricsTracking();
    }

    setupMiddleware() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                },
            },
        }));

        // CORS configuration for local network access
        this.app.use(cors({
            origin: function (origin, callback) {
                // Allow requests with no origin (mobile apps, Postman, etc.)
                if (!origin) return callback(null, true);
                
                // Allow localhost and local network IPs
                const allowedOrigins = [
                    /^http:\/\/localhost:\d+$/,
                    /^http:\/\/127\.0\.0\.1:\d+$/,
                    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
                    /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/,
                    /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+:\d+$/
                ];

                if (allowedOrigins.some(pattern => pattern.test(origin))) {
                    callback(null, true);
                } else {
                    logger.warn(`CORS: Blocked origin ${origin}`);
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID', 'X-Device-Type']
        }));

        // Request logging
        this.app.use(morgan('combined', {
            stream: {
                write: (message) => logger.info(message.trim())
            },
            skip: (req) => req.url === '/health' || req.url === '/metrics'
        }));

        // Body parsing middleware
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Serve static files for documentation
        this.app.use('/docs', express.static(path.join(__dirname, '../docs')));

        // Add device tracking middleware
        this.app.use((req, res, next) => {
            const deviceId = req.headers['x-device-id'];
            const deviceType = req.headers['x-device-type'];
            
            if (deviceId && deviceType) {
                this.updateDeviceActivity(deviceId, deviceType);
            }
            
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint with enhanced metrics
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: require('../package.json').version,
                uptime: process.uptime(),
                metrics: this.realtimeMetrics,
                connections: {
                    websocket: this.clients.size,
                    devices: this.connectedDevices.size
                }
            });
        });

        // Real-time metrics endpoint
        this.app.get('/metrics', (req, res) => {
            res.json({
                timestamp: new Date().toISOString(),
                server: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage()
                },
                connections: {
                    websocket: this.clients.size,
                    devices: this.connectedDevices.size,
                    activeDevices: Array.from(this.connectedDevices.entries()).map(([id, info]) => ({
                        id,
                        type: info.type,
                        lastSeen: info.lastSeen,
                        dataPoints: info.dataPoints || 0
                    }))
                },
                metrics: this.realtimeMetrics
            });
        });

        // API routes
        this.app.use('/api/v1/health-data', healthDataRoutes);
        this.app.use('/api/v1/sync', syncRoutes);
        this.app.use('/api/v1/bluetooth', bluetoothRoutes);
        this.app.use('/api/v1/data', iosDataRoutes); // iOS data compatibility routes
        this.app.use('/api/v1/health', iosHealthRoutes); // iOS health compatibility routes
        this.app.use('/api/v1/analytics', analyticsRoutes); // Enhanced analytics routes

        // Root endpoint with API documentation
        this.app.get('/', (req, res) => {
            res.json({
                name: 'Galaxy Watch Local Data Sync Server',
                version: require('../package.json').version,
                description: 'Privacy-focused health data synchronization between Samsung Galaxy Watch and iPhone',
                endpoints: {
                    health: '/health',
                    metrics: '/metrics',
                    documentation: '/docs',
                    websocket: `/ws (${this.clients.size} connected)`,
                    api: {
                        healthData: '/api/v1/health-data',
                        sync: '/api/v1/sync',
                        bluetooth: '/api/v1/bluetooth'
                    }
                },
                architecture: {
                    primary: 'Local Wi-Fi Server (REST API)',
                    fallback: 'Bluetooth Low Energy (BLE)',
                    realtime: 'WebSocket Streaming',
                    database: 'SQLite',
                    syncMethod: 'Timestamp-based stateful synchronization'
                },
                status: {
                    connected_devices: this.connectedDevices.size,
                    active_connections: this.clients.size,
                    data_points_today: this.realtimeMetrics.dataPointsToday
                }
            });
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                path: req.originalUrl,
                method: req.method,
                timestamp: new Date().toISOString(),
                suggestion: 'Visit /docs for API documentation'
            });
        });
    }

    setupWebSocket() {
        this.wss = new WebSocket.Server({ 
            server: this.server,
            path: '/ws'
        });

        this.wss.on('connection', (ws, req) => {
            const clientId = req.headers['x-device-id'] || `client_${Date.now()}`;
            const deviceType = req.headers['x-device-type'] || 'unknown';
            
            logger.info(`WebSocket connection established: ${clientId} (${deviceType})`);
            
            ws.clientId = clientId;
            ws.deviceType = deviceType;
            ws.isAlive = true;
            
            this.clients.add(ws);
            this.realtimeMetrics.activeConnections = this.clients.size;

            // Send welcome message with current status
            ws.send(JSON.stringify({
                type: 'welcome',
                clientId: clientId,
                timestamp: new Date().toISOString(),
                serverStatus: {
                    version: require('../package.json').version,
                    connectedDevices: this.connectedDevices.size,
                    uptime: process.uptime()
                }
            }));

            // Handle incoming messages
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleWebSocketMessage(ws, message);
                } catch (error) {
                    logger.error(`WebSocket message parse error: ${error.message}`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid JSON format',
                        timestamp: new Date().toISOString()
                    }));
                }
            });

            // Handle pong responses
            ws.on('pong', () => {
                ws.isAlive = true;
            });

            // Handle disconnection
            ws.on('close', () => {
                logger.info(`WebSocket disconnected: ${clientId}`);
                this.clients.delete(ws);
                this.realtimeMetrics.activeConnections = this.clients.size;
            });

            ws.on('error', (error) => {
                logger.error(`WebSocket error for ${clientId}: ${error.message}`);
                this.clients.delete(ws);
                this.realtimeMetrics.activeConnections = this.clients.size;
            });
        });

        // Ping clients periodically to keep connections alive
        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    this.clients.delete(ws);
                    return ws.terminate();
                }
                
                ws.isAlive = false;
                ws.ping();
            });
            
            this.realtimeMetrics.activeConnections = this.clients.size;
        }, 30000); // 30 seconds
    }

    handleWebSocketMessage(ws, message) {
        const { type, data } = message;
        
        switch (type) {
            case 'subscribe':
                this.handleSubscription(ws, data);
                break;
            case 'unsubscribe':
                this.handleUnsubscription(ws, data);
                break;
            case 'health_data':
                this.handleRealtimeHealthData(ws, data);
                break;
            case 'ping':
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: new Date().toISOString()
                }));
                break;
            default:
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Unknown message type: ${type}`,
                    timestamp: new Date().toISOString()
                }));
        }
    }

    handleSubscription(ws, data) {
        const { streams } = data;
        
        if (!ws.subscriptions) {
            ws.subscriptions = new Set();
        }
        
        if (Array.isArray(streams)) {
            streams.forEach(stream => ws.subscriptions.add(stream));
        }
        
        ws.send(JSON.stringify({
            type: 'subscription_confirmed',
            streams: Array.from(ws.subscriptions),
            timestamp: new Date().toISOString()
        }));
        
        logger.info(`WebSocket ${ws.clientId} subscribed to: ${streams?.join(', ')}`);
    }

    handleUnsubscription(ws, data) {
        const { streams } = data;
        
        if (ws.subscriptions && Array.isArray(streams)) {
            streams.forEach(stream => ws.subscriptions.delete(stream));
        }
        
        ws.send(JSON.stringify({
            type: 'unsubscription_confirmed',
            streams: streams,
            timestamp: new Date().toISOString()
        }));
    }

    handleRealtimeHealthData(ws, data) {
        // Process real-time health data
        const timestamp = new Date().toISOString();
        
        // Update metrics
        this.realtimeMetrics.dataPointsToday++;
        this.realtimeMetrics.lastSyncTime = timestamp;
        
        // Broadcast to subscribed clients
        this.broadcastToSubscribers('health_data_update', {
            deviceId: ws.clientId,
            deviceType: ws.deviceType,
            data: data,
            timestamp: timestamp
        });
        
        // Send confirmation back to sender
        ws.send(JSON.stringify({
            type: 'data_received',
            timestamp: timestamp,
            processed: true
        }));
    }

    broadcastToSubscribers(type, data) {
        const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
        
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && 
                client.subscriptions && 
                client.subscriptions.has(type)) {
                client.send(message);
            }
        });
    }

    updateDeviceActivity(deviceId, deviceType) {
        const now = new Date();
        
        if (!this.connectedDevices.has(deviceId)) {
            this.realtimeMetrics.totalDevices++;
            logger.info(`New device connected: ${deviceId} (${deviceType})`);
        }
        
        this.connectedDevices.set(deviceId, {
            type: deviceType,
            lastSeen: now.toISOString(),
            dataPoints: (this.connectedDevices.get(deviceId)?.dataPoints || 0) + 1
        });
        
        // Broadcast device status update
        this.broadcastToSubscribers('device_status', {
            deviceId,
            deviceType,
            status: 'active',
            lastSeen: now.toISOString()
        });
    }

    startMetricsTracking() {
        // Reset daily counters at midnight
        setInterval(() => {
            const now = new Date();
            if (now.getHours() === 0 && now.getMinutes() === 0) {
                this.realtimeMetrics.dataPointsToday = 0;
                logger.info('Daily metrics reset');
            }
        }, 60000); // Check every minute

        // Clean up inactive devices every hour
        setInterval(() => {
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            
            for (const [deviceId, info] of this.connectedDevices.entries()) {
                if (new Date(info.lastSeen) < oneHourAgo) {
                    this.connectedDevices.delete(deviceId);
                    logger.info(`Removed inactive device: ${deviceId}`);
                    
                    this.broadcastToSubscribers('device_status', {
                        deviceId,
                        status: 'inactive',
                        lastSeen: info.lastSeen
                    });
                }
            }
        }, 3600000); // Every hour
    }

    setupErrorHandling() {
        // Global error handler
        this.app.use((err, req, res, next) => {
            logger.error(`Unhandled error: ${err.message}`, err);
            
            res.status(500).json({
                error: 'Internal server error',
                message: err.message,
                timestamp: new Date().toISOString(),
                path: req.path
            });
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (err) => {
            logger.error('Uncaught Exception:', err);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
        });
    }

    async start() {
        try {
            // Initialize database
            await initDatabase();
            logger.info('Database initialized successfully');

            const port = config.server.port;
            const host = config.server.host;

            this.server.listen(port, host, () => {
                logger.info(`🚀 Galaxy Watch Sync Server running on http://${host}:${port}`);
                logger.info(`📊 Real-time metrics: http://${host}:${port}/metrics`);
                logger.info(`🔌 WebSocket endpoint: ws://${host}:${port}/ws`);
                logger.info(`📚 Documentation: http://${host}:${port}/docs`);
                logger.info(`🏥 Health check: http://${host}:${port}/health`);
            });

        } catch (error) {
            logger.error('Failed to start server:', error);
            process.exit(1);
        }
    }

    async stop() {
        return new Promise((resolve) => {
            logger.info('Shutting down server...');
            
            // Close WebSocket server
            if (this.wss) {
                this.wss.close(() => {
                    logger.info('WebSocket server closed');
                });
            }
            
            // Close HTTP server
            this.server.close(() => {
                logger.info('HTTP server closed');
                resolve();
            });
        });
    }
}

module.exports = GalaxyWatchSyncServer;
