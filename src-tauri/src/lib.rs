use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Emitter,
    image::Image,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow, WindowEvent,
};

const LOOKBACK_DAYS: u64 = 30;
const COLLAPSED_WIDTH: f64 = 304.0;
const COLLAPSED_HEIGHT: f64 = 136.0;
const EXPANDED_WIDTH: f64 = 1040.0;
const EXPANDED_HEIGHT: f64 = 760.0;

#[derive(Debug, Clone, Default, Serialize)]
struct TokenCounts {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct MinuteBucket {
    minute: String,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    events: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct Totals {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    events: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct CreditsSnapshot {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct RateLimitSnapshot {
    used_percent: Option<f64>,
    window_minutes: Option<u64>,
    resets_at: Option<i64>,
    plan_type: Option<String>,
    credits: Option<CreditsSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct LatestUsage {
    timestamp: String,
    minute: String,
    last: TokenCounts,
    total: TokenCounts,
    model_context_window: Option<u64>,
    rate_limit: Option<RateLimitSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct SessionSummary {
    id: String,
    first_seen: Option<String>,
    last_seen: Option<String>,
    total_tokens: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    events: u64,
    last_cumulative_total: u64,
}

#[derive(Debug, Clone, Serialize)]
struct UsageDashboard {
    scanned_at_ms: u64,
    lookback_days: u64,
    codex_sessions_path: String,
    cache_path: String,
    totals: Totals,
    latest: Option<LatestUsage>,
    buckets: Vec<MinuteBucket>,
    sessions: Vec<SessionSummary>,
    errors: Vec<String>,
}

#[tauri::command]
fn scan_codex_usage() -> Result<UsageDashboard, String> {
    let sessions_dir = codex_sessions_dir();
    let cache_path = app_data_dir().join("usage-cache.json");
    let scanned_at_ms = now_ms();
    let mut errors = Vec::new();
    let mut buckets: BTreeMap<String, MinuteBucket> = BTreeMap::new();
    let mut sessions: BTreeMap<String, SessionSummary> = BTreeMap::new();
    let mut totals = Totals::default();
    let mut latest: Option<LatestUsage> = None;

    if !sessions_dir.exists() {
        errors.push(format!(
            "Codex sessions directory was not found: {}",
            sessions_dir.display()
        ));
    } else {
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(LOOKBACK_DAYS * 24 * 60 * 60))
            .unwrap_or(UNIX_EPOCH);
        let mut files = Vec::new();
        collect_jsonl_files(&sessions_dir, cutoff, &mut files, &mut errors);
        files.sort();

        for file in files {
            if let Err(error) = scan_session_file(&file, &mut buckets, &mut sessions, &mut totals, &mut latest) {
                errors.push(format!("{}: {}", file.display(), error));
            }
        }
    }

    let mut dashboard = UsageDashboard {
        scanned_at_ms,
        lookback_days: LOOKBACK_DAYS,
        codex_sessions_path: sessions_dir.to_string_lossy().to_string(),
        cache_path: cache_path.to_string_lossy().to_string(),
        totals,
        latest,
        buckets: buckets.into_values().collect(),
        sessions: sessions.into_values().rev().take(20).collect(),
        errors,
    };

    if let Err(error) = write_dashboard_cache(&cache_path, &dashboard) {
        dashboard
            .errors
            .push(format!("Failed to write local cache: {}", error));
    }

    Ok(dashboard)
}

#[tauri::command]
fn open_panel(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or_else(|| "Panel window was not found".to_string())?;
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            EXPANDED_WIDTH,
            EXPANDED_HEIGHT,
        )))
        .map_err(|error| error.to_string())?;
    window.set_resizable(true).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_panel(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_codex_usage, open_panel, hide_panel])
        .setup(|app| {
            configure_main_window(app);
            if let Err(error) = setup_tray(app) {
                eprintln!("failed to create tray icon: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Codex Quota Monitor");
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示 / 隐藏")
        .separator()
        .text("opacity_40", "透明度 40%")
        .text("opacity_55", "透明度 55%")
        .text("opacity_70", "透明度 70%")
        .text("opacity_82", "透明度 82%")
        .text("opacity_100", "透明度 100%")
        .separator()
        .text("quit", "退出")
        .build()?;

    let tray_icon = build_tray_icon();
    TrayIconBuilder::with_id("codex-quota-monitor")
        .icon(tray_icon)
        .tooltip("Codex Quota Monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_float_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => toggle_float_window(app),
            "opacity_40" => emit_opacity(app, 0.4),
            "opacity_55" => emit_opacity(app, 0.55),
            "opacity_70" => emit_opacity(app, 0.7),
            "opacity_82" => emit_opacity(app, 0.82),
            "opacity_100" => emit_opacity(app, 1.0),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn emit_opacity(app: &tauri::AppHandle, opacity: f64) {
    let _ = app.emit("opacity-change", opacity);
    if let Some(window) = app.get_webview_window("float") {
        let _ = window.show();
    }
}

fn configure_main_window(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("float") {
        configure_float_window(&window);
    }
    if let Some(window) = app.get_webview_window("panel") {
        configure_panel_window(&window);
    }
}

fn configure_float_window(window: &WebviewWindow) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_resizable(false);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        COLLAPSED_WIDTH,
        COLLAPSED_HEIGHT,
    )));
}

fn configure_panel_window(window: &WebviewWindow) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_resizable(true);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        EXPANDED_WIDTH,
        EXPANDED_HEIGHT,
    )));
}

fn toggle_float_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("float") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn scan_session_file(
    path: &Path,
    buckets: &mut BTreeMap<String, MinuteBucket>,
    sessions: &mut BTreeMap<String, SessionSummary>,
    totals: &mut Totals,
    latest: &mut Option<LatestUsage>,
) -> Result<(), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let session_id = session_id_from_path(path);

    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        if !line.contains("\"token_count\"") {
            continue;
        }

        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }

        let payload = value.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }

        let timestamp = match value.get("timestamp").and_then(Value::as_str) {
            Some(timestamp) => timestamp.to_string(),
            None => continue,
        };
        let minute = minute_key(&timestamp);
        let info = payload.get("info").unwrap_or(&Value::Null);
        let last = token_counts(info.get("last_token_usage").unwrap_or(&Value::Null));
        let cumulative = token_counts(info.get("total_token_usage").unwrap_or(&Value::Null));
        let rate_limit = rate_limit_snapshot(payload.get("rate_limits").unwrap_or(&Value::Null));
        let model_context_window = info
            .get("model_context_window")
            .and_then(Value::as_u64);

        add_to_totals(totals, &last);
        let bucket = buckets.entry(minute.clone()).or_insert_with(|| MinuteBucket {
            minute: minute.clone(),
            ..MinuteBucket::default()
        });
        add_to_bucket(bucket, &last);

        let session = sessions.entry(session_id.clone()).or_insert_with(|| SessionSummary {
            id: session_id.clone(),
            ..SessionSummary::default()
        });
        update_session(session, &timestamp, &last, &cumulative);

        *latest = Some(LatestUsage {
            timestamp,
            minute,
            last,
            total: cumulative,
            model_context_window,
            rate_limit,
        });
    }

    Ok(())
}

fn collect_jsonl_files(
    dir: &Path,
    cutoff: SystemTime,
    files: &mut Vec<PathBuf>,
    errors: &mut Vec<String>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!("Failed to read {}: {}", dir.display(), error));
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, cutoff, files, errors);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }

        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::now());
        if modified >= cutoff {
            files.push(path);
        }
    }
}

fn token_counts(value: &Value) -> TokenCounts {
    TokenCounts {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        cached_input_tokens: value
            .get("cached_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        reasoning_output_tokens: value
            .get("reasoning_output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    }
}

fn rate_limit_snapshot(value: &Value) -> Option<RateLimitSnapshot> {
    if !value.is_object() {
        return None;
    }

    let primary = value.get("primary").unwrap_or(&Value::Null);
    let credits_value = value.get("credits").unwrap_or(&Value::Null);
    let credits = if credits_value.is_object() {
        Some(CreditsSnapshot {
            has_credits: credits_value
                .get("has_credits")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            unlimited: credits_value
                .get("unlimited")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            balance: credits_value
                .get("balance")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        })
    } else {
        None
    };

    Some(RateLimitSnapshot {
        used_percent: primary.get("used_percent").and_then(Value::as_f64),
        window_minutes: primary.get("window_minutes").and_then(Value::as_u64),
        resets_at: primary
            .get("resets_at")
            .and_then(Value::as_i64)
            .or_else(|| primary.get("resets_at").and_then(Value::as_u64).map(|value| value as i64)),
        plan_type: value
            .get("plan_type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        credits,
    })
}

fn add_to_totals(totals: &mut Totals, counts: &TokenCounts) {
    totals.input_tokens += counts.input_tokens;
    totals.cached_input_tokens += counts.cached_input_tokens;
    totals.output_tokens += counts.output_tokens;
    totals.reasoning_output_tokens += counts.reasoning_output_tokens;
    totals.total_tokens += counts.total_tokens;
    totals.events += 1;
}

fn add_to_bucket(bucket: &mut MinuteBucket, counts: &TokenCounts) {
    bucket.input_tokens += counts.input_tokens;
    bucket.cached_input_tokens += counts.cached_input_tokens;
    bucket.output_tokens += counts.output_tokens;
    bucket.reasoning_output_tokens += counts.reasoning_output_tokens;
    bucket.total_tokens += counts.total_tokens;
    bucket.events += 1;
}

fn update_session(
    session: &mut SessionSummary,
    timestamp: &str,
    last: &TokenCounts,
    cumulative: &TokenCounts,
) {
    if session.first_seen.is_none() {
        session.first_seen = Some(timestamp.to_string());
    }
    session.last_seen = Some(timestamp.to_string());
    session.input_tokens += last.input_tokens;
    session.cached_input_tokens += last.cached_input_tokens;
    session.output_tokens += last.output_tokens;
    session.reasoning_output_tokens += last.reasoning_output_tokens;
    session.total_tokens += last.total_tokens;
    session.events += 1;
    session.last_cumulative_total = cumulative.total_tokens;
}

fn minute_key(timestamp: &str) -> String {
    if timestamp.len() >= 16 {
        format!("{}:00Z", &timestamp[..16])
    } else {
        timestamp.to_string()
    }
}

fn session_id_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown-session");
    if stem.len() >= 36 {
        stem[stem.len() - 36..].to_string()
    } else {
        stem.to_string()
    }
}

fn write_dashboard_cache(path: &Path, dashboard: &UsageDashboard) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_vec_pretty(dashboard).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn codex_sessions_dir() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
        .join("sessions")
}

fn app_data_dir() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_QUOTA_MONITOR_HOME") {
        return PathBuf::from(path);
    }

    if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join("CodexQuotaMonitor")
    } else if cfg!(target_os = "macos") {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("CodexQuotaMonitor")
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("CodexQuotaMonitor")
    }
}

fn home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_tray_icon() -> Image<'static> {
    let width = 32;
    let height = 32;
    let mut rgba = vec![0u8; width * height * 4];

    for y in 0..height {
        for x in 0..width {
            let dx = x as i32 - 16;
            let dy = y as i32 - 16;
            let distance_squared = dx * dx + dy * dy;
            let index = (y * width + x) * 4;

            if distance_squared <= 196 {
                rgba[index] = 22;
                rgba[index + 1] = 28;
                rgba[index + 2] = 38;
                rgba[index + 3] = 255;
            }
            if distance_squared <= 144 && distance_squared >= 112 {
                rgba[index] = 72;
                rgba[index + 1] = 187;
                rgba[index + 2] = 120;
                rgba[index + 3] = 255;
            }
        }
    }

    for x in 9..23 {
        let y = 20 - ((x as i32 - 9) * 8 / 13) as usize;
        for yy in y.saturating_sub(1)..=(y + 1).min(height - 1) {
            let index = (yy * width + x) * 4;
            rgba[index] = 242;
            rgba[index + 1] = 201;
            rgba[index + 2] = 76;
            rgba[index + 3] = 255;
        }
    }

    Image::new_owned(rgba, width as u32, height as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minute_key_truncates_to_minute() {
        assert_eq!(
            minute_key("2026-07-16T02:05:11.176Z"),
            "2026-07-16T02:05:00Z"
        );
    }

    #[test]
    fn session_id_uses_uuid_suffix() {
        let path = PathBuf::from(
            "rollout-2026-07-16T10-03-03-019f68a9-adf2-7090-b9de-16acdba46e08.jsonl",
        );
        assert_eq!(
            session_id_from_path(&path),
            "019f68a9-adf2-7090-b9de-16acdba46e08"
        );
    }
}
