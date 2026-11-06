#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot

# ── 工具函数 ──────────────────────────────────────────────

function Write-Header {
    Clear-Host
    Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║          HelM  Build  Script         ║" -ForegroundColor Cyan
    Write-Host "╠══════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "║  1  LTO 编译  (体积小 / 速度慢)      ║" -ForegroundColor White
    Write-Host "║  2  普通编译  (速度快)                ║" -ForegroundColor White
    Write-Host "║  3  清理编译缓存                      ║" -ForegroundColor White
    Write-Host "║  0  退出                              ║" -ForegroundColor DarkGray
    Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Assert-Commands {
    foreach ($cmd in @("npm", "cargo")) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Host "[错误] 未找到命令: $cmd，请确认已安装并加入 PATH。" -ForegroundColor Red
            exit 1
        }
    }
}

function Install-NodeDeps {
    Write-Step "安装 / 更新前端依赖"
    Push-Location $Root
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    } finally {
        Pop-Location
    }
}

function Get-CargoTargetDirectory {
    Push-Location $Root
    try {
        $metadata = cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --no-deps --locked --offline
        if ($LASTEXITCODE -ne 0) { throw "无法读取 Cargo 编译目录" }
        return [IO.Path]::GetFullPath(($metadata | ConvertFrom-Json).target_directory)
    } finally {
        Pop-Location
    }
}

function Show-Artifact {
    $targetDir = Get-CargoTargetDirectory
    # 同时支持默认构建和显式指定 Rust target 的构建。
    $releaseDirs = @("$targetDir\release")
    if (Test-Path -LiteralPath $targetDir) {
        $releaseDirs += Get-ChildItem -LiteralPath $targetDir -Directory |
            ForEach-Object { Join-Path $_.FullName "release" } |
            Where-Object { Test-Path -LiteralPath $_ }
    }
    $installers = @()
    foreach ($releaseDir in $releaseDirs) {
        $bundleDir = Join-Path $releaseDir "bundle"
        if (Test-Path -LiteralPath $bundleDir) {
            $installers += Get-ChildItem -LiteralPath $bundleDir -Recurse -File |
                Where-Object { $_.Extension -in @(".msi", ".exe", ".nsis") }
        }
    }

    Write-Host ""
    if ($installers.Count -gt 0) {
        Write-Host "✔ 编译成功，安装包:" -ForegroundColor Green
        foreach ($f in $installers) {
            $size = [math]::Round($f.Length / 1MB, 2)
            Write-Host "  $($f.FullName)  (${size} MB)" -ForegroundColor Yellow
        }
    } else {
        # fallback: 找 exe
        $exe = Get-ChildItem -LiteralPath $releaseDirs `
                             -Filter "helm.exe" -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($exe) {
            $size = [math]::Round($exe.Length / 1MB, 2)
            Write-Host "✔ 编译成功" -ForegroundColor Green
            Write-Host "  产物: $($exe.FullName)  (${size} MB)" -ForegroundColor Yellow
        } else {
            Write-Host "✔ 编译完成" -ForegroundColor Green
        }
    }
}

function Invoke-BuildLTO {
    Write-Step "LTO 编译（thin LTO + strip）"
    Install-NodeDeps
    Push-Location $Root
    try {
        $env:CARGO_PROFILE_RELEASE_LTO           = "thin"
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "1"
        $env:CARGO_PROFILE_RELEASE_STRIP         = "symbols"
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
    } finally {
        Remove-Item Env:\CARGO_PROFILE_RELEASE_LTO           -ErrorAction SilentlyContinue
        Remove-Item Env:\CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue
        Remove-Item Env:\CARGO_PROFILE_RELEASE_STRIP         -ErrorAction SilentlyContinue
        Pop-Location
    }
    Show-Artifact
}

function Invoke-BuildNormal {
    Write-Step "普通编译"
    Install-NodeDeps
    Push-Location $Root
    try {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
    } finally {
        Pop-Location
    }
    Show-Artifact
}

function Invoke-Clean {
    Write-Step "清理编译缓存"

    $targetDir = Get-CargoTargetDirectory
    $projectDir = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $targetDir = $targetDir.TrimEnd('\')
    if ($targetDir -eq [IO.Path]::GetPathRoot($targetDir).TrimEnd('\') -or
        $projectDir -eq $targetDir -or
        $projectDir.StartsWith($targetDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理磁盘根目录或项目所在目录: $targetDir"
    }
    # 使用 Cargo 实际配置目录，同时收集仓库内的旧缓存。
    $candidates = @(
        @{ Path = $targetDir;                      Label = "Cargo target (当前配置)" },
        @{ Path = "$Root\target";                  Label = "Cargo target (旧)" },
        @{ Path = "$Root\src-tauri\target";        Label = "Cargo target (旧/备用)" },
        @{ Path = "$Root\tools\free-port\target";  Label = "free-port 工具 target" },
        @{ Path = "$Root\tools\terminal-native-bench\target"; Label = "终端基准工具 target" },
        @{ Path = "$Root\dist";                    Label = "Vite 构建产物 dist" },
        @{ Path = "$Root\.vite";                   Label = "Vite 缓存 .vite" },
        @{ Path = "$Root\node_modules\.vite";      Label = "Vite 模块缓存" },
        @{ Path = "$Root\test-results";            Label = "Playwright 测试结果" }
    )

    $present = @()
    $totalBytes = 0
    foreach ($entry in ($candidates | Sort-Object -Property { $_.Path } -Unique)) {
        $entry.Path = [IO.Path]::GetFullPath($entry.Path)
        if (Test-Path -LiteralPath $entry.Path) {
            $bytes = (Get-ChildItem -LiteralPath $entry.Path -Recurse -Force -File -ErrorAction SilentlyContinue |
                      Measure-Object -Property Length -Sum).Sum
            if (-not $bytes) { $bytes = 0 }
            $entry["Bytes"] = [int64]$bytes
            $totalBytes += [int64]$bytes
            $present += $entry
        }
    }

    if ($present.Count -eq 0) {
        Write-Host "  没有需要清理的目录。" -ForegroundColor DarkGray
        return
    }

    Write-Host ""
    foreach ($entry in $present) {
        $sizeMB = [math]::Round($entry.Bytes / 1MB, 1)
        Write-Host ("  [{0,7:N1} MB]  {1}" -f $sizeMB, $entry.Path) -ForegroundColor DarkGray
        Write-Host ("              {0}" -f $entry.Label) -ForegroundColor DarkGray
    }
    $totalMB = [math]::Round($totalBytes / 1MB, 1)
    Write-Host ""
    Write-Host ("  合计: {0} MB" -f $totalMB) -ForegroundColor Yellow
    Write-Host ""
    $confirm = Read-Host "  确认全部删除？(y/N)"
    if ($confirm -notmatch "^[Yy]$") {
        Write-Host "  已取消" -ForegroundColor DarkGray
        return
    }

    # 优先调用 cargo clean，让 cargo 自己处理 lock/读写权限
    Push-Location $Root
    try {
        if (Test-Path "$Root\src-tauri\Cargo.toml") {
            Write-Host "  cargo clean (src-tauri)" -ForegroundColor DarkGray
            cargo clean --manifest-path src-tauri/Cargo.toml --target-dir $targetDir
            if ($LASTEXITCODE -ne 0) { throw "cargo clean 失败" }
        }
    } finally {
        Pop-Location
    }

    # cargo clean 之后，残留的目录（dist、.vite、test-results 等）逐一删除
    $failed = @()
    foreach ($entry in $present) {
        if (-not (Test-Path -LiteralPath $entry.Path)) { continue }
        try {
            $resolvedPath = (Get-Item -LiteralPath $entry.Path -Force).FullName.TrimEnd('\')
            if ($resolvedPath -ne $targetDir -and
                -not $resolvedPath.StartsWith($projectDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw "缓存目录超出预期范围: $resolvedPath"
            }
            Remove-Item -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop
            Write-Host ("  ✔ 已删除  {0}" -f $entry.Path) -ForegroundColor Green
        } catch {
            $failed += $entry.Path
            Write-Host ("  ✗ 失败    {0}  ({1})" -f $entry.Path, $_.Exception.Message) -ForegroundColor Red
        }
    }

    Write-Host ""
    if ($failed.Count -eq 0) {
        Write-Host "✔ 全部缓存已清理" -ForegroundColor Green
    } else {
        Write-Host ("⚠ 有 {0} 个目录未能完全删除（可能被进程占用）。" -f $failed.Count) -ForegroundColor Yellow
    }

    Write-Host ""
    Read-Host "  按回车返回菜单" | Out-Null
}

# ── 主循环 ────────────────────────────────────────────────

Assert-Commands

while ($true) {
    Write-Header
    $choice = Read-Host "请选择 [0-3]"

    switch ($choice.Trim()) {
        "1" {
            try { Invoke-BuildLTO }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
        }
        "2" {
            try { Invoke-BuildNormal }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
        }
        "3" {
            try { Invoke-Clean }
            catch { Write-Host "[错误] $_" -ForegroundColor Red }
        }
        "0" {
            Write-Host "再见。" -ForegroundColor DarkGray
            exit 0
        }
        default {
            Write-Host "无效输入，请输入 0-3。" -ForegroundColor Yellow
            Start-Sleep -Seconds 1
        }
    }
}
