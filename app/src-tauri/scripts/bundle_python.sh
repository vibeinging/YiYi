#!/bin/bash
# Bundle Python stdlib + pip for distribution (macOS / Linux).
# Run from src-tauri/ directory.
# Usage: bash scripts/bundle_python.sh [python_path]
#
# For Windows, use: powershell -File scripts/bundle_python.ps1

set -e

PYTHON="${1:-$(python3 -c 'import sys; print(sys.executable)')}"
echo "Using Python: $PYTHON"

# Get Python version and stdlib path
PYVER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
STDLIB=$($PYTHON -c "import sysconfig; print(sysconfig.get_path('stdlib'))")
DYNLOAD=$($PYTHON -c "import sysconfig; print(sysconfig.get_path('platstdlib'))")/lib-dynload
SITE_PACKAGES=$($PYTHON -c "import site; print(site.getsitepackages()[0])")

echo "Python version: $PYVER"
echo "Stdlib: $STDLIB"
echo "Dynload: $DYNLOAD"
echo "Site-packages: $SITE_PACKAGES"

# Unix layout: python-stdlib/lib/python3.X/...
DEST="python-stdlib/lib/python${PYVER}"
rm -rf python-stdlib
mkdir -p "$DEST"

# Copy stdlib (excluding unnecessary parts, resolving symlinks)
echo "Copying stdlib..."
rsync -aL --exclude='__pycache__' \
    --exclude='test/' --exclude='tests/' \
    --exclude='idlelib/' --exclude='tkinter/' \
    --exclude='turtledemo/' --exclude='ensurepip/' \
    --exclude='*.pyc' \
    "$STDLIB/" "$DEST/"

# Copy lib-dynload (compiled .so/.dylib extensions)
if [ -d "$DYNLOAD" ]; then
    echo "Copying lib-dynload..."
    mkdir -p "$DEST/lib-dynload"
    rsync -aL "$DYNLOAD/" "$DEST/lib-dynload/"
fi

# Copy pip from site-packages
if [ -d "$SITE_PACKAGES/pip" ]; then
    echo "Copying pip..."
    rsync -aL --exclude='__pycache__' --exclude='*.pyc' \
        "$SITE_PACKAGES/pip" "$DEST/"
    # Also copy pip's dist-info for proper metadata
    rsync -aL "$SITE_PACKAGES"/pip-*.dist-info "$DEST/" 2>/dev/null || true
fi

# Ensure site-packages is a real directory (not a symlink)
if [ -L "$DEST/site-packages" ]; then
    echo "Fixing site-packages symlink..."
    rm "$DEST/site-packages"
fi
mkdir -p "$DEST/site-packages"

# Remove config directory that references non-existent .a files
rm -rf "$DEST"/config-*

# Remove any remaining symlinks that could cause issues
find "$DEST" -type l -delete 2>/dev/null || true

# Calculate size
SIZE=$(du -sh python-stdlib | cut -f1)
echo ""
echo "Done! Bundled Python stdlib to: python-stdlib/"
echo "Size: $SIZE"
echo "Contents:"
ls "$DEST/" | head -20
echo "..."
