# -*- coding: utf-8 -*-
"""YiYi embedded Python runtime entry point.

Loaded by tauri-plugin-python at app startup.
Registers functions callable from Rust via PythonExt trait.
"""

import sys
import os
import json
import io
from contextlib import redirect_stdout, redirect_stderr

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
YIYI_HOME = os.environ.get("YIYI_WORKING_DIR") or os.environ.get("YIYICLAW_WORKING_DIR") or os.path.expanduser("~/.yiyi")
USER_PACKAGES = os.path.join(YIYI_HOME, "python_packages")
os.makedirs(USER_PACKAGES, exist_ok=True)

if USER_PACKAGES not in sys.path:
    sys.path.insert(0, USER_PACKAGES)

# ---------------------------------------------------------------------------
# Registered functions
# ---------------------------------------------------------------------------

def run_script(script_path, args_json="[]"):
    """Execute a Python script file, capturing stdout/stderr."""
    args = json.loads(args_json) if args_json else []
    old_argv = sys.argv[:]
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    sys.argv = [script_path] + args
    try:
        with open(script_path) as f:
            code = compile(f.read(), script_path, "exec")
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, {"__name__": "__main__", "__file__": script_path})
        out = stdout_buf.getvalue()
        err = stderr_buf.getvalue()
        result = out
        if err:
            result += "\n[stderr]: " + err
        return result if result.strip() else "Script executed successfully"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"
    finally:
        sys.argv = old_argv


# Shared global namespace for run_code, so consecutive calls can see each other's variables
_run_code_globals = {"__name__": "__main__"}


def run_code(code_str):
    """Execute arbitrary Python code string, capturing output.
    Uses a persistent namespace so variables survive across calls."""
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code_str, _run_code_globals)
        out = stdout_buf.getvalue()
        err = stderr_buf.getvalue()
        result = out
        if err:
            result += "\n[stderr]: " + err
        return result if result.strip() else "Code executed successfully"
    except Exception as e:
        return f"Error: {type(e).__name__}: {e}"


def pip_install(packages_json):
    """Install Python packages to user directory."""
    packages = json.loads(packages_json)
    if not packages:
        return "No packages specified"
    try:
        from pip._internal.cli.main import main as pip_main
        old_argv = sys.argv[:]
        sys.argv = ["pip"]
        try:
            pip_main(["install", "--target", USER_PACKAGES] + packages)
        except SystemExit:
            pass
        finally:
            sys.argv = old_argv
        return f"Installed: {', '.join(packages)}"
    except Exception as e:
        return f"Error installing packages: {e}"


def pip_install_offline(wheels_dir, req_file):
    """Install packages from local wheel files (offline bootstrap)."""
    if not os.path.isdir(wheels_dir):
        return f"Wheels directory not found: {wheels_dir}"
    try:
        from pip._internal.cli.main import main as pip_main
        old_argv = sys.argv[:]
        sys.argv = ["pip"]
        try:
            args = [
                "install",
                "--no-index",
                "--find-links", wheels_dir,
                "--target", USER_PACKAGES,
            ]
            if os.path.isfile(req_file):
                args += ["-r", req_file]
            pip_main(args)
        except SystemExit:
            pass
        finally:
            sys.argv = old_argv
        return "Offline install complete"
    except Exception as e:
        return f"Offline install error: {e}"


# Map package names that differ from their import names
_IMPORT_NAME_MAP = {
    "python_pptx": "pptx",
    "python_docx": "docx",
    "Pillow": "PIL",
    "pillow": "PIL",
    "beautifulsoup4": "bs4",
    "scikit-learn": "sklearn",
}


def check_packages(packages_json):
    """Return JSON array of missing packages."""
    packages = json.loads(packages_json)
    missing = []
    for pkg in packages:
        module_name = pkg.replace("-", "_").split(">=")[0].split("==")[0]
        module_name = _IMPORT_NAME_MAP.get(module_name, module_name)
        try:
            __import__(module_name)
        except ImportError:
            missing.append(pkg)
    return json.dumps(missing)


def get_python_info():
    """Return Python environment info as JSON."""
    return json.dumps({
        "version": sys.version,
        "executable": sys.executable,
        "path": sys.path,
        "user_packages": USER_PACKAGES,
        "platform": sys.platform,
    })


# Functions to register with tauri-plugin-python
_tauri_plugin_functions = [
    "run_script",
    "run_code",
    "pip_install",
    "pip_install_offline",
    "check_packages",
    "get_python_info",
]
