# Genere les deux zips dans web-ext-artifacts/ :
#   - sonarqube_prompt_ia-<version>.zip         (Firefox, via web-ext)
#   - sonarqube_prompt_ia-safari-<version>.zip  (ressources pour le convertisseur Xcode)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).version
$out = Join-Path $root "web-ext-artifacts"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "== Zip Firefox =="
npx --yes web-ext build --source-dir $root --artifacts-dir $out --overwrite-dest --ignore-files "scripts" "scripts/**" "tools" "tools/**" "README.md"
if ($LASTEXITCODE -ne 0) { throw "web-ext build a echoue" }

Write-Host "== Zip Safari =="
$stage = Join-Path $env:TEMP ("sonar2prompt-safari-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item (Join-Path $root "popup") (Join-Path $stage "popup") -Recurse
    Copy-Item (Join-Path $root "icons") (Join-Path $stage "icons") -Recurse
    # Manifest sans les cles specifiques a Firefox (browser_specific_settings)
    node -e "const fs=require('fs'),p=require('path');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));delete m.browser_specific_settings;fs.writeFileSync(p.join(process.argv[2],'manifest.json'),JSON.stringify(m,null,2)+'\n');" (Join-Path $root "manifest.json") $stage
    if ($LASTEXITCODE -ne 0) { throw "transformation du manifest a echoue" }
    $zip = Join-Path $out "sonarqube_prompt_ia-safari-$version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    # tar.exe (bsdtar, fourni avec Windows) ecrit des entrees zip conformes avec "/",
    # contrairement a Compress-Archive (PS 5.1) dont les "\" cassent l'extraction sous macOS.
    tar -a -cf $zip -C $stage popup icons manifest.json
    if ($LASTEXITCODE -ne 0) { throw "creation du zip Safari a echoue" }
    Write-Host "Votre extension Safari est prete : $zip"
} finally {
    Remove-Item $stage -Recurse -Force
}
