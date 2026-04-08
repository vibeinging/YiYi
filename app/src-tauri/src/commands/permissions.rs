use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    pub microphone: bool,
}

/// Check the status of all three macOS permissions concurrently.
#[tauri::command]
pub async fn check_permissions() -> Result<PermissionStatus, String> {
    let (a, s, m) = tokio::join!(
        tokio::task::spawn_blocking(check_accessibility),
        tokio::task::spawn_blocking(check_screen_recording),
        tokio::task::spawn_blocking(check_microphone),
    );
    Ok(PermissionStatus {
        accessibility: a.unwrap_or(false),
        screen_recording: s.unwrap_or(false),
        microphone: m.unwrap_or(false),
    })
}

/// Request Accessibility permission by prompting the user via System Settings.
#[tauri::command]
pub async fn request_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;

        extern "C" {
            fn CFStringCreateWithCString(
                alloc: *const c_void,
                c_str: *const u8,
                encoding: u32,
            ) -> *const c_void;
            fn CFDictionaryCreate(
                allocator: *const c_void,
                keys: *const *const c_void,
                values: *const *const c_void,
                num_values: isize,
                key_callbacks: *const c_void,
                value_callbacks: *const c_void,
            ) -> *const c_void;
            fn CFRelease(cf: *const c_void);
            fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;

            // CoreFoundation constants
            static kCFBooleanTrue: *const c_void;
            static kCFTypeDictionaryKeyCallBacks: c_void;
            static kCFTypeDictionaryValueCallBacks: c_void;
        }

        const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;

        unsafe {
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                b"AXTrustedCheckOptionPrompt\0".as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            );

            let keys = [key];
            let values = [kCFBooleanTrue];

            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
            );

            let trusted = AXIsProcessTrustedWithOptions(options);

            CFRelease(options);
            CFRelease(key);

            Ok(trusted)
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

/// Open the Screen Recording pane in System Settings.
#[tauri::command]
pub async fn request_screen_recording() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn()
            .map_err(|e| format!("Failed to open Screen Recording settings: {}", e))?;
    }
    Ok(())
}

/// Trigger the microphone permission dialog.
#[tauri::command]
pub async fn request_microphone() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Open the Microphone privacy pane in System Settings
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|e| format!("Failed to open Microphone settings: {}", e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal check helpers
// ---------------------------------------------------------------------------

fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        unsafe { AXIsProcessTrusted() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn check_screen_recording() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Use screencapture to test: it produces a non-empty file only when
        // screen recording permission is granted.
        use std::process::Command;

        let tmp = std::env::temp_dir().join(format!("yiyi_screen_check_{}.png", std::process::id()));
        let tmp_str = tmp.to_string_lossy().to_string();

        let output = Command::new("screencapture")
            .args(["-x", "-T", "0", &tmp_str])
            .output();

        match output {
            Ok(o) => {
                let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(&tmp);
                o.status.success() && size > 0
            }
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn check_microphone() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Check AVFoundation authorization status via osascript.
        // AVAuthorizationStatus: 0=notDetermined, 1=restricted, 2=denied, 3=authorized
        use std::process::Command;
        let output = Command::new("osascript")
            .args([
                "-e",
                r#"use framework "AVFoundation"
set status to current application's AVCaptureDevice's authorizationStatusForMediaType:(current application's AVMediaTypeAudio)
return status as integer"#,
            ])
            .output();

        match output {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                s == "3" // 3 = authorized
            }
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
