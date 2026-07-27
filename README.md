# Codex Quota Monitor

[简体中文](README.zh-CN.md)

A local Tauri desktop floating monitor for Codex quota and token usage. Token metadata stays on your machine. For current quota status, the monitor asks the local experimental Codex app-server, which may contact OpenAI using your existing Codex sign-in; conversation content is never read or sent by the monitor.

## Features

- Reads `token_count` events from local Codex session logs.
- Reads the current main quota from the experimental local Codex app-server every 15 seconds, with session-log quota snapshots as a fallback.
- Aggregates `input`, `cached input`, `output`, and `reasoning output` tokens by minute.
- Desktop floating window: the left side always shows today's total token usage, and the right side can switch between the latest 5-minute usage and today's cumulative curve.
- Double-click the floating window to open a separate full panel.
- Full panel supports a reset-window quota burn-down chart with configurable use days, switching between today's cumulative curve and realtime curve, plus a 5-minute stacked chart, quota remaining, and recent sessions.
- Floating window opacity can be adjusted from the right-click menu or tray menu. The full panel is not affected by opacity settings.
- Dark and light themes can be switched manually.
- Supports system language detection plus manual switching across 10 common languages.
- Optional launch-at-login setting for Windows, macOS, and Linux, synchronized with the system login item state.
- System tray support. If tray creation fails, the monitor window still runs.

## Screenshots

Floating window, latest 5-minute token usage:

![Floating window 5-minute token usage](docs/images/float-5min.png)

Floating window, today's cumulative curve:

![Floating window today's cumulative curve](docs/images/float-today-curve.png)

Full panel, today's cumulative curve:

![Full panel today's cumulative curve](docs/images/panel-cumulative.png)

Full panel, quota burn-down:

![Full panel quota burn-down](docs/images/panel-burn-down.png)

Full panel, 5-minute stacked chart:

![Full panel 5-minute stacked chart](docs/images/panel-stacked.png)

## Data Locations

Monitor source:

- The `codex` CLI must be available on `PATH` for live quota lookup. The app-server protocol is experimental and may change between Codex releases.
- Windows: `%USERPROFILE%\.codex\sessions` and `%USERPROFILE%\.codex\archived_sessions`
- macOS/Linux: `$HOME/.codex/sessions` and `$HOME/.codex/archived_sessions`
- Override with `CODEX_HOME`.

Persistent local ledger (stores token metadata only, never conversation content):

- Windows: `%APPDATA%\CodexQuotaMonitor\usage-ledger.sqlite`
- macOS: `~/Library/Application Support/CodexQuotaMonitor/usage-ledger.sqlite`
- Linux: `$XDG_CONFIG_HOME/CodexQuotaMonitor/usage-ledger.sqlite` or `~/.config/CodexQuotaMonitor/usage-ledger.sqlite`
- Override the containing directory with `CODEX_QUOTA_MONITOR_HOME`.
- Once an event has been recorded, archiving or deleting its source conversation does not reduce the displayed usage.
- The expanded panel can clear recorded token history and restart counting from that moment; quota snapshots are retained.
- Events deleted before the monitor first records them cannot be reconstructed.

## Development

Generic:

```bash
npm install
npm run dev
```

Windows, when the current shell has not initialized the MSVC environment:

```powershell
npm install
npm run dev:win
```

macOS:

```bash
npm install
npm run dev:mac
```

## Windows Packaging

Requirements:

- Node.js 20+
- Rust stable
- Visual Studio Build Tools 2022 or Visual Studio Community with the MSVC C++ toolchain and Windows SDK
- WebView2 Runtime

Build:

```powershell
npm install
npm run build:win
```

Common artifacts:

- `src-tauri/target/release/codex-quota-monitor.exe`
- `src-tauri/target/release/bundle/msi/Codex Quota Monitor_0.1.0_x64_en-US.msi`
- `src-tauri/target/release/bundle/nsis/Codex Quota Monitor_0.1.0_x64-setup.exe`

If you are already in Developer PowerShell or an MSVC-initialized shell, you can also use:

```powershell
npm run build
```

## macOS Packaging

The code supports macOS source builds and packaging, but macOS artifacts must be produced on a macOS machine.

Requirements:

- Node.js 20+
- Rust stable
- Xcode Command Line Tools

Prepare:

```bash
xcode-select --install
npm install
```

Build:

```bash
npm run build:mac
```

Common artifact locations:

- `src-tauri/target/release/bundle/macos/`
- `src-tauri/target/release/bundle/dmg/`

Without Apple Developer signing, generated `.app` or `.dmg` files may need to be manually allowed in local security settings. For public distribution, configure macOS signing and notarization.

## Notes

The repository does not commit local build outputs, `node_modules`, Tauri target directories, or machine-specific Cargo configuration.

## License

WTFPL. See [LICENSE](LICENSE).
