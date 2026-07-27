$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $tempBase ("helm-sftp-state-" + [guid]::NewGuid().ToString("N")))
)
if (
  -not $tempDirectory.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not ([System.IO.Path]::GetFileName($tempDirectory)).StartsWith("helm-sftp-state-", [System.StringComparison]::Ordinal)
) {
  throw "临时测试目录越界：$tempDirectory"
}

try {
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  $tsc = Join-Path $projectRoot "node_modules\.bin\tsc.cmd"
  & $tsc `
    --ignoreConfig `
    --target ES2022 `
    --module CommonJS `
    --moduleResolution Node `
    --ignoreDeprecations 6.0 `
    --esModuleInterop `
    --skipLibCheck `
    --noEmitOnError `
    --types node `
    --rootDir $projectRoot `
    --outDir $tempDirectory `
    (Join-Path $projectRoot "tests\sftpSessionState.test.ts") `
    (Join-Path $projectRoot "tests\directoryViewState.test.ts") `
    (Join-Path $projectRoot "tests\sessionConnectionState.test.ts")
  if ($LASTEXITCODE -ne 0) {
    throw "SFTP 状态测试编译失败，退出码：$LASTEXITCODE"
  }

  & node --test `
    (Join-Path $tempDirectory "tests\sftpSessionState.test.js") `
    (Join-Path $tempDirectory "tests\directoryViewState.test.js") `
    (Join-Path $tempDirectory "tests\sessionConnectionState.test.js")
  if ($LASTEXITCODE -ne 0) {
    throw "SFTP 状态测试失败，退出码：$LASTEXITCODE"
  }
} finally {
  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
