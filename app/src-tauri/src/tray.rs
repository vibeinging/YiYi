use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tokio::sync::RwLock;

use crate::state::AppState;

// Menu item IDs
const MENU_SHOW: &str = "show";
const MENU_NEW_SESSION: &str = "new_session";
const MENU_ACTIVE_TASKS: &str = "active_tasks";
const MENU_BOT_STATUS: &str = "bot_status";
const MENU_TOGGLE_BOTS: &str = "toggle_bots";
const MENU_NAV_BUDDY: &str = "nav_buddy";
const MENU_NAV_AGENTS: &str = "nav_agents";
const MENU_NAV_SETTINGS: &str = "nav_settings";
const MENU_QUIT: &str = "quit";

/// Menu items that are dynamically updated as state changes.
pub struct TrayMenuState {
    pub active_tasks_item: MenuItem<tauri::Wry>,
    pub bot_status_item: MenuItem<tauri::Wry>,
    pub toggle_bots_item: MenuItem<tauri::Wry>,
}

/// Create and configure the system tray icon with menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id(MENU_SHOW, "显示主窗口").build(app)?;
    let new_session_item = MenuItemBuilder::with_id(MENU_NEW_SESSION, "新对话").build(app)?;

    let active_tasks_item = MenuItemBuilder::with_id(MENU_ACTIVE_TASKS, "活跃任务: 0")
        .enabled(false)
        .build(app)?;
    let bot_status_item = MenuItemBuilder::with_id(MENU_BOT_STATUS, "Bot: 0 个已连接")
        .enabled(false)
        .build(app)?;
    let toggle_bots_item =
        MenuItemBuilder::with_id(MENU_TOGGLE_BOTS, "暂停所有 Bot").build(app)?;

    let nav_buddy_item = MenuItemBuilder::with_id(MENU_NAV_BUDDY, "跳转到精灵").build(app)?;
    let nav_agents_item = MenuItemBuilder::with_id(MENU_NAV_AGENTS, "跳转到分身").build(app)?;
    let nav_settings_item =
        MenuItemBuilder::with_id(MENU_NAV_SETTINGS, "跳转到设置").build(app)?;

    let version_label = format!("YiYi v{}", env!("CARGO_PKG_VERSION"));
    let version_item = MenuItemBuilder::with_id("version", version_label)
        .enabled(false)
        .build(app)?;
    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&new_session_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&active_tasks_item)
        .item(&bot_status_item)
        .item(&toggle_bots_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&nav_buddy_item)
        .item(&nav_agents_item)
        .item(&nav_settings_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&version_item)
        .item(&quit_item)
        .build()?;

    let tray_state = TrayMenuState {
        active_tasks_item: active_tasks_item.clone(),
        bot_status_item: bot_status_item.clone(),
        toggle_bots_item: toggle_bots_item.clone(),
    };
    app.manage(Arc::new(RwLock::new(tray_state)));

    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
        .expect("failed to load embedded tray icon");

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("YiYi")
        .menu(&menu)
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Prime the dynamic labels immediately so the first menu open isn't stale.
    let app_for_init = app.clone();
    tauri::async_runtime::spawn(async move {
        update_tray_status(&app_for_init).await;
    });

    // Periodic refresh while the app is running.
    let app_for_update = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            update_tray_status(&app_for_update).await;
        }
    });

    Ok(())
}

fn handle_menu_event(app: &AppHandle, menu_id: &str) {
    match menu_id {
        MENU_SHOW => show_main_window(app),
        MENU_NEW_SESSION => {
            show_main_window(app);
            app.emit("tray://new-session", ()).ok();
        }
        MENU_ACTIVE_TASKS => {
            // Clicking the status label just surfaces the main window.
            show_main_window(app);
        }
        MENU_TOGGLE_BOTS => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                toggle_all_bots(&app).await;
            });
        }
        MENU_NAV_BUDDY => navigate_to(app, "growth", None),
        MENU_NAV_AGENTS => navigate_to(app, "settings", Some("agents")),
        MENU_NAV_SETTINGS => navigate_to(app, "settings", None),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

/// Bring the main window to front and ask the frontend to switch page.
fn navigate_to(app: &AppHandle, page: &str, tab: Option<&str>) {
    show_main_window(app);
    let payload = serde_json::json!({ "page": page, "tab": tab });
    app.emit("tray://navigate", payload).ok();
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            window.hide().ok();
        } else {
            window.show().ok();
            window.unminimize().ok();
            window.set_focus().ok();
        }
    }
}

async fn toggle_all_bots(app: &AppHandle) {
    let state = app.state::<AppState>();
    let manager = &state.bot_manager;
    let is_running = manager.is_running().await;

    if is_running {
        manager.stop().await;
        log::info!("All bots paused via tray menu");
    } else {
        let app_handle = app.clone();
        manager
            .start(std::sync::Arc::new(state.clone_shared()), app_handle)
            .await;
        log::info!("All bots resumed via tray menu");
    }

    update_tray_status(app).await;
}

/// Refresh the dynamic menu labels (active task count, bot status, toggle label).
async fn update_tray_status(app: &AppHandle) {
    let state = app.state::<AppState>();
    let manager = &state.bot_manager;
    let connected = manager.connected_count().await;
    let is_running = manager.is_running().await;

    // Count running + pending tasks from DB.
    let active_tasks = {
        let running = state.db.list_tasks(None, Some("running")).unwrap_or_default().len();
        let pending = state.db.list_tasks(None, Some("pending")).unwrap_or_default().len();
        let paused = state.db.list_tasks(None, Some("paused")).unwrap_or_default().len();
        running + pending + paused
    };

    let tray_state = app.state::<Arc<RwLock<TrayMenuState>>>();
    let tray_menu = tray_state.read().await;

    tray_menu
        .active_tasks_item
        .set_text(format!("活跃任务: {}", active_tasks))
        .ok();

    let bot_text = if is_running {
        format!("Bot: {} 个已连接", connected)
    } else {
        format!("Bot: 已暂停 ({} 个)", connected)
    };
    tray_menu.bot_status_item.set_text(bot_text).ok();

    let toggle_label = if is_running { "暂停所有 Bot" } else { "恢复所有 Bot" };
    tray_menu.toggle_bots_item.set_text(toggle_label).ok();
}
