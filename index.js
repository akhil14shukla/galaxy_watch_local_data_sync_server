#!/usr/bin/env node

/**
 * Galaxy Watch Local Data Sync Server
 * 
 * Entry point for the local data synchronization server.
 * Supports cross-platform operation on Windows and macOS.
 */

const GalaxyWatchSyncServer = require('./server/app');
const { logger } = require('./server/utils/logger');
const config = require('./server/config/config');

// ASCII art banner
const banner = `
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║    🌌 Galaxy Watch Local Data Sync Server                      ║
║                                                                ║
║    Privacy-focused health data synchronization                ║
║    Between Samsung Galaxy Watch & iPhone                      ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`;

console.log(banner);

// Display system information
logger.info('System Information:');
logger.info(`- Platform: ${process.platform}`);
logger.info(`- Architecture: ${process.arch}`);
logger.info(`- Node.js Version: ${process.version}`);
logger.info(`- Working Directory: ${process.cwd()}`);
logger.info(`- Environment: ${config.server.environment}`);

// Create and start the server
const server = new GalaxyWatchSyncServer();

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => {
    logger.info('Received SIGTERM signal');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('Received SIGINT signal (Ctrl+C)');
    process.exit(0);
});

// Start the server
server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
});
