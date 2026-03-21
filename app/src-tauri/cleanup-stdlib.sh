#!/bin/bash
# Cleanup Python stdlib to reduce bundle size
# Removes modules not needed in embedded YiYi runtime
# Expected savings: ~14MB → ~8MB

set -e

STDLIB_DIR="${1:-$(dirname "$0")/python-stdlib/lib/python3.13}"

if [ ! -d "$STDLIB_DIR" ]; then
    echo "Python stdlib not found at: $STDLIB_DIR"
    exit 1
fi

echo "Cleaning Python stdlib at: $STDLIB_DIR"

# Directories safe to remove (not needed in embedded runtime)
REMOVE_DIRS=(
    "pip"
    "ensurepip"
    "unittest"
    "pydoc_data"
    "_pyrepl"
    "idlelib"
    "lib2to3"
    "tkinter"
    "turtledemo"
    "test"
    "distutils"
    "venv"
    "curses"
    "dbm"
    "sqlite3"
    "tomllib"
    "zipapp"
)

for dir in "${REMOVE_DIRS[@]}"; do
    if [ -d "$STDLIB_DIR/$dir" ]; then
        echo "  Removing $dir/ ($(du -sh "$STDLIB_DIR/$dir" | cut -f1))"
        rm -rf "$STDLIB_DIR/$dir"
    fi
done

# Individual files safe to remove
REMOVE_FILES=(
    "_osx_support.py"
    "antigravity.py"
    "__hello__.py"
    "_aix_support.py"
    "_android_support.py"
    "_ios_support.py"
)

for file in "${REMOVE_FILES[@]}"; do
    if [ -f "$STDLIB_DIR/$file" ]; then
        echo "  Removing $file"
        rm -f "$STDLIB_DIR/$file"
    fi
done

# Remove __pycache__ directories recursively
CACHE_SIZE=$(find "$STDLIB_DIR" -type d -name "__pycache__" -exec du -sc {} + 2>/dev/null | tail -1 | cut -f1 || echo "0")
echo "  Removing __pycache__ dirs (~${CACHE_SIZE}K)"
find "$STDLIB_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Remove .pyc files recursively
find "$STDLIB_DIR" -name "*.pyc" -delete 2>/dev/null || true

# Remove config-* directories in lib-dynload (build artifacts)
find "$STDLIB_DIR" -type d -name "config-*" -exec rm -rf {} + 2>/dev/null || true

# Remove __phello__ (test package)
rm -rf "$STDLIB_DIR/__phello__" 2>/dev/null || true

echo "Done! Stdlib size: $(du -sh "$STDLIB_DIR" | cut -f1)"
