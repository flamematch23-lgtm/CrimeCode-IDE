# OpenCode Desktop v1.3.4 Release Notes

**Release Date:** April 16, 2026  
**Version:** 1.3.4  
**Build:** Windows x64

## What's New

### UI Overhaul

This release brings a completely refreshed user interface with:

- **Tools Dashboard** - Browse and filter 23+ integrated tools by category
- **Activity Feed** - Real-time updates on task status and completion
- **Enhanced Status Bar** - Multi-layer health monitoring for all services
- **Theme Switcher** - Toggle between light and dark modes (persisted)
- **Quick Action Sidebar** - Keyboard shortcut hints and fast navigation

### New Animations

- `fadeInSlide` - Smooth fade with vertical slide
- `slideInLeft` - Horizontal slide from left edge
- `pulse-glow` - Subtle pulsing glow effect

## Bug Fixes

| Issue                            | Status |
| -------------------------------- | ------ |
| CLI sidecar not found on startup | Fixed  |
| Incorrect "CrimeCode" branding   | Fixed  |
| Unstructured console logging     | Fixed  |
| Invite tool registration         | Fixed  |

## Improvements

- Replaced all `console.log` with structured JSON logging
- Added detailed timeout documentation in source code
- Enhanced CSS animations with smooth transitions
- Improved text truncation utilities

## Known Issues

- None reported

## System Requirements

- **OS:** Windows 10 or later (x64)
- **RAM:** 4GB minimum (8GB recommended)
- **Disk:** 500MB free space

## Installation

1. Download `opencode-electron-win-x64.exe`
2. Run the installer
3. Launch OpenCode from Start Menu

## Upgrading

The installer will automatically replace the previous version. Your settings and sessions will be preserved.

## Support

For issues and feedback, please open an issue at:
https://github.com/anomalyco/opencode/issues
