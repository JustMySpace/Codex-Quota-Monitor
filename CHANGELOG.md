# Changelog

[简体中文](CHANGELOG.zh-CN.md)

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Add an optional launch-at-login checkbox backed by the system autostart mechanism on Windows, macOS, and Linux.

### Fixed

- Prevent burn-down chart X-axis labels from overlapping by adding separate Start/Reset boundary lines, a dedicated Now marker, and daily date/time ticks.
- Persist token metadata in a local SQLite ledger so recorded usage survives source conversation deletion, with incremental deduplication and an explicit history reset action.
- Keep today's token totals stable when conversations are archived by scanning both active and archived Codex session logs.
- Select the main weekly quota from the seven-day rate-limit window for normal models, whether it is reported as `primary` or `secondary`.
- Ignore Spark-only quota snapshots using the session model and context metadata.
- Preserve the latest valid main weekly quota when the newest session event belongs to Spark.
- Show an unknown quota state instead of `100%` when no valid main weekly quota is available.
- Anchor the burn-down chart at `100%` when the first local snapshot is recorded after reset.
- Recognize seven-day limits in either rate-limit slot for normal models while excluding Spark sessions by model/context metadata.
- Ignore expired reset snapshots instead of rendering an old quota cycle beyond its seven-day window.

## [0.1.0] - 2026-07-16

### Added

- Local Codex session log monitoring without sending usage data to a server.
- Minute-level token aggregation for fresh input, cached input, output, and reasoning output.
- Today's cumulative token usage curve.
- Realtime token usage curve for the most recent hour.
- Five-minute stacked token usage chart.
- Floating monitor window with a compact and expanded state.
- Double-click behavior for opening the full monitor panel.
- Clickable right-side floating widget for switching between five-minute usage and today's cumulative curve.
- Drag-to-move support for the floating window and full panel.
- Right-click opacity controls for the floating window only.
- System tray menu with show/hide, opacity, and quit actions.
- Quota remaining display, reset-window usage, recent sessions, and context limit information.
- Quota burn-down chart from the previous reset to the next reset.
- Configurable burn-down chart use days with all days enabled by default.
- Manual and system-following theme selection for dark and light modes.
- System language detection and manual switching across ten common languages.
- English and Simplified Chinese documentation with screenshots.
- Windows NSIS installer and executable packaging support.
- macOS source build and packaging support.
- WTFPL license.

### Changed

- The floating window always shows today's total token usage and remaining quota percentage.
- Floating-window opacity no longer changes the full monitor panel.
- The compact window layout keeps the clock and status line stable when switching chart modes.
- The compact window no longer displays the redundant "double click panel" hint.
- The floating window uses a wider drag area while preserving button clicks and double-click behavior.
- The floating window no longer shows a move/size cursor during normal hover.
- The full panel uses a borderless layout without the previous transparent outer frame.
- Stacked chart legends now display the correct color swatches and labels.

### Fixed

- Quota remaining percentage could show an older value because rate-limit events were selected by file order instead of event timestamp.
- Floating-window text and chart content could overlap when switching display modes.
- Dragging could interfere with double-clicking the floating window.
- Opacity controls in the tray menu were exposed at the wrong menu level.

### Build

- Verified Windows release build with the NSIS bundle target.
- Generated artifacts:
  - `src-tauri/target/release/codex-quota-monitor.exe`
  - `src-tauri/target/release/bundle/nsis/Codex Quota Monitor_0.1.0_x64-setup.exe`

[0.1.0]: https://github.com/JustMySpace/Codex-Quota-Monitor/releases/tag/v0.1.0
