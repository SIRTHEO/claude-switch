import fs from 'node:fs';
import path from 'node:path';

export function getCurrent(claudeJsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    return data?.oauthAccount?.emailAddress || '';
  } catch {
    return '';
  }
}

export function save(email, claudeJsonPath, accountsDirPath) {
  fs.mkdirSync(accountsDirPath, { recursive: true, mode: 0o700 });

  const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  const accountFile = path.join(accountsDirPath, `${email}.json`);

  fs.writeFileSync(accountFile, JSON.stringify(data.oauthAccount || {}, null, 2));
  if (process.platform !== 'win32') {
    fs.chmodSync(accountFile, 0o600);
  }
}

export function load(email, claudeJsonPath, accountsDirPath) {
  const accountFile = path.join(accountsDirPath, `${email}.json`);

  if (!fs.existsSync(accountFile)) {
    throw new Error(`No saved account for ${email}`);
  }

  const accountData = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
  const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  data.oauthAccount = accountData;

  const tmp = claudeJsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0));
  fs.renameSync(tmp, claudeJsonPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(claudeJsonPath, 0o600);
  }
}
