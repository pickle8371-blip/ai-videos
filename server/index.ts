import { spawn } from 'node:child_process';
import { createApp, createContext } from './app.js';
import { log } from './logger.js';

async function main() {
  const ctx = await createContext();
  const app = createApp(ctx);
  const server = app.listen(ctx.config.port, ctx.config.host, () => {
    const url = `http://${ctx.config.host === '0.0.0.0' ? 'localhost' : ctx.config.host}:${ctx.config.port}`;
    log.info(`Voidcraft.Video server listening on ${url}`);
    log.info(`Data directory: ${ctx.config.dataDir}`);
    log.info('Local AI engine: checking in the background…');
    void ctx.engine.refresh().then((s) => log.info(`Local AI engine: ${s.message}`));
    // Launchers set this so the browser opens only once the server is actually listening.
    if (process.env.VOIDCRAFT_OPEN_BROWSER === '1') openBrowser(`http://localhost:${ctx.config.port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') log.error(`Port ${ctx.config.port} is already in use. Set VOIDCRAFT_PORT to another port.`);
    else log.error('Server error', err);
    process.exit(1);
  });
  const shutdown = () => {
    log.info('Shutting down…');
    ctx.jobs.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => log.info(`Open ${url} in your browser.`)).unref();
  } catch {
    log.info(`Open ${url} in your browser.`);
  }
}

main().catch((err) => {
  log.error('Failed to start', err);
  process.exit(1);
});
