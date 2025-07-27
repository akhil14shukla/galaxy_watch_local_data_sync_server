# Copilot Instructions

<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

## Project Overview

This is a Galaxy Watch Local Data Sync Server project that enables privacy-focused health data synchronization between Samsung Galaxy Watch (WearOS) and iPhone (iOS/Apple Health) without relying on cloud services like Firebase.

## Architecture

- **Two-tiered hybrid model** with timestamped health data for stateful synchronization
- **Primary Transport**: Local Wi-Fi Server (Node.js/Express REST API)
- **Fallback Transport**: Bluetooth Low Energy (BLE) for offline syncing
- **Cross-platform server** running on Windows laptop and macOS

## Key Components

1. **Local Server** (`/server/`) - Node.js/Express with SQLite database
2. **API Endpoints** - RESTful API for health data exchange
3. **BLE Implementation** - Bluetooth fallback for direct device communication
4. **WearOS Integration** - Android/Kotlin client code examples
5. **iOS Integration** - Swift client code examples with HealthKit
6. **State Management** - Timestamp-based sync state tracking

## Development Guidelines

- Use modern JavaScript/ES6+ syntax
- Implement robust error handling and state management
- Follow RESTful API best practices
- Ensure cross-platform compatibility (Windows/macOS)
- Prioritize data privacy and local-first architecture
- Include comprehensive API documentation
- Implement proper logging and monitoring

## Health Data Types

Focus on common health metrics: heart rate, steps, sleep data, daily activity metrics, GPS routes, and other Samsung Health/Apple Health compatible data formats.

## Security Considerations

- Local network encryption
- Data validation and sanitization
- Secure BLE communication protocols
- No sensitive data stored in logs
