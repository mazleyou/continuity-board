import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { ComfyBackend } from './backends/comfy.ts';
import { MockBackend } from './backends/mock.ts';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.env.PORT ?? 5177);
const host = process.env.HOST ?? '127.0.0.1';
const backend = process.env.CB_BACKEND === 'mock'
  ? new MockBackend(Number(process.env.CB_MOCK_DELAY_MS ?? 600))
  : new ComfyBackend(process.env.COMFY_URL ?? 'http://127.0.0.1:8188', {
    timeoutMs: Number(process.env.CB_TIMEOUT_MS ?? 15 * 60_000),
    // Unload models whenever the queue drains; helps machines that need --disable-smart-memory.
    freeOnIdle: process.env.CB_FREE_ON_IDLE === '1',
    keepOutputs: process.env.CB_KEEP_COMFY_OUTPUTS === '1',
  });

const store = new Store(resolve(process.env.CB_DATA ?? resolve(root, 'data')));
const allowedHosts = [host, ...(process.env.CB_ALLOWED_HOSTS ?? '').split(',')].map((h) => h.trim()).filter(Boolean);
const { server, runner } = createApp(store, backend, resolve(root, 'web'), { allowedHosts });
await runner.recover();
server.listen(port, host);
