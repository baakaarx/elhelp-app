// `npm run build:apk -- http://55.0.55.70:3000` works on Windows and on Linux/macOS alike:
// it hands over to the PowerShell script on Windows and to the bash script everywhere else.
import { spawnSync } from 'node:child_process';

const [apiUrl, ...rest] = process.argv.slice(2);
const url = apiUrl || process.env.EXPO_PUBLIC_API_URL || '';
const windows = process.platform === 'win32';
const command = windows ? 'powershell' : 'bash';
const args = windows
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-apk.ps1', ...(url ? ['-ApiUrl', url] : []), ...rest]
  : ['scripts/build-apk.sh', ...(url ? [url] : [])];

const result = spawnSync(command, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
