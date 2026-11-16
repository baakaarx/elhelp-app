/**
 * Prints a two-factor secret for the manager account, and the link an authenticator app scans.
 *
 *   npm run totp                       # a new secret
 *   npm run totp -- --code <SECRET>    # check what a code should be right now
 *
 * Put the secret in `server/.env` as ADMIN_TOTP_SECRET and restart. From then on the manager's
 * password login also asks for the six digits. Keep the secret in the password manager next to
 * the keystore: without it nobody can sign in to the dashboard.
 */
import { newTotpSecret, otpauthUrl, totpCode } from '../server/dist/totp.js';

const args = process.argv.slice(2);
const codeFlag = args.indexOf('--code');
const given = codeFlag >= 0 ? args[codeFlag + 1] : '';
const accountFlag = args.indexOf('--account');
const account = accountFlag >= 0 ? args[accountFlag + 1] : (process.env.ADMIN_EMAIL || 'manager@company.com');

if (given) {
  const at = Date.now();
  console.log(`code now:  ${totpCode(given, at)}`);
  console.log(`next code: ${totpCode(given, at + 30000)}`);
  process.exit(0);
}

const secret = newTotpSecret();
console.log('ADMIN_TOTP_SECRET=' + secret);
console.log('');
console.log('Add this to your authenticator app (or paste the link on the phone):');
console.log(otpauthUrl(secret, account));
console.log('');
console.log(`Check it: npm run totp -- --code ${secret}`);
