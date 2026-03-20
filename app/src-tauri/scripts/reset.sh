#!/usr/bin/env bash
#
# YiYi 重置脚本
# 清除所有数据，让应用回到初始设置状态
#
# 用法:
#   ./reset.sh          # 交互式选择
#   ./reset.sh --soft   # 软重置（仅清数据库）
#   ./reset.sh --hard   # 硬重置（清除全部）
#   ./reset.sh -h       # 帮助
#
set -euo pipefail

DATA_DIR="${YIYI_WORKING_DIR:-${YIYICLAW_WORKING_DIR:-$HOME/.yiyi}}"
SECRET_DIR="$(dirname "$DATA_DIR")/.yiyi.secret"
WORKSPACE_DIR="${YIYI_WORKSPACE:-${YIYICLAW_WORKSPACE:-$HOME/Documents/YiYi}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

usage() {
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --soft       软重置 — 仅清除数据库（重新走引导流程，保留配置和技能）"
    echo "  --hard       硬重置 — 清除全部数据（回到全新安装状态）"
    echo "  -y, --yes    跳过确认提示"
    echo "  -h, --help   显示帮助"
    echo ""
    echo "不带参数时进入交互式选择。"
    exit 0
}

# ── 解析参数 ──
MODE=""
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --soft)  MODE="soft";  shift ;;
        --hard)  MODE="hard";  shift ;;
        -y|--yes) SKIP_CONFIRM=true; shift ;;
        -h|--help) usage ;;
        *) echo -e "${RED}未知参数: $1${NC}"; usage ;;
    esac
done

# ── 打印信息 ──
echo ""
echo -e "${BOLD}YiYi 重置工具${NC}"
echo -e "─────────────────────────────"
echo ""
echo -e "数据目录:   ${CYAN}${DATA_DIR}${NC}"
echo -e "密钥目录:   ${CYAN}${SECRET_DIR}${NC}"
echo -e "工作空间:   ${CYAN}${WORKSPACE_DIR}${NC}"
echo ""

# 检查数据目录是否存在
if [ ! -d "$DATA_DIR" ]; then
    echo -e "${YELLOW}数据目录不存在，无需重置。${NC}"
    exit 0
fi

# 显示将要清除的内容
echo -e "${BOLD}当前数据:${NC}"
echo ""

if ls "$DATA_DIR"/yiyi.db* &>/dev/null || ls "$DATA_DIR"/yiclaw.db* &>/dev/null; then
    echo -e "  ${RED}[数据库]${NC}  会话、消息、定时任务、Bot 配置、Provider 设置"
fi

if [ -f "$DATA_DIR/config.json" ]; then
    echo -e "  ${RED}[配置]${NC}    config.json (心跳、MCP、Agent 设置)"
fi

if [ -f "$DATA_DIR/SOUL.md" ]; then
    echo -e "  ${RED}[人格]${NC}    SOUL.md (AI 人格设定)"
fi

if [ -f "$DATA_DIR/AGENTS.md" ]; then
    echo -e "  ${RED}[Agent]${NC}   AGENTS.md"
fi

if [ -f "$DATA_DIR/BOOTSTRAP.md" ]; then
    echo -e "  ${RED}[引导]${NC}    BOOTSTRAP.md"
fi

if [ -d "$DATA_DIR/memory" ]; then
    echo -e "  ${RED}[记忆]${NC}    memory/ (AI 记忆文件)"
fi

if [ -d "$DATA_DIR/active_skills" ]; then
    echo -e "  ${RED}[技能]${NC}    active_skills/ (已激活的自定义技能)"
fi

if [ -d "$DATA_DIR/plugins" ]; then
    echo -e "  ${RED}[插件]${NC}    plugins/ (Provider 插件)"
fi

if [ -d "$DATA_DIR/python_packages" ]; then
    echo -e "  ${RED}[Python]${NC}  python_packages/"
fi

echo ""

# ── 交互式选择（无参数时）──
if [ -z "$MODE" ]; then
    echo -e "${BOLD}请选择重置模式:${NC}"
    echo ""
    echo "  1) 软重置 — 仅清除数据库 + setup 标记（重新走引导流程，保留配置和技能）"
    echo "  2) 硬重置 — 清除全部数据（回到全新安装状态）"
    echo "  3) 取消"
    echo ""
    read -rp "输入选项 [1/2/3]: " choice

    case "$choice" in
        1) MODE="soft" ;;
        2) MODE="hard" ;;
        *) echo "已取消。"; exit 0 ;;
    esac
fi

# ── 执行软重置 ──
do_soft_reset() {
    echo ""
    echo -e "${YELLOW}执行软重置...${NC}"

    rm -f "$DATA_DIR"/yiyi.db*
    rm -f "$DATA_DIR"/yiclaw.db*
    echo -e "  ${GREEN}✓${NC} 已清除数据库"

    echo ""
    echo -e "${GREEN}${BOLD}软重置完成。${NC}重新启动 YiYi 将进入初始设置向导。"
    echo -e "配置文件、技能和插件已保留。"
}

# ── 执行硬重置 ──
do_hard_reset() {
    if [ "$SKIP_CONFIRM" = false ]; then
        echo ""
        read -rp "$(echo -e "${RED}确认删除全部数据？此操作不可逆。${NC} [y/N]: ")" confirm
        if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
            echo "已取消。"
            exit 0
        fi
    fi

    echo ""
    echo -e "${YELLOW}执行硬重置...${NC}"

    # 数据库
    rm -f "$DATA_DIR"/yiyi.db*
    rm -f "$DATA_DIR"/yiclaw.db*
    echo -e "  ${GREEN}✓${NC} 已清除数据库"

    # 配置文件
    rm -f "$DATA_DIR/config.json"
    echo -e "  ${GREEN}✓${NC} 已清除 config.json"

    # Markdown 文件
    rm -f "$DATA_DIR/SOUL.md"
    rm -f "$DATA_DIR/AGENTS.md"
    rm -f "$DATA_DIR/BOOTSTRAP.md"
    echo -e "  ${GREEN}✓${NC} 已清除 SOUL.md / AGENTS.md / BOOTSTRAP.md"

    # 记忆
    if [ -d "$DATA_DIR/memory" ]; then
        rm -rf "$DATA_DIR/memory"
        echo -e "  ${GREEN}✓${NC} 已清除 memory/"
    fi

    # 技能
    if [ -d "$DATA_DIR/active_skills" ]; then
        rm -rf "$DATA_DIR/active_skills"
        echo -e "  ${GREEN}✓${NC} 已清除 active_skills/"
    fi
    if [ -d "$DATA_DIR/customized_skills" ]; then
        rm -rf "$DATA_DIR/customized_skills"
        echo -e "  ${GREEN}✓${NC} 已清除 customized_skills/"
    fi

    # 插件
    if [ -d "$DATA_DIR/plugins" ]; then
        rm -rf "$DATA_DIR/plugins"
        echo -e "  ${GREEN}✓${NC} 已清除 plugins/"
    fi

    # Python 包
    if [ -d "$DATA_DIR/python_packages" ]; then
        rm -rf "$DATA_DIR/python_packages"
        echo -e "  ${GREEN}✓${NC} 已清除 python_packages/"
    fi

    # 密钥目录
    if [ -d "$SECRET_DIR" ]; then
        rm -rf "$SECRET_DIR"
        echo -e "  ${GREEN}✓${NC} 已清除密钥目录"
    fi

    echo ""
    echo -e "${GREEN}${BOLD}硬重置完成。${NC}重新启动 YiYi 将回到全新安装状态。"
}

# ── 执行 ──
case "$MODE" in
    soft) do_soft_reset ;;
    hard) do_hard_reset ;;
esac

echo ""
