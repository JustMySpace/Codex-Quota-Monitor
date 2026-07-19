mod usage;

use tauri::{
    image::Image,
    menu::{MenuBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewWindow, WindowEvent,
};

const COLLAPSED_WIDTH: f64 = 304.0;
const COLLAPSED_HEIGHT: f64 = 136.0;
const EXPANDED_WIDTH: f64 = 1040.0;
const EXPANDED_HEIGHT: f64 = 760.0;

#[tauri::command]
fn scan_codex_usage() -> Result<usage::UsageDashboard, String> {
    usage::scan_codex_usage()
}

#[tauri::command]
fn reset_token_history() -> Result<usage::UsageDashboard, String> {
    usage::reset_token_history()
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
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
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
        .invoke_handler(tauri::generate_handler![
            scan_codex_usage,
            reset_token_history,
            open_panel,
            hide_panel
        ])
        .setup(|app| {
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

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
    let opacity_menu = SubmenuBuilder::new(app, "透明度")
        .text("opacity_40", "40%")
        .text("opacity_55", "55%")
        .text("opacity_70", "70%")
        .text("opacity_82", "82%")
        .text("opacity_100", "100%")
        .build()?;
    let menu = MenuBuilder::new(app)
        .text("show", "显示 / 隐藏")
        .separator()
        .item(&opacity_menu)
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
            if (112..=144).contains(&distance_squared) {
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
