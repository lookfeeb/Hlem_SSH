param(
  [ValidateSet("all", "sftp", "terminal")]
  [string]$Suite = "all"
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $tempBase ("helm-frontend-tests-" + [guid]::NewGuid().ToString("N")))
)
if (
  -not $tempDirectory.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not ([System.IO.Path]::GetFileName($tempDirectory)).StartsWith("helm-frontend-tests-", [System.StringComparison]::Ordinal)
) {
  throw "临时测试目录越界：$tempDirectory"
}

$sftpTests = @(
  "connectionSectionState.test.ts",
  "contextMenuPosition.test.ts",
  "directoryViewState.test.ts",
  "keyedInFlight.test.ts",
  "path.test.ts",
  "remoteDownloadPlan.test.ts",
  "sessionConnectionState.test.ts",
  "sftpDirectoryEvents.test.ts",
  "sftpSessionState.test.ts",
  "transferRecords.test.ts"
)
$terminalTests = @(
  "sessionConnectionState.test.ts",
  "sshConnectionState.test.ts",
  "terminalRegistry.test.ts",
  "terminalViewportFollow.test.ts"
)
$allTests = Get-ChildItem -LiteralPath (Join-Path $projectRoot "tests") -Filter "*.test.ts" -File |
  Sort-Object Name |
  ForEach-Object Name
$testFiles = switch ($Suite) {
  "sftp" { $sftpTests }
  "terminal" { $terminalTests }
  default { $allTests }
}

try {
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  $tsc = Join-Path $projectRoot "node_modules\.bin\tsc.cmd"
  $sources = $testFiles | ForEach-Object { Join-Path $projectRoot "tests\$_" }
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
    @sources
  if ($LASTEXITCODE -ne 0) {
    throw "前端测试编译失败，退出码：$LASTEXITCODE"
  }

  $compiledTests = $testFiles | ForEach-Object {
    Join-Path $tempDirectory ("tests\" + [System.IO.Path]::ChangeExtension($_, ".js"))
  }
  & node --test @compiledTests
  if ($LASTEXITCODE -ne 0) {
    throw "前端测试失败，退出码：$LASTEXITCODE"
  }
} finally {
  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
