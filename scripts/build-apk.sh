#!/usr/bin/env bash
# Build an installable APK for the engineer app (release build: the JS bundle is inside the file).
# The API URL must be reachable from the phone — it is baked in at build time.
#
#   ./scripts/build-apk.sh http://55.0.55.70:3000
#   API_URL=https://tracking.company.com ./scripts/build-apk.sh --clean
#
# Requirements: Node 22+, JDK 17, Android SDK (platform-tools + build-tools + platform 35/36).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mobile="$root/mobile"
clean=0
api_url="${1:-${API_URL:-}}"
[[ "${1:-}" == "--clean" ]] && { clean=1; api_url="${API_URL:-}"; }

if [[ -z "$api_url" && -f "$mobile/.env" ]]; then
  api_url="$(grep -E '^\s*EXPO_PUBLIC_API_URL\s*=' "$mobile/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]')"
fi
if [[ -z "$api_url" ]]; then
  echo "✖ Set the server URL: ./scripts/build-apk.sh http://YOUR-SERVER-IP:3000" >&2
  exit 1
fi
api_url="${api_url%/}"
[[ "$api_url" =~ ^https?:// ]] || { echo "✖ '$api_url' must start with http:// or https://" >&2; exit 1; }
[[ "$api_url" =~ ://(localhost|127\.0\.0\.1) ]] && { echo "✖ '$api_url' points at the phone itself, not the server" >&2; exit 1; }

echo "▸ API URL: $api_url"
printf 'EXPO_PUBLIC_API_URL=%s\n' "$api_url" > "$mobile/.env"

[[ -d "$root/node_modules" ]] || (cd "$root" && npm ci)
[[ -d "$mobile/android/gradlew" || -f "$mobile/android/gradlew" ]] || true

: "${JAVA_HOME:=/usr/lib/jvm/java-17-openjdk-amd64}"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
command -v java >/dev/null || { echo "✖ java not found (JDK 17). Set JAVA_HOME." >&2; exit 1; }
[[ -d "$ANDROID_HOME" ]] || { echo "✖ Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)." >&2; exit 1; }

if [[ $clean -eq 1 ]]; then
  echo "▸ removing mobile/android"
  rm -rf "$mobile/android"
fi
if [[ ! -f "$mobile/android/gradlew" ]]; then
  echo "▸ expo prebuild"
  (cd "$mobile" && npx expo prebuild --platform android --no-install)
fi

echo "▸ gradle assembleRelease"
(cd "$mobile/android" && ./gradlew assembleRelease --no-daemon)

apk="$mobile/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$apk" ]] || { echo "✖ build finished but $apk is missing" >&2; exit 1; }
mkdir -p "$mobile/dist-android"
target="$mobile/dist-android/elhelp-engineer-1.0.0-release.apk"
cp -f "$apk" "$target"
echo ""
echo "✔ APK: $target ($(du -h "$target" | cut -f1))"
echo "  install: adb install -r \"$target\""
