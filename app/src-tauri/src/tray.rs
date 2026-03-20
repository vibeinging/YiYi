use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tokio::sync::RwLock;

use crate::state::AppState;

/// Menu item IDs
const MENU_SHOW: &str = "show";
const MENU_NEW_SESSION: &str = "new_session";
const MENU_BOT_STATUS: &str = "bot_status";
const MENU_TOGGLE_BOTS: &str = "toggle_bots";
const MENU_QUIT: &str = "quit";

/// Holds references to dynamically-updated tray menu items.
pub struct TrayMenuState {
    pub bot_status_item: MenuItem<tauri::Wry>,
    pub toggle_bots_item: MenuItem<tauri::Wry>,
}

/// Create and configure the system tray icon with menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id(MENU_SHOW, "打开 YiYi").build(app)?;
    let new_session_item =
        MenuItemBuilder::with_id(MENU_NEW_SESSION, "新对话").build(app)?;
    let bot_status_item = MenuItemBuilder::with_id(MENU_BOT_STATUS, "Bot 状态: 检查中...")
        .enabled(false)
        .build(app)?;
    let toggle_bots_item =
        MenuItemBuilder::with_id(MENU_TOGGLE_BOTS, "暂停所有 Bot").build(app)?;
    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&new_session_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&bot_status_item)
        .item(&toggle_bots_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit_item)
        .build()?;

    // Store menu item references for dynamic updates
    let tray_state = TrayMenuState {
        bot_status_item: bot_status_item.clone(),
        toggle_bots_item: toggle_bots_item.clone(),
    };
    app.manage(Arc::new(RwLock::new(tray_state)));

    // Load the tray icon from the embedded transparent PNG (face-right variant)
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

    // Spawn a background task to periodically update the bot status menu item
    let app_for_update = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            update_bot_status_menu(&app_for_update).await;
        }
    });

    Ok(())
}

/// Handle tray menu item clicks.
fn handle_menu_event(app: &AppHandle, menu_id: &str) {
    match menu_id {
        MENU_SHOW => {
            show_main_window(app);
        }
        MENU_NEW_SESSION => {
            // Show window and emit event to frontend to create a new session
            show_main_window(app);
            use tauri::Emitter;
            app.emit("tray://new-session", ()).ok();
        }
        MENU_TOGGLE_BOTS => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                toggle_all_bots(&app).await;
            });
        }
        MENU_QUIT => {
            // Actually quit the application
            app.exit(0);
        }
        _ => {}
    }
}

/// Show and focus the main window.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.show().ok();
        window.unminimize().ok();
        window.set_focus().ok();
    }
}

/// Toggle main window visibility.
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

/// Toggle all bots between running and stopped.
async fn toggle_all_bots(app: &AppHandle) {
    let state = app.state::<AppState>();
    let manager = &state.bot_manager;
    let is_running = manager.is_running().await;

    if is_running {
        manager.stop().await;
        log::info!("All bots paused via tray menu");
    } else {
        // Re-start the bot manager consumer loop
        let app_handle = app.clone();
        manager
            .start(std::sync::Arc::new(state.clone_shared()), app_handle)
            .await;
        log::info!("All bots resumed via tray menu");
    }

    update_bot_status_menu(app).await;
}

/// Update the bot status and toggle label in the tray menu.
async fn update_bot_status_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    let manager = &state.bot_manager;
    let count = manager.connected_count().await;
    let is_running = manager.is_running().await;

    // Access stored menu item references
    let tray_state = app.state::<Arc<RwLock<TrayMenuState>>>();
    let tray_menu = tray_state.read().await;

    // Update bot status text
    let status_text = if is_running {
        format!("Bot 状态: {} 个已连接", count)
    } else {
        format!("Bot 状态: 已暂停 ({} 个)", count)
    };
    tray_menu.bot_status_item.set_text(status_text).ok();

    // Update toggle label
    let label = if is_running {
        "暂停所有 Bot"
    } else {
        "恢复所有 Bot"
    };
    tray_menu.toggle_bots_item.set_text(label).ok();
}
