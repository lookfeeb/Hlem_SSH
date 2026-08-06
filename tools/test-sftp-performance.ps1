param(
  [ValidateRange(0, 1000)]
  [int]$LatencyMs = 80,
  [ValidateRange(8, 512)]
  [int]$SizeMiB = 64,
  [ValidateSet(0, 1, 2, 4)]
  [int]$Parts = 0
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverScript = Join-Path $PSScriptRoot "sftp-reuse-test-server.py"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $tempBase ("helm-sftp-performance-" + [guid]::NewGuid().ToString("N")))
)
if (
  -not $tempDirectory.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not ([System.IO.Path]::GetFileName($tempDirectory)).StartsWith("helm-sftp-performance-", [System.StringComparison]::Ordinal)
) {
  throw "临时性能测试目录越界：$tempDirectory"
}

$fixtureOutput = Join-Path $tempDirectory "fixture.json"
$fixtureError = Join-Path $tempDirectory "fixture.err"
$fixtureProcess = $null

try {
  & python -c "import paramiko" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "缺少 Python paramiko，请先执行：python -m pip install paramiko"
  }

  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  $fixtureProcess = Start-Process `
    -FilePath "python" `
    -ArgumentList @($serverScript, "--latency-ms", [string]$LatencyMs) `
    -RedirectStandardOutput $fixtureOutput `
    -RedirectStandardError $fixtureError `
    -WindowStyle Hidden `
    -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ((Test-Path -LiteralPath $fixtureOutput) -and (Get-Item -LiteralPath $fixtureOutput).Length -gt 0) {
      break
    }
    if ($fixtureProcess.HasExited) {
      $detail = Get-Content -LiteralPath $fixtureError -Raw -ErrorAction SilentlyContinue
      throw "临时 SFTP 性能服务提前退出：$detail"
    }
    Start-Sleep -Milliseconds 100
  }

  if (-not (Test-Path -LiteralPath $fixtureOutput) -or (Get-Item -LiteralPath $fixtureOutput).Length -eq 0) {
    throw "临时 SFTP 性能服务启动超时"
  }

  $fixture = Get-Content -LiteralPath $fixtureOutput -Raw | ConvertFrom-Json
  $env:HELM_TEST_SFTP_PORT = [string]$fixture.port
  $env:HELM_TEST_SFTP_FINGERPRINT = [string]$fixture.fingerprint
  $env:HELM_TEST_SFTP_BYTES = [string]([int64]$SizeMiB * 1024 * 1024)
  if ($Parts -gt 0) {
    $env:HELM_TEST_SFTP_PARTS = [string]$Parts
  }

  $partsLabel = if ($Parts -gt 0) { [string]$Parts } else { "产品默认" }
  Write-Host "SFTP 性能测试：RTT=${LatencyMs}ms，文件=${SizeMiB}MiB，并行=${partsLabel}"
  & cargo test `
    --manifest-path (Join-Path $projectRoot "src-tauri\Cargo.toml") `
    measures_parallel_sftp_transfer_throughput `
    -- `
    --ignored `
    --nocapture
  if ($LASTEXITCODE -ne 0) {
    throw "SFTP 性能测试失败，退出码：$LASTEXITCODE"
  }
} finally {
  Remove-Item Env:HELM_TEST_SFTP_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:HELM_TEST_SFTP_FINGERPRINT -ErrorAction SilentlyContinue
  Remove-Item Env:HELM_TEST_SFTP_BYTES -ErrorAction SilentlyContinue
  Remove-Item Env:HELM_TEST_SFTP_PARTS -ErrorAction SilentlyContinue

  if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
    Stop-Process -Id $fixtureProcess.Id -Force
    $fixtureProcess.WaitForExit()
  }

  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
