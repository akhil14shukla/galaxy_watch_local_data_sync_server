#!/usr/bin/env node

/**
 * Galaxy Watch Enhanced Local Data Sync Server Starter
 * 
 * Simple starter script for the enhanced server with proper error handling
 */

const path = require('path');
const { logger } = require('./server/utils/logger');

// ASCII art banner
const banner = `
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║    🌌 Galaxy Watch Enhanced Sync Server                        ║
║                                                                ║
║    🚀 With Real-time Analytics & WebSocket Support             ║
║    📊 Advanced Health Insights & Goal Tracking                 ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`;

console.log(banner);

async function startServer() {
    try {
        logger.info('🚀 Starting Galaxy Watch Enhanced Sync Server...');
        logger.info(`📁 Working directory: ${process.cwd()}`);
        logger.info(`🖥️  Platform: ${process.platform}`);
        logger.info(`⚡ Node.js version: ${process.version}`);
        
        // Import and start the enhanced server
        const GalaxyWatchSyncServer = require('./server/app_enhanced');
        
        logger.info('📦 Enhanced server module loaded successfully');
        
        // Create and start server instance
        const server = new GalaxyWatchSyncServer();
        await server.start();
        
        logger.info('✅ Galaxy Watch Enhanced Sync Server started successfully!');
        logger.info('🌐 Server is ready to accept connections');
        
    } catch (error) {
        logger.error('❌ Failed to start server:', error);
        logger.error('📋 Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
        
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error('💥 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the server
startServer();
