"""双击运行：以管理员身份打开 PowerShell 7 并启动 HelM 开发环境。"""

import base64
import ctypes
from ctypes import wintypes
import json
import os
import shutil
import subprocess
import sys

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def is_admin() -> bool:
    return ctypes.windll.shell32.IsUserAnAdmin() != 0


def powershell7_path() -> str:
    program_files = os.environ.get("ProgramW6432", os.environ.get("ProgramFiles", r"C:\Program Files"))
    candidates = [
        os.path.join(program_files, "PowerShell", "7", "pwsh.exe"),
        shutil.which("pwsh.exe"),
    ]
    for candidate in dict.fromkeys(path for path in candidates if path):
        if not os.path.isfile(candidate):
            continue
        try:
            version = subprocess.run(
                [candidate, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
                capture_output=True, text=True, check=True, timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if version.stdout.strip() == "7":
            return os.path.abspath(candidate)
    raise RuntimeError("未找到可用的 PowerShell 7，请安装 PowerShell 7（pwsh.exe）后重试。")


def cargo_target_dir() -> str:
    metadata = subprocess.run(
        ["cargo", "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--no-deps", "--format-version", "1", "--locked", "--offline"],
        cwd=PROJECT_DIR, capture_output=True, text=True, encoding="utf-8", check=True, timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    # 先读取 Cargo 的有效配置（含 CARGO_TARGET_DIR），再解析映射盘路径，避免提权后找不到缓存。
    return os.path.realpath(json.loads(metadata.stdout)["target_directory"])


def dev_command(pwsh_path: str, target_path: str) -> str:
    current_path = os.path.dirname(pwsh_path) + os.pathsep + os.environ.get("PATH", "")
    environment = [
        f"$env:Path = {ps_quote(current_path)} + ';' + $env:Path",
        f"$env:CARGO_TARGET_DIR = {ps_quote(target_path)}",
    ]
    # UAC 启动的新进程不一定继承当前终端中设置的 Rust 工具目录。
    for name in ("CARGO_HOME", "RUSTUP_HOME"):
        if os.environ.get(name):
            environment.append(f"$env:{name} = {ps_quote(os.path.realpath(os.environ[name]))}")
    setup = "\n    ".join(environment)
    return f"""$ErrorActionPreference = 'Stop'
try {{
    {setup}
    Set-Location -LiteralPath {ps_quote(PROJECT_DIR)}
    foreach ($tool in @('node.exe', 'npm.cmd', 'cargo.exe')) {{
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {{
            throw "未找到 $tool，请安装并加入 PATH 后重试。"
        }}
    }}
    if (-not (Test-Path -LiteralPath 'node_modules/@tauri-apps/cli/tauri.js')) {{
        throw '缺少前端开发依赖，请先在项目根目录执行 npm ci。'
    }}
    Write-Host '正在以管理员身份启动 HelM 开发环境……' -ForegroundColor Cyan
    Write-Host '若已有 HelM 正在运行，请先从托盘退出；系统单实例会阻止重复启动。' -ForegroundColor Yellow
    # npm 的 predev 钩子负责清理本项目占用的 Vite 5177 端口。
    npm.cmd run tauri:dev
    if ($LASTEXITCODE -ne 0) {{
        throw "npm run tauri:dev 退出，代码：$LASTEXITCODE"
    }}
}} catch {{
    Write-Host "启动失败：$_" -ForegroundColor Red
}}
"""


def show_error(error: object) -> int:
    print(f"启动失败：{error}")
    try:
        input("按回车键退出...")
    except (EOFError, KeyboardInterrupt):
        pass
    return 1


def main() -> int:
    if sys.platform != "win32":
        print("此脚本仅支持 Windows。")
        return 1

    try:
        pwsh_path = powershell7_path()
        command = dev_command(pwsh_path, cargo_target_dir())
        encoded_command = base64.b64encode(command.encode("utf-16le")).decode("ascii")
        arguments = ["-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded_command]
        if is_admin():
            return subprocess.run([pwsh_path, *arguments], cwd=PROJECT_DIR).returncode

        shell_execute = ctypes.windll.shell32.ShellExecuteW
        shell_execute.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
        shell_execute.restype = wintypes.HINSTANCE
        result = shell_execute(
            None, "runas", pwsh_path, subprocess.list2cmdline(arguments), PROJECT_DIR, 1,
        )
        if not result or result <= 32:
            return show_error(f"无法打开管理员 PowerShell（返回码：{result}），请确认已允许 UAC 提权。")
        return 0
    except subprocess.CalledProcessError as error:
        return show_error((error.stderr or "").strip() or error)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        return show_error(error)


if __name__ == "__main__":
    sys.exit(main())
