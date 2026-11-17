import { randomBytes, scryptSync } from 'node:crypto';
import { stdin, stdout } from 'node:process';

if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
  throw new Error('Run this script in an interactive terminal so the password is not echoed.');
}
stdout.write('Enter a NEW reports admin password (12–128 characters): ');
stdin.setRawMode(true);
stdin.resume();
let password = '';
stdin.on('data', (chunk) => {
  for (const char of chunk.toString('utf8')) {
    if (char === '\u0003') {
      stdout.write('\nCancelled.\n');
      process.exit(1);
    }
    if (char === '\r' || char === '\n') {
      stdin.setRawMode(false);
      stdin.pause();
      if (password.length < 12 || password.length > 128) {
        password = '';
        stdout.write('\nPassword length must be between 12 and 128 characters.\n');
        process.exit(1);
      }
      const salt = randomBytes(16);
      const derived = scryptSync(password, salt, 64).toString('hex');
      password = '';
      stdout.write('\nCopy this hash into Firebase Secret Manager (it is not the password):\n');
      stdout.write(salt.toString('hex') + ':' + derived + '\n');
      process.exit(0);
    }
    if (char === '\u007f' || char === '\b') {
      password = password.slice(0, -1);
    } else if (char >= ' ' && char <= '~') {
      password += char;
    }
  }
});
