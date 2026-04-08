//! Computer control tools for desktop GUI automation.
//!
//! Strategy: CLI-first (osascript + shell), GUI fallback (mouse/keyboard).
//! macOS only — uses CoreGraphics, Accessibility API, and AppleScript.
//!
//! Risk classification:
//!   Safe       — read-only / observation actions, auto-execute
//!   Normal     — mouse/keyboard input, execute with log
//!   Sensitive  — app lifecycle, window mutation, clipboard write, volume — confirm with user
//!   High       — osascript (arbitrary AppleScript) — always confirm

use serde_json::json;
use super::permission_gate::{self, PermissionRequest};

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "computer_control",
            "Control the macOS desktop: mouse, keyboard, windows, apps, and system. \
             Prefer CLI/osascript actions when possible — they are faster and more reliable than coordinate-based mouse clicks. \
             Use screenshot first to see what's on screen, then act.",
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "screenshot",
                            "screenshot_region",
                            "left_click",
                            "right_click",
                            "double_click",
                            "mouse_move",
                            "drag",
                            "type_text",
                            "key_press",
                            "scroll",
                            "cursor_position",
                            "list_windows",
                            "active_window",
                            "focus_window",
                            "move_window",
                            "resize_window",
                            "minimize_window",
                            "close_window",
                            "launch_app",
                            "quit_app",
                            "list_apps",
                            "osascript",
                            "clipboard_read",
                            "clipboard_write",
                            "set_volume",
                            "wait"
                        ],
                        "description": "The action to perform"
                    },
                    "x": { "type": "integer", "description": "X coordinate (logical points, not pixels)" },
                    "y": { "type": "integer", "description": "Y coordinate (logical points, not pixels)" },
                    "end_x": { "type": "integer", "description": "End X for drag" },
                    "end_y": { "type": "integer", "description": "End Y for drag" },
                    "text": { "type": "string", "description": "Text to type, app name, script content, or clipboard text" },
                    "key": { "type": "string", "description": "Key combo, e.g. 'cmd+c', 'return', 'tab', 'escape', 'cmd+shift+s'" },
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction" },
                    "amount": { "type": "integer", "description": "Scroll amount or volume level (0-100)" },
                    "width": { "type": "integer", "description": "Window width for resize" },
                    "height": { "type": "integer", "description": "Window height for resize" },
                    "duration_ms": { "type": "integer", "description": "Wait duration in ms" },
                    "window_title": { "type": "string", "description": "Window title for focus/move/resize/close" },
                    "app_name": { "type": "string", "description": "Application name" }
                },
                "required": ["action"]
            }),
        ),
    ]
}

// ---------------------------------------------------------------------------
//  Risk classification
// ---------------------------------------------------------------------------

/// Risk level for a computer_control action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionRisk {
    /// Read-only / observation — auto-execute, no prompt.
    Safe,
    /// Mouse / keyboard input — execute with a log line.
    Normal,
    /// App lifecycle, window mutation, clipboard write, volume — ask user.
    Sensitive,
    /// Arbitrary AppleScript — always ask user (high risk).
    High,
}

fn classify_action(action: &str, args: &serde_json::Value) -> ActionRisk {
    match action {
        // Safe: observation only
        "screenshot" | "screenshot_region" | "cursor_position"
        | "list_windows" | "active_window" | "list_apps"
        | "wait" => ActionRisk::Safe,

        // Normal: input actions + clipboard read (privacy-sensitive)
        "left_click" | "right_click" | "double_click"
        | "mouse_move" | "scroll" | "type_text"
        | "focus_window" | "drag"
        | "clipboard_read" => ActionRisk::Normal,

        // key_press: normally Normal, but escalate if it looks like a quit shortcut
        "key_press" => {
            let combo = args["key"].as_str().unwrap_or("").to_lowercase();
            if is_dangerous_key_combo(&combo) {
                ActionRisk::Sensitive
            } else {
                ActionRisk::Normal
            }
        }

        // Sensitive: app lifecycle + window mutation + system state
        "launch_app" | "quit_app" | "move_window" | "resize_window"
        | "minimize_window" | "close_window" | "clipboard_write"
        | "set_volume" => ActionRisk::Sensitive,

        // High: arbitrary AppleScript
        "osascript" => ActionRisk::High,

        _ => ActionRisk::Sensitive, // unknown → err on the side of caution
    }
}

/// Detect key combos that could quit apps, log out, shut down, etc.
fn is_dangerous_key_combo(combo: &str) -> bool {
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).collect();
    let has_cmd = parts.iter().any(|p| matches!(*p, "cmd" | "command" | "meta" | "super"));

    if has_cmd {
        // cmd+q → quit, cmd+w → close window/tab, cmd+delete → delete file
        if parts.iter().any(|p| matches!(*p, "q" | "w" | "delete" | "backspace")) {
            return true;
        }
        // cmd+shift+q → log out, cmd+option+escape → force quit
        let has_shift = parts.iter().any(|p| matches!(*p, "shift"));
        let has_option = parts.iter().any(|p| matches!(*p, "alt" | "option" | "opt"));
        if has_shift && parts.iter().any(|p| *p == "q") {
            return true;
        }
        if has_option && parts.iter().any(|p| matches!(*p, "escape" | "esc")) {
            return true;
        }
    }
    // ctrl+option+cmd+power / ctrl+cmd+q (lock screen) — catch-all for ctrl+cmd combos
    let has_ctrl = parts.iter().any(|p| matches!(*p, "ctrl" | "control"));
    if has_cmd && has_ctrl {
        return true;
    }
    false
}

/// Build a human-readable description for the permission dialog.
fn describe_action(action: &str, args: &serde_json::Value) -> String {
    match action {
        "launch_app" => {
            let name = args["app_name"].as_str().or(args["text"].as_str()).unwrap_or("unknown");
            format!("Launch application: {name}")
        }
        "quit_app" => {
            let name = args["app_name"].as_str().or(args["text"].as_str()).unwrap_or("unknown");
            format!("Quit application: {name}")
        }
        "close_window" | "minimize_window" | "move_window" | "resize_window" => {
            let title = args["window_title"].as_str().unwrap_or("unknown");
            format!("{action}: {title}")
        }
        "clipboard_write" => {
            let text = args["text"].as_str().unwrap_or("");
            let preview: String = text.chars().take(60).collect();
            let suffix = if text.chars().count() > 60 { "..." } else { "" };
            format!("Write to clipboard: \"{preview}{suffix}\"")
        }
        "set_volume" => {
            let level = args["amount"].as_i64().unwrap_or(50);
            format!("Set system volume to {level}%")
        }
        "key_press" => {
            let combo = args["key"].as_str().unwrap_or("");
            format!("Press dangerous key combo: {combo}")
        }
        "osascript" => {
            let script = args["text"].as_str().unwrap_or("");
            let preview: String = script.chars().take(120).collect();
            let suffix = if script.chars().count() > 120 { "..." } else { "" };
            format!("Run AppleScript: {preview}{suffix}")
        }
        _ => format!("{action}"),
    }
}

// ---------------------------------------------------------------------------
//  Permission gate
// ---------------------------------------------------------------------------

/// Check permission for sensitive / high-risk actions.
/// Returns Ok(()) if allowed, Err(message) if denied.
async fn gate_action(action: &str, risk: ActionRisk, args: &serde_json::Value) -> Result<(), String> {
    match risk {
        ActionRisk::Safe => { /* auto-execute */ }
        ActionRisk::Normal => {
            log::info!("[computer_control] executing normal action: {action}");
        }
        ActionRisk::Sensitive | ActionRisk::High => {
            let description = describe_action(action, args);
            let risk_level = if risk == ActionRisk::High { "high" } else { "medium" };

            let req = PermissionRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                permission_type: "computer_control".to_string(),
                path: format!("{action}: {}", description),
                parent_folder: String::new(),
                reason: format!(
                    "The AI agent wants to {description}. This is a {risk_level}-risk computer control action.",
                ),
                risk_level: risk_level.to_string(),
            };

            if !permission_gate::request_permission(req).await {
                return Err(format!(
                    "Action '{action}' was denied by the user. The user did not grant permission to {description}."
                ));
            }
        }
    }
    Ok(())
}

pub(super) async fn computer_control_tool(
    args: &serde_json::Value,
) -> (String, Vec<String>) {
    let action = args["action"].as_str().unwrap_or("");

    // --- Permission gating ---
    let risk = classify_action(action, args);
    if let Err(denied_msg) = gate_action(action, risk, args).await {
        return (denied_msg, vec![]);
    }

    match action {
        "screenshot" => super::system_tools::desktop_screenshot_tool().await,
        "screenshot_region" => {
            let x = args["x"].as_i64().unwrap_or(0) as i32;
            let y = args["y"].as_i64().unwrap_or(0) as i32;
            let w = args["width"].as_i64().unwrap_or(400) as i32;
            let h = args["height"].as_i64().unwrap_or(300) as i32;
            screenshot_region(x, y, w, h).await
        }
        "cursor_position" => (get_cursor_position(), vec![]),

        // Mouse actions run via spawn_blocking to avoid blocking Tokio
        "left_click" | "right_click" | "double_click" | "mouse_move" | "drag" => {
            let args = args.clone();
            let act = action.to_string();
            let result = tokio::task::spawn_blocking(move || {
                let x = args["x"].as_i64().unwrap_or(0) as i32;
                let y = args["y"].as_i64().unwrap_or(0) as i32;
                match act.as_str() {
                    "left_click" => mouse_click(x, y, false, 1),
                    "right_click" => mouse_click(x, y, true, 1),
                    "double_click" => mouse_click(x, y, false, 2),
                    "mouse_move" => mouse_move(x, y),
                    "drag" => {
                        let ex = args["end_x"].as_i64().unwrap_or(0) as i32;
                        let ey = args["end_y"].as_i64().unwrap_or(0) as i32;
                        mouse_drag(x, y, ex, ey)
                    }
                    _ => unreachable!(),
                }
            }).await.unwrap_or_else(|e| format!("Error: {e}"));
            (result, vec![])
        }
        "scroll" => {
            let dir = args["direction"].as_str().unwrap_or("down").to_string();
            let amount = args["amount"].as_i64().unwrap_or(3) as i32;
            (mouse_scroll(&dir, amount).await, vec![])
        }

        // Keyboard actions also via spawn_blocking
        "type_text" => {
            let text = args["text"].as_str().unwrap_or("").to_string();
            let result = tokio::task::spawn_blocking(move || type_text(&text))
                .await.unwrap_or_else(|e| format!("Error: {e}"));
            (result, vec![])
        }
        "key_press" => {
            let key = args["key"].as_str().unwrap_or("").to_string();
            let result = tokio::task::spawn_blocking(move || key_press(&key))
                .await.unwrap_or_else(|e| format!("Error: {e}"));
            (result, vec![])
        }

        "list_windows" => (list_windows().await, vec![]),
        "active_window" => (active_window().await, vec![]),
        "focus_window" => {
            let name = args["window_title"].as_str().or(args["app_name"].as_str()).unwrap_or("");
            (focus_window(name).await, vec![])
        }
        "move_window" => {
            let title = args["window_title"].as_str().unwrap_or("");
            let x = args["x"].as_i64().unwrap_or(0) as i32;
            let y = args["y"].as_i64().unwrap_or(0) as i32;
            let action_line = format!("set position of w to {{{x}, {y}}}\nreturn \"Moved to ({x}, {y})\"");
            (with_window_by_title(title, &action_line).await, vec![])
        }
        "resize_window" => {
            let title = args["window_title"].as_str().unwrap_or("");
            let w = args["width"].as_i64().unwrap_or(800) as i32;
            let h = args["height"].as_i64().unwrap_or(600) as i32;
            let action_line = format!("set size of w to {{{w}, {h}}}\nreturn \"Resized to {w}x{h}\"");
            (with_window_by_title(title, &action_line).await, vec![])
        }
        "minimize_window" => {
            let title = args["window_title"].as_str().unwrap_or("");
            let action_line = "click (first button of w whose subrole is \"AXMinimizeButton\")\nreturn \"Minimized\"";
            (with_window_by_title(title, action_line).await, vec![])
        }
        "close_window" => {
            let title = args["window_title"].as_str().unwrap_or("");
            let action_line = "click (first button of w whose subrole is \"AXCloseButton\")\nreturn \"Closed\"";
            (with_window_by_title(title, action_line).await, vec![])
        }

        "launch_app" => {
            let name = args["app_name"].as_str().or(args["text"].as_str()).unwrap_or("");
            (launch_app(name).await, vec![])
        }
        "quit_app" => {
            let name = args["app_name"].as_str().or(args["text"].as_str()).unwrap_or("");
            let escaped = sanitize_applescript(name);
            (run_osascript(&format!(r#"tell application "{escaped}" to quit"#)).await, vec![])
        }
        "list_apps" => (list_running_apps().await, vec![]),

        "osascript" => {
            let script = args["text"].as_str().unwrap_or("");
            (run_osascript(script).await, vec![])
        }

        "clipboard_read" => (clipboard_read(), vec![]),
        "clipboard_write" => {
            let text = args["text"].as_str().unwrap_or("");
            (clipboard_write(text), vec![])
        }

        "set_volume" => {
            let level = args["amount"].as_i64().unwrap_or(50).clamp(0, 100);
            run_osascript(&format!("set volume output volume {level}")).await;
            (format!("Volume set to {level}%"), vec![])
        }
        "wait" => {
            let ms = (args["duration_ms"].as_i64().unwrap_or(1000) as u64).min(30_000);
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            (format!("Waited {ms}ms"), vec![])
        }

        _ => (format!("Unknown action: {action}"), vec![]),
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  AppleScript helpers
// ═══════════════════════════════════════════════════════════════════════

/// Sanitize a string for safe embedding in AppleScript double-quoted strings.
fn sanitize_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

async fn run_osascript(script: &str) -> String {
    if script.is_empty() {
        return "Error: script is empty".into();
    }
    match tokio::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if output.status.success() {
                if stdout.is_empty() { "OK".into() } else { stdout }
            } else {
                format!("Error: {}", if stderr.is_empty() { &stdout } else { &stderr })
            }
        }
        Err(e) => format!("Failed to run osascript: {e}"),
    }
}

/// Find a window by title substring and execute an AppleScript action on it.
async fn with_window_by_title(title: &str, action: &str) -> String {
    let escaped = sanitize_applescript(title);
    let script = format!(
        r#"tell application "System Events"
    repeat with proc in (every process whose visible is true)
        try
            repeat with w in (every window of proc)
                if name of w contains "{escaped}" then
                    {action}
                end if
            end repeat
        end try
    end repeat
    return "Window not found: {escaped}"
end tell"#
    );
    run_osascript(&script).await
}

// ═══════════════════════════════════════════════════════════════════════
//  Screenshot
// ═══════════════════════════════════════════════════════════════════════

async fn screenshot_region(x: i32, y: i32, w: i32, h: i32) -> (String, Vec<String>) {
    let tmp = format!("/tmp/yiyi_screenshot_{}.png", uuid::Uuid::new_v4());
    let region = format!("{},{},{},{}", x, y, w, h);

    let output = tokio::process::Command::new("screencapture")
        .args(["-x", "-R", &region, &tmp])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => match tokio::fs::read(&tmp).await {
            Ok(data) => {
                tokio::fs::remove_file(&tmp).await.ok();
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let uri = format!("data:image/png;base64,{b64}");
                (
                    format!("[Region screenshot: {w}x{h} at ({x},{y}), {} bytes]", data.len()),
                    vec![uri],
                )
            }
            Err(e) => (format!("Failed to read screenshot: {e}"), vec![]),
        },
        Ok(_) => ("Screenshot region capture failed".into(), vec![]),
        Err(e) => (format!("Failed to capture region: {e}"), vec![]),
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Mouse (via CoreGraphics CGEvent)
// ═══════════════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
#[cfg(target_os = "macos")]
use core_graphics::geometry::CGPoint;

#[cfg(target_os = "macos")]
fn cg_source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "Failed to create CGEvent source".to_string())
}

#[cfg(target_os = "macos")]
fn mouse_click(x: i32, y: i32, right: bool, click_count: i32) -> String {
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let point = CGPoint::new(x as f64, y as f64);

    let (down_type, up_type, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };

    let down = match CGEvent::new_mouse_event(source.clone(), down_type, point, button) {
        Ok(e) => e, Err(_) => return "Error: Failed to create mouse event".into(),
    };
    let up = match CGEvent::new_mouse_event(source, up_type, point, button) {
        Ok(e) => e, Err(_) => return "Error: Failed to create mouse event".into(),
    };

    down.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_count as i64);
    up.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_count as i64);

    down.post(core_graphics::event::CGEventTapLocation::HID);
    up.post(core_graphics::event::CGEventTapLocation::HID);

    let label = if click_count > 1 { "Double-clicked" } else if right { "Right-clicked" } else { "Clicked" };
    format!("{label} at ({x}, {y})")
}

#[cfg(target_os = "macos")]
fn mouse_move(x: i32, y: i32) -> String {
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let point = CGPoint::new(x as f64, y as f64);
    if let Ok(event) = CGEvent::new_mouse_event(source, CGEventType::MouseMoved, point, CGMouseButton::Left) {
        event.post(core_graphics::event::CGEventTapLocation::HID);
    }
    format!("Moved cursor to ({x}, {y})")
}

#[cfg(target_os = "macos")]
fn mouse_drag(x: i32, y: i32, end_x: i32, end_y: i32) -> String {
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let start = CGPoint::new(x as f64, y as f64);
    let end = CGPoint::new(end_x as f64, end_y as f64);

    if let Ok(e) = CGEvent::new_mouse_event(source.clone(), CGEventType::LeftMouseDown, start, CGMouseButton::Left) {
        e.post(core_graphics::event::CGEventTapLocation::HID);
    }
    std::thread::sleep(std::time::Duration::from_millis(50));
    if let Ok(e) = CGEvent::new_mouse_event(source.clone(), CGEventType::LeftMouseDragged, end, CGMouseButton::Left) {
        e.post(core_graphics::event::CGEventTapLocation::HID);
    }
    std::thread::sleep(std::time::Duration::from_millis(50));
    if let Ok(e) = CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, end, CGMouseButton::Left) {
        e.post(core_graphics::event::CGEventTapLocation::HID);
    }

    format!("Dragged from ({x}, {y}) to ({end_x}, {end_y})")
}

#[cfg(target_os = "macos")]
async fn mouse_scroll(direction: &str, amount: i32) -> String {
    let key_code = match direction {
        "up" => 126,
        "down" => 125,
        "left" => 123,
        "right" => 124,
        _ => 125,
    };
    let script = format!(
        r#"tell application "System Events" to repeat {amount} times
key code {key_code}
end repeat"#
    );
    run_osascript(&script).await
}

#[cfg(target_os = "macos")]
fn get_cursor_position() -> String {
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let event = match CGEvent::new(source) {
        Ok(e) => e, Err(_) => return "Error: Cannot create event".into(),
    };
    let pos = event.location();
    format!("Cursor at ({}, {})", pos.x as i32, pos.y as i32)
}

#[cfg(not(target_os = "macos"))]
fn mouse_click(_x: i32, _y: i32, _right: bool, _count: i32) -> String { "Not supported on this platform".into() }
#[cfg(not(target_os = "macos"))]
fn mouse_move(_x: i32, _y: i32) -> String { "Not supported on this platform".into() }
#[cfg(not(target_os = "macos"))]
fn mouse_drag(_x: i32, _y: i32, _ex: i32, _ey: i32) -> String { "Not supported on this platform".into() }
#[cfg(not(target_os = "macos"))]
async fn mouse_scroll(_dir: &str, _amount: i32) -> String { "Not supported on this platform".into() }
#[cfg(not(target_os = "macos"))]
fn get_cursor_position() -> String { "Not supported on this platform".into() }

// ═══════════════════════════════════════════════════════════════════════
//  Keyboard (via CGEvent)
// ═══════════════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
fn type_text(text: &str) -> String {
    if text.is_empty() {
        return "Error: text is empty".into();
    }
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let chars: Vec<u16> = text.encode_utf16().collect();

    for chunk in chars.chunks(20) {
        if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), 0, true) {
            event.set_string_from_utf16_unchecked(chunk);
            event.post(core_graphics::event::CGEventTapLocation::HID);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let preview: String = text.chars().take(50).collect();
    let suffix = if text.chars().count() > 50 { "..." } else { "" };
    format!("Typed: \"{preview}{suffix}\"")
}

#[cfg(target_os = "macos")]
fn key_press(combo: &str) -> String {
    let source = match cg_source() { Ok(s) => s, Err(e) => return e };
    let parts: Vec<String> = combo.split('+').map(|s| s.trim().to_lowercase()).collect();

    let mut flags = CGEventFlags::empty();
    let mut key_code: Option<u16> = None;

    for part in &parts {
        match part.as_str() {
            "cmd" | "command" | "meta" | "super" => flags |= CGEventFlags::CGEventFlagCommand,
            "shift" => flags |= CGEventFlags::CGEventFlagShift,
            "alt" | "option" | "opt" => flags |= CGEventFlags::CGEventFlagAlternate,
            "ctrl" | "control" => flags |= CGEventFlags::CGEventFlagControl,
            k => match key_name_to_code(k) {
                Some(code) => key_code = Some(code),
                None => return format!("Error: Unknown key '{k}'"),
            },
        }
    }

    let code = match key_code {
        Some(c) => c,
        None => return "Error: No key specified in combo".into(),
    };

    let down = match CGEvent::new_keyboard_event(source.clone(), code, true) {
        Ok(e) => e, Err(_) => return "Error: Failed to create key event".into(),
    };
    down.set_flags(flags);
    down.post(core_graphics::event::CGEventTapLocation::HID);

    let up = match CGEvent::new_keyboard_event(source, code, false) {
        Ok(e) => e, Err(_) => return "Error: Failed to create key event".into(),
    };
    up.set_flags(flags);
    up.post(core_graphics::event::CGEventTapLocation::HID);

    format!("Pressed: {combo}")
}

#[cfg(target_os = "macos")]
fn key_name_to_code(name: &str) -> Option<u16> {
    Some(match name {
        "return" | "enter" => 0x24,
        "tab" => 0x30,
        "space" => 0x31,
        "delete" | "backspace" => 0x33,
        "escape" | "esc" => 0x35,
        "up" => 0x7E, "down" => 0x7D, "left" => 0x7B, "right" => 0x7C,
        "home" => 0x73, "end" => 0x77, "pageup" => 0x74, "pagedown" => 0x79,
        "f1" => 0x7A, "f2" => 0x78, "f3" => 0x63, "f4" => 0x76,
        "f5" => 0x60, "f6" => 0x61, "f7" => 0x62, "f8" => 0x64,
        "f9" => 0x65, "f10" => 0x6D, "f11" => 0x67, "f12" => 0x6F,
        "a" => 0x00, "b" => 0x0B, "c" => 0x08, "d" => 0x02,
        "e" => 0x0E, "f" => 0x03, "g" => 0x05, "h" => 0x04,
        "i" => 0x22, "j" => 0x26, "k" => 0x28, "l" => 0x25,
        "m" => 0x2E, "n" => 0x2D, "o" => 0x1F, "p" => 0x23,
        "q" => 0x0C, "r" => 0x0F, "s" => 0x01, "t" => 0x11,
        "u" => 0x20, "v" => 0x09, "w" => 0x0D, "x" => 0x07,
        "y" => 0x10, "z" => 0x06,
        "0" => 0x1D, "1" => 0x12, "2" => 0x13, "3" => 0x14,
        "4" => 0x15, "5" => 0x17, "6" => 0x16, "7" => 0x1A,
        "8" => 0x1C, "9" => 0x19,
        "-" | "minus" => 0x1B, "=" | "equal" => 0x18,
        "[" => 0x21, "]" => 0x1E, "\\" => 0x2A,
        ";" => 0x29, "'" => 0x27, "," => 0x2B, "." => 0x2F,
        "/" => 0x2C, "`" => 0x32,
        _ => return None,
    })
}

#[cfg(not(target_os = "macos"))]
fn type_text(_text: &str) -> String { "Not supported on this platform".into() }
#[cfg(not(target_os = "macos"))]
fn key_press(_combo: &str) -> String { "Not supported on this platform".into() }

// ═══════════════════════════════════════════════════════════════════════
//  Window & App management (via osascript)
// ═══════════════════════════════════════════════════════════════════════

async fn list_windows() -> String {
    run_osascript(r#"tell application "System Events"
    set windowList to ""
    repeat with proc in (every process whose visible is true)
        try
            set appName to name of proc
            repeat with w in (every window of proc)
                set winName to name of w
                set winPos to position of w
                set winSize to size of w
                set windowList to windowList & appName & " | " & winName & " | pos:(" & (item 1 of winPos) & "," & (item 2 of winPos) & ") size:(" & (item 1 of winSize) & "x" & (item 2 of winSize) & ")" & linefeed
            end repeat
        end try
    end repeat
    return windowList
end tell"#).await
}

async fn active_window() -> String {
    run_osascript(r#"tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    try
        set win to front window of frontApp
        set winName to name of win
        set winPos to position of win
        set winSize to size of win
        return appName & " | " & winName & " | pos:(" & (item 1 of winPos) & "," & (item 2 of winPos) & ") size:(" & (item 1 of winSize) & "x" & (item 2 of winSize) & ")"
    on error
        return appName & " (no window)"
    end try
end tell"#).await
}

async fn focus_window(name: &str) -> String {
    let escaped = sanitize_applescript(name);
    run_osascript(&format!(r#"tell application "{escaped}" to activate"#)).await
}

async fn launch_app(name: &str) -> String {
    match tokio::process::Command::new("open")
        .args(["-a", name])
        .output()
        .await
    {
        Ok(output) if output.status.success() => format!("Launched {name}"),
        Ok(output) => format!("Failed: {}", String::from_utf8_lossy(&output.stderr).trim()),
        Err(e) => format!("Error: {e}"),
    }
}

async fn list_running_apps() -> String {
    run_osascript(r#"tell application "System Events"
    set appList to ""
    repeat with proc in (every process whose background only is false)
        set appList to appList & name of proc & linefeed
    end repeat
    return appList
end tell"#).await
}

// ═══════════════════════════════════════════════════════════════════════
//  Clipboard
// ═══════════════════════════════════════════════════════════════════════

fn clipboard_read() -> String {
    match arboard::Clipboard::new() {
        Ok(mut cb) => match cb.get_text() {
            Ok(text) => {
                let preview: String = text.chars().take(500).collect();
                let suffix = if text.chars().count() > 500 { "..." } else { "" };
                format!("Clipboard: \"{preview}{suffix}\"")
            }
            Err(_) => "Clipboard is empty or not text".into(),
        },
        Err(e) => format!("Clipboard error: {e}"),
    }
}

fn clipboard_write(text: &str) -> String {
    match arboard::Clipboard::new() {
        Ok(mut cb) => match cb.set_text(text) {
            Ok(_) => format!("Copied {} chars to clipboard", text.len()),
            Err(e) => format!("Clipboard write error: {e}"),
        },
        Err(e) => format!("Clipboard error: {e}"),
    }
}
