#!/bin/bash
# YiYiClaw Dev - 一键重启开发服务器

echo "Stopping existing processes..."

# 用 pkill 直接按进程名/参数匹配杀，避免 lsof 卡死
pkill -9 -f "target/debug/app" 2>/dev/null
pkill -9 -f "cargo-tauri" 2>/dev/null
pkill -9 -f "npm run tauri" 2>/dev/null

# 杀掉 YiYiClaw 目录下的 vite/esbuild 进程
pkill -9 -f "YiClaw/app/node_modules/.bin/vite" 2>/dev/null
pkill -9 -f "YiClaw/app/node_modules/@esbuild" 2>/dev/null

# 清理可能卡死的 lsof 进程
pkill -9 -f "lsof.*1420" 2>/dev/null

sleep 1

# 二次确认：用 netstat 检查端口（不用 lsof，避免卡死）
if netstat -an 2>/dev/null | grep -q '\.1420 .*LISTEN'; then
  echo "Port 1420 still in use, trying fuser..."
  fuser -k 1420/tcp 2>/dev/null
  sleep 1
fi

echo "Starting Tauri dev server..."
npm run tauri dev
