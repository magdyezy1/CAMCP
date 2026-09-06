param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('meta-provision','meta-bind','meta-verify','meta-permissions','stdio','http','worker','admin')]
    [string]$Mode,
    [ValidatePattern('^[1-9][0-9]{0,29}$')]
    [string]$AccountId,
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$RuntimeArguments
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $projectRoot '.runtime/master-key.dpapi'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$keyBytes = $null
$oldKey = $env:MIRROR_MASTER_KEY
$oldDb = $env:MIRROR_DB
$oldWrites = $env:MIRROR_ALLOW_WRITES
try {
    Add-Type -AssemblyName System.Security
    if (-not (Test-Path -LiteralPath $keyFile)) {
        if ($Mode -ne 'meta-provision') { throw 'Initialize local credential storage with meta-provision first.' }
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $keyFile)) | Out-Null
        $keyBytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
        $protected = [System.Security.Cryptography.ProtectedData]::Protect($keyBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stream = [System.IO.File]::Open($keyFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $stream.Write($protected, 0, $protected.Length) } finally { $stream.Dispose() }
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $keyFile -AclObject $acl
        Write-Host 'Created Windows user-protected local encryption key.'
    } else {
        $keyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($keyFile), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    if ($keyBytes.Length -ne 32) { throw 'Invalid local encryption key.' }
    $env:MIRROR_MASTER_KEY = [Convert]::ToBase64String($keyBytes)
    $env:MIRROR_DB = Join-Path $projectRoot '.runtime/mirror.sqlite'
    $env:MIRROR_ALLOW_WRITES = 'false'
    $entry = switch ($Mode) {
        'meta-provision' { 'dist/tools/meta-connection.js' }
        'meta-bind' { 'dist/tools/meta-connection.js' }
        'meta-verify' { 'dist/tools/meta-connection.js' }
        'meta-permissions' { 'dist/tools/meta-connection.js' }
        'stdio' { 'dist/server/stdio.js' }
        'http' { 'dist/server/http.js' }
        'worker' { 'dist/server/worker.js' }
        'admin' { 'dist/tools/admin.js' }
    }
    Push-Location $projectRoot
    try {
        $metaArguments = @()
        if ($AccountId) { $metaArguments = @($AccountId) }
        if ($Mode -eq 'meta-provision') {
            $tokenInput = Read-Host 'Meta access token (hidden)' -AsSecureString
            $tokenPointer = [IntPtr]::Zero
            try {
                $tokenPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenInput)
                [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) | & node.exe (Join-Path $projectRoot $entry) provision @metaArguments
            } finally {
                if ($tokenPointer -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
                $tokenInput.Dispose()
            }
        }
        elseif ($Mode -eq 'meta-bind') { & node.exe (Join-Path $projectRoot $entry) bind @metaArguments }
        elseif ($Mode -eq 'meta-verify') { & node.exe (Join-Path $projectRoot $entry) verify @metaArguments }
        elseif ($Mode -eq 'meta-permissions') { & node.exe (Join-Path $projectRoot $entry) permissions @metaArguments }
        else { & node.exe (Join-Path $projectRoot $entry) @RuntimeArguments }
        $resultCode = $LASTEXITCODE
    } finally { Pop-Location }
    exit $resultCode
} catch {
    [Console]::Error.WriteLine('LOCAL_RUNTIME_FAILED: Could not unlock or run the local runtime. Use the same Windows account that provisioned its key. ' + $_.Exception.GetType().Name)
    exit 1
} finally {
    $env:MIRROR_MASTER_KEY = $oldKey
    $env:MIRROR_DB = $oldDb
    $env:MIRROR_ALLOW_WRITES = $oldWrites
    if ($null -ne $keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
}
