import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ServiceError } from './auth.js';
import { validateUrl } from './browser.js';

export async function openExternalBrowser(raw: string) {
  const url = await validateUrl(raw);
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) throw new ServiceError('external_browser_open_unsupported');
  try {
    await promisify(execFile)(command, [url.toString()], { timeout: 10000 });
  } catch {
    throw new ServiceError('external_browser_open_failed');
  }
}
