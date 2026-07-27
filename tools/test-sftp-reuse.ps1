$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serverScript = Join-Path $PSScriptRoot "sftp-reuse-test-server.py"
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("helm-sftp-reuse-" + [guid]::NewGuid().ToString("N"))
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
    -ArgumentList @($serverScript) `
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
      throw "临时 SFTP 服务提前退出：$detail"
    }
    Start-Sleep -Milliseconds 100
  }

  if (-not (Test-Path -LiteralPath $fixtureOutput) -or (Get-Item -LiteralPath $fixtureOutput).Length -eq 0) {
    throw "临时 SFTP 服务启动超时"
  }

  $fixture = Get-Content -LiteralPath $fixtureOutput -Raw | ConvertFrom-Json
  $env:HELM_TEST_SFTP_PORT = [string]$fixture.port
  $env:HELM_TEST_SFTP_FINGERPRINT = [string]$fixture.fingerprint
  & cargo test --manifest-path (Join-Path $projectRoot "src-tauri\Cargo.toml") concurrent_sftp_open_reuses_one_session_per_connection -- --ignored --nocapture
  if ($LASTEXITCODE -ne 0) {
    throw "SFTP 复用集成测试失败，退出码：$LASTEXITCODE"
  }
} finally {
  Remove-Item Env:HELM_TEST_SFTP_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:HELM_TEST_SFTP_FINGERPRINT -ErrorAction SilentlyContinue

  if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
    Stop-Process -Id $fixtureProcess.Id -Force
    $fixtureProcess.WaitForExit()
  }

  foreach ($temporaryFile in @($fixtureOutput, $fixtureError)) {
    if (Test-Path -LiteralPath $temporaryFile) {
      Remove-Item -LiteralPath $temporaryFile -Force
    }
  }
  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Force
  }
}
