# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [1.3.5] - 2026-04-28

### Added
- NO_SIGN flag for release script to skip signing in local development

### Changed
- CI: add typecheck for Desktop and cargo check for TAURI before full build
- Desktop: silence dead_code warnings in release builds via cfg gates; gating of exporter in debug
- Web/Desktop client: prepare release notes scaffolding (for new release)

### Fixed
- Minor fixes to release pipeline and logging

## [1.3.4] - 2026-04-16

### Added
- Comprehensive UI enhancements to desktop application
- 6 new polished UI components:
  - Tools Dashboard with category filtering for 23+ tools
  - Activity Feed with real-time status indicators
  - Enhanced Status Bar with multi-layer service health monitoring
  - Loading Screen with modern animations and progress tracking
  - Quick Action Sidebar with keyboard shortcut hints
  - Theme Switcher for light/dark mode
- 3 new CSS animation keyframes (fadeInSlide, slideInLeft, pulse-glow)
- Light/dark theme switching with persistence

### Fixed
- Sidecar binary bundling issue - CLI now properly bundled in electron-builder resources
- Console logging replaced with structured logging for better observability
- Branding issue - CrimeCode replaced with OpenCode in error dialogs
- Invite tool implementation - proper Tool.define() created with create/list actions
- File-based image handling in tests and tool outputs

### Changed
- All console.log calls replaced with logger instances using JSON metadata format
- Improved timeout documentation with explanatory comments
- CSS utilities enhanced with smooth transitions and text truncation

### Removed
- Base64 image patterns from all tool outputs

## [1.3.3] - Previous Release

- See git history for details
