<#
.SYNOPSIS
  يبني APK جاهز للتركيب لتطبيق المهندس (نسخة release والـJavaScript جوّه الملف، تشتغل بدون سيرفر تطوير).

.DESCRIPTION
  - يكتب mobile\.env بعنوان الـAPI المطلوب (لازم يكون متاح من الموبايل).
  - يولّد mobile\android أول مرة عبر `expo prebuild`، ويشغّل Gradle بعدها.
  - ينسخ الناتج إلى mobile\dist-android ويطبع مساره.

.EXAMPLE
  .\scripts\build-apk.ps1 -ApiUrl http://55.0.55.70:3000

.EXAMPLE
  .\scripts\build-apk.ps1 -ApiUrl https://tracking.company.com -Clean
#>
[CmdletBinding()]
param(
  # عنوان السيرفر كما يراه الموبايل، مثال: http://55.0.55.70:3000 أو https://tracking.company.com
  [string]$ApiUrl,
  # امسح mobile\android وولّده من جديد (استخدمه بعد تغيير الإعدادات أو الأيقونات)
  [switch]$Clean,
  # نسخة debug للتجربة السريعة مع Metro (ما تشتغلش لوحدها على موبايل تاني)
  [switch]$DebugBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root 'mobile'
$envFile = Join-Path $mobile '.env'

function Stop-Build([string]$message, [string]$hint) {
  Write-Host ""
  Write-Host "✖ $message" -ForegroundColor Red
  if ($hint) { Write-Host "  $hint" -ForegroundColor Yellow }
  exit 1
}
function Step([string]$message) { Write-Host "`n▸ $message" -ForegroundColor Cyan }

# ── ١) عنوان الـAPI: من المعامل، ثم من بيئة النظام، ثم من mobile\.env ────────────
if (-not $ApiUrl) { $ApiUrl = $env:EXPO_PUBLIC_API_URL }
if (-not $ApiUrl -and (Test-Path $envFile)) {
  $existing = Get-Content $envFile | Where-Object { $_ -match '^\s*EXPO_PUBLIC_API_URL\s*=' } | Select-Object -First 1
  if ($existing) { $ApiUrl = ($existing -split '=', 2)[1].Trim() }
}
if (-not $ApiUrl) {
  Stop-Build 'مش محدد عنوان السيرفر اللي التطبيق يتصل بيه.' 'شغّل: .\scripts\build-apk.ps1 -ApiUrl http://YOUR-SERVER-IP:3000'
}
$ApiUrl = $ApiUrl.Trim().TrimEnd('/')
if ($ApiUrl -notmatch '^https?://') {
  Stop-Build "العنوان لازم يبدأ بـ http:// أو https:// — وصلني: $ApiUrl" 'مثال صحيح: http://55.0.55.70:3000'
}
if ($ApiUrl -match '://(localhost|127\.0\.0\.1)') {
  Stop-Build "العنوان $ApiUrl بيشاور على الموبايل نفسه، مش على السيرفر." 'استخدم IP الجهاز في الشبكة (ipconfig) أو دومين السيرفر.'
}

# ── ٢) تثبيت الاعتماديات لو لسه ───────────────────────────────────────────────
Step "عنوان الـAPI: $ApiUrl"
[IO.File]::WriteAllText($envFile, "EXPO_PUBLIC_API_URL=$ApiUrl`n")
Write-Host "  اتكتب في mobile\.env"

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Step 'تثبيت حزم npm (أول مرة، ممكن تاخد دقيقة)'
  Push-Location $root
  & npm ci
  if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Build 'npm ci فشل.' }
  Pop-Location
}

# ── ٣) أدوات أندرويد: JAVA_HOME و ANDROID_HOME ────────────────────────────────
function Resolve-Java {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { return $env:JAVA_HOME }
  $candidates = @(
    'C:\Program Files\Android\Android Studio\jbr',
    (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr'),
    (Join-Path $env:LOCALAPPDATA 'JetBrains\Toolbox\apps\AndroidStudio\ch-0\jbr')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'bin\java.exe'))) { return $candidate }
  }
  return $null
}
function Resolve-AndroidSdk {
  $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'platform-tools'))) { return $candidate }
  }
  return $null
}

$javaHome = Resolve-Java
if (-not $javaHome) {
  Stop-Build 'مش لاقي Java (JDK 17).' 'ثبّت Android Studio (بيجي معاه JBR) أو حط JAVA_HOME على مسار الـJDK.'
}
$androidSdk = Resolve-AndroidSdk
if (-not $androidSdk) {
  Stop-Build 'مش لاقي Android SDK.' 'افتح Android Studio ▸ Settings ▸ Languages & Frameworks ▸ Android SDK وثبّت SDK Platform + Build-Tools، أو حط ANDROID_HOME.'
}
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:PATH = "$javaHome\bin;$androidSdk\platform-tools;$env:PATH"
Write-Host "  JAVA_HOME    = $javaHome"
Write-Host "  ANDROID_HOME = $androidSdk"

# ── ٤) توليد مجلد أندرويد ─────────────────────────────────────────────────────
$androidDir = Join-Path $mobile 'android'
if ($Clean -and (Test-Path $androidDir)) {
  Step 'مسح mobile\android'
  Remove-Item -Recurse -Force $androidDir
}
if (-not (Test-Path (Join-Path $androidDir 'gradlew.bat'))) {
  Step 'توليد مشروع أندرويد (expo prebuild)'
  Push-Location $mobile
  & npx expo prebuild --platform android --no-install
  $prebuildExit = $LASTEXITCODE
  Pop-Location
  if ($prebuildExit -ne 0) { Stop-Build 'expo prebuild فشل.' 'شيل mobile\android وجرّب تاني، أو شوف الرسالة فوق.' }
}

# ── ٥) البناء ────────────────────────────────────────────────────────────────
$variant = if ($DebugBuild) { 'debug' } else { 'release' }
$task = if ($DebugBuild) { 'assembleDebug' } else { 'assembleRelease' }
Step "بناء APK ($variant) — أول مرة بياخد ٥–١٥ دقيقة"
Push-Location $androidDir
try {
  & .\gradlew.bat $task --no-daemon
  $gradleExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($gradleExit -ne 0) { Stop-Build "Gradle فشل (exit $gradleExit)." 'شوف أول سطر فيه error فوق؛ غالبًا SDK أو JDK ناقص.' }

# ── ٦) الناتج ────────────────────────────────────────────────────────────────
$apk = Join-Path $androidDir "app\build\outputs\apk\$variant\app-$variant.apk"
if (-not (Test-Path $apk)) { Stop-Build "البناء خلص بس مفيش ملف في $apk" }

$outDir = Join-Path $mobile 'dist-android'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$target = Join-Path $outDir "elhelp-engineer-1.0.0-$variant.apk"
Copy-Item $apk $target -Force
$sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 1)

Write-Host ""
Write-Host "✔ الـAPK جاهز ($sizeMb ميجا)" -ForegroundColor Green
Write-Host "  $target" -ForegroundColor Green
Write-Host ""
Write-Host "  تركيبه على موبايل موصول بالUSB:" -ForegroundColor DarkGray
Write-Host "    adb install -r `"$target`"" -ForegroundColor DarkGray
if ($ApiUrl -match '^http://') {
  Write-Host "  ملاحظة: العنوان HTTP، فالبناء ده بيسمح بالاتصال غير المشفّر (HTTPS أفضل)." -ForegroundColor DarkYellow
}
