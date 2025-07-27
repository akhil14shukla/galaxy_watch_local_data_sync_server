const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

// Import custom modules
const healthDataRoutes = require('./routes/healthData');
const syncRoutes = require('./routes/sync');
const bluetoothRoutes = require('./routes/bluetooth');
const iosDataRoutes = require('./routes/iosData'); // iOS data compatibility routes
const iosHealthRoutes = require('./routes/iosHealth'); // iOS health compatibility routes
const { initDatabase } = require('./database/init');
const { logger } = require('./utils/logger');
const config = require('./config/config');

class GalaxyWatchSyncServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
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
                    /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+:\d+$/
                ];
                
                if (allowedOrigins.some(pattern => pattern.test(origin))) {
                    return callback(null, true);
                }
                
                logger.warn(`CORS: Blocked origin ${origin}`);
                callback(new Error('Not allowed by CORS'));
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
        }));

        // Logging middleware
        this.app.use(morgan('combined', {
            stream: {
                write: (message) => logger.info(message.trim())
            }
        }));

        // Body parsing middleware
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Serve static files for documentation
        this.app.use('/docs', express.static(path.join(__dirname, '../docs')));
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: require('../package.json').version,
                uptime: process.uptime()
            });
        });

        // API routes
        this.app.use('/api/v1/health-data', healthDataRoutes);
        this.app.use('/api/v1/sync', syncRoutes);
        this.app.use('/api/v1/bluetooth', bluetoothRoutes);
        this.app.use('/api/v1/data', iosDataRoutes); // iOS data compatibility routes
        this.app.use('/api/v1/health', iosHealthRoutes); // iOS health compatibility routes

        // Root endpoint with API documentation
        this.app.get('/', (req, res) => {
            res.json({
                name: 'Galaxy Watch Local Data Sync Server',
                version: require('../package.json').version,
                description: 'Privacy-focused health data synchronization between Samsung Galaxy Watch and iPhone',
                endpoints: {
                    health: '/health',
                    documentation: '/docs',
                    api: {
                        healthData: '/api/v1/health-data',
                        sync: '/api/v1/sync',
                        bluetooth: '/api/v1/bluetooth'
                    }
                },
                architecture: {
                    primary: 'Local Wi-Fi Server (REST API)',
                    fallback: 'Bluetooth Low Energy (BLE)',
                    database: 'SQLite',
                    syncMethod: 'Timestamp-based stateful synchronization'
                }
            });
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                path: req.originalUrl,
                method: req.method,
                timestamp: new Date().toISOString()
            });
        });
    }

    setupErrorHandling() {
        // Global error handler
        this.app.use((err, req, res, next) => {
            logger.error('Unhandled error:', err);
            
            const status = err.status || 500;
            const message = status === 500 ? 'Internal server error' : err.message;
            
            res.status(status).json({
                error: message,
                timestamp: new Date().toISOString(),
                ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
            });
        });

        // Process error handlers
        process.on('uncaughtException', (err) => {
            logger.error('Uncaught Exception:', err);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });
    }

    async start() {
        try {
            // Initialize database
            await initDatabase();
            logger.info('Database initialized successfully');

            // Start server
            const port = config.server.port;
            const host = config.server.host;

            this.server = this.app.listen(port, host, () => {
                logger.info(`🚀 Galaxy Watch Sync Server started on http://${host}:${port}`);
                logger.info(`📱 WearOS devices can connect to: http://${this.getLocalIP()}:${port}`);
                logger.info(`📱 iOS devices can connect to: http://${this.getLocalIP()}:${port}`);
                logger.info(`📖 API Documentation: http://${host}:${port}/docs`);
                logger.info(`🔍 Health check: http://${host}:${port}/health`);
            });

            // Handle graceful shutdown
            this.setupGracefulShutdown();

        } catch (error) {
            logger.error('Failed to start server:', error);
            process.exit(1);
        }
    }

    getLocalIP() {
        const { networkInterfaces } = require('os');
        const nets = networkInterfaces();
        
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                // Skip over non-IPv4 and internal addresses
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return 'localhost';
    }

    setupGracefulShutdown() {
        const shutdown = (signal) => {
            logger.info(`${signal} received. Shutting down gracefully...`);
            
            if (this.server) {
                this.server.close((err) => {
                    if (err) {
                        logger.error('Error during server shutdown:', err);
                        process.exit(1);
                    }
                    logger.info('Server closed successfully');
                    process.exit(0);
                });
            } else {
                process.exit(0);
            }
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
}

// Start server if this file is run directly
if (require.main === module) {
    const server = new GalaxyWatchSyncServer();
    server.start();
}

module.exports = GalaxyWatchSyncServer;
