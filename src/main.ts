import { runtimePath, acquireLock } from './config.js';
import { createApp } from './server.js';

process.umask(0o077);
const dir = runtimePath();
const release = acquireLock(dir);
const port = Number(process.env.SSAL_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SSAL_PORT');
try {
  const app = await createApp({ dir, port });
  console.log(`쌀-GPT: ${app.origin}`);
  console.log('Credentials, browser profile and evidence are stored outside the checkout.');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      release();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
} catch (error) {
  release();
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}
