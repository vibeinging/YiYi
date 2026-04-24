#!/bin/bash
# YiYi Build Script
# Usage: ./build.sh [arm|intel|both]
# Handles Python dylib bundling for each architecture

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"
TAURI_DIR="$APP_DIR/src-tauri"
LIBS_DIR="$TAURI_DIR/libs"

# Python paths per architecture
PYTHON_ARM="/opt/anaconda3/envs/py313/bin/python3.13"
PYTHON_INTEL="/usr/local/Cellar/python@3.13/3.13.7/bin/python3.13"

DYLIB_ARM="/opt/anaconda3/envs/py313/lib/libpython3.13.dylib"
DYLIB_INTEL="/usr/local/opt/python@3.13/Frameworks/Python.framework/Versions/3.13/lib/libpython3.13.dylib"

# Cleanup Python stdlib to reduce bundle size
cleanup_stdlib() {
    echo "Cleaning Python stdlib..."
    "$SCRIPT_DIR/app/src-tauri/cleanup-stdlib.sh"
}

cleanup_stdlib

build_target() {
    local arch="$1"
    local target=""
    local python=""
    local dylib=""

    if [ "$arch" = "arm" ]; then
        target="aarch64-apple-darwin"
        python="$PYTHON_ARM"
        dylib="$DYLIB_ARM"
        echo "🔨 Building for ARM (Apple Silicon)..."
    elif [ "$arch" = "intel" ]; then
        target="x86_64-apple-darwin"
        python="$PYTHON_INTEL"
        dylib="$DYLIB_INTEL"
        echo "🔨 Building for Intel (x86_64)..."
    else
        echo "Unknown arch: $arch"
        exit 1
    fi

    # Verify Python exists
    if [ ! -f "$python" ]; then
        echo "Python not found at: $python"
        exit 1
    fi

    # Copy the correct dylib to staging dir
    echo "  Copying libpython3.13.dylib ($arch)..."
    mkdir -p "$LIBS_DIR"
    cp "$dylib" "$LIBS_DIR/libpython3.13.dylib"

    # Disable updater signing if no private key
    local conf="$TAURI_DIR/tauri.conf.json"
    local updater_disabled=false
    if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
        echo "  ⚠️ No TAURI_SIGNING_PRIVATE_KEY, disabling updater artifacts"
        sed -i.bak 's/"createUpdaterArtifacts": true/"createUpdaterArtifacts": false/' "$conf"
        updater_disabled=true
    fi

    # Build with correct PYO3_PYTHON
    echo "  Running tauri build --target $target..."
    cd "$APP_DIR"
    PYO3_PYTHON="$python" npm run tauri build -- --target "$target"

    # Restore updater config if modified
    if [ "$updater_disabled" = true ] && [ -f "$conf.bak" ]; then
        mv "$conf.bak" "$conf"
    fi

    # Post-process: fix rpath in the built binary
    local binary="$TAURI_DIR/target/$target/release/yiyi"
    local app_binary="$TAURI_DIR/target/$target/release/bundle/macos/YiYi.app/Contents/MacOS/yiyi"

    local app_dir="$TAURI_DIR/target/$target/release/bundle/macos/YiYi.app"
    if [ -f "$app_binary" ]; then
        echo "  Fixing dylib references in app bundle..."
        local fw_dir="$app_dir/Contents/Frameworks"

        # Fix the dylib's install name to use @rpath
        if [ -f "$fw_dir/libpython3.13.dylib" ]; then
            install_name_tool -id "@rpath/libpython3.13.dylib" \
                "$fw_dir/libpython3.13.dylib" 2>/dev/null || true
        fi

        # Fix binary: rewrite any Python reference to @rpath/libpython3.13.dylib
        # ARM uses @rpath/libpython3.13.dylib (already correct)
        # Intel uses absolute path that needs fixing
        install_name_tool -change "/usr/local/opt/python@3.13/Frameworks/Python.framework/Versions/3.13/Python" \
            "@rpath/libpython3.13.dylib" \
            "$app_binary" 2>/dev/null || true

        # Verify
        echo "  Verifying linkage:"
        otool -L "$app_binary" | grep python || echo "  (no dynamic python linkage — static build)"
    fi

    # Sign all binaries inside wheels (.so files in .whl zips)
    echo "  Signing binaries inside wheels..."
    local wheels_dir="$app_dir/Contents/Resources/wheels"
    if [ -d "$wheels_dir" ]; then
        local tmp_whl="/tmp/yiyi_whl_resign"
        for whl in "$wheels_dir"/*.whl; do
            [ -f "$whl" ] || continue
            # Check if whl contains .so files
            if unzip -l "$whl" 2>/dev/null | grep -qE '\.(so|dylib)$'; then
                echo "    Signing binaries in $(basename "$whl")..."
                rm -rf "$tmp_whl"
                mkdir -p "$tmp_whl"
                unzip -q "$whl" -d "$tmp_whl"
                find "$tmp_whl" \( -name "*.so" -o -name "*.dylib" \) -exec \
                    codesign --force --options runtime --timestamp \
                    --sign "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY env var}" {} \;
                # Repack the whl
                (cd "$tmp_whl" && zip -q -r "$whl" .)
                rm -rf "$tmp_whl"
            fi
        done
    fi

    # Sign .so and .dylib files inside python-stdlib
    echo "  Signing python stdlib binaries..."
    find "$app_dir/Contents/Resources/python-stdlib" \( -name "*.so" -o -name "*.dylib" \) -exec \
        codesign --force --options runtime --timestamp \
        --sign "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY env var}" {} \; 2>/dev/null || true

    # Re-sign the app after all fixes
    echo "  Re-signing app bundle..."
    codesign --deep --force --options runtime --timestamp \
        --sign "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY env var}" \
        "$app_dir" || echo "  ⚠️ Signing failed"

    # Re-create DMG with fixed binary
    local dmg_dir="$TAURI_DIR/target/$target/release/bundle/dmg"
    local dmg_name
    if [ "$arch" = "arm" ]; then
        dmg_name="YiYi_0.0.5-beta.1_aarch64.dmg"
    else
        dmg_name="YiYi_0.0.5-beta.1_x64.dmg"
    fi
    echo "  Re-creating DMG..."
    rm -f "$dmg_dir/$dmg_name"
    hdiutil create -volname "YiYi" -srcfolder "$app_dir" -ov -format UDZO "$dmg_dir/$dmg_name" 2>/dev/null

    # Notarize if credentials are available
    if [ -n "$APPLE_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
        echo "  Submitting for notarization..."
        xcrun notarytool submit "$dmg_dir/$dmg_name" \
            --apple-id "$APPLE_ID" \
            --password "$APPLE_APP_PASSWORD" \
            --team-id "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID env var}" \
            --wait
        echo "  Stapling notarization ticket..."
        xcrun stapler staple "$dmg_dir/$dmg_name" 2>/dev/null || true
    else
        echo "  ⚠️ Skipping notarization (set APPLE_ID and APPLE_APP_PASSWORD env vars)"
    fi

    echo "  Done! Output:"
    ls -lh "$dmg_dir/$dmg_name"
    echo ""
}

# Parse argument
case "${1:-both}" in
    arm)
        build_target arm
        ;;
    intel)
        build_target intel
        ;;
    both)
        build_target arm
        build_target intel
        ;;
    *)
        echo "Usage: $0 [arm|intel|both]"
        exit 1
        ;;
esac

echo "Build complete!"
