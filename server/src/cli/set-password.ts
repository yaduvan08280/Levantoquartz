/**
 * Set a user's password from the command line — for an administrator who is
 * locked out. Restart the app afterwards: a running server holds its own copy.
 *
 *   node dist/cli/set-password.js <username> <new password>
 */
process.env.SCHEDULER = 'off';
import '../config.js';
import { pool, migrate } from '../db.js';
import { boot, rt, wb } from '../app.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 4) {
  console.error('Usage: set-password <username> <new password, at least 4 characters>');
  process.exit(2);
}
const quiet = console.log;
console.log = () => undefined;
await migrate();
await boot();
console.log = quiet;
try {
  console.log(rt.call('setFormsPassword', [username, password]));
  await wb.flush();
  console.log('Now restart the app.');
} catch (e: any) {
  console.error(e.message);
  process.exitCode = 1;
}
await pool.end();
