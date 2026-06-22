/**
 * Vite plugin: auto-inject browser WS client in dev mode
 * build mode does not inject any code
 *
 * Inject at the very front of <head> to ensure the WS debug bridge is established before any application code
 */

// vite is not a dependency of main, use any type
type Plugin = any;
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export function browserVitePlugin(): Plugin {
  let clientCode: string | null = null;

  return {
    name: 'lattice-browser-test',
    apply: 'serve',

    transformIndexHtml() {
      if (!clientCode) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const candidates = [
          join(__dirname, 'browser-client.js'),                        // running from dist/tasks/
          join(__dirname, '..', '..', 'dist', 'tasks', 'browser-client.js'), // running from src/tasks/
        ];
        const compiledPath = candidates.find(p => existsSync(p));
        if (!compiledPath) {
          console.error('[lattice] browser-client.js not found, tried:', candidates);
          return [];
        }
        clientCode = readFileSync(compiledPath, 'utf-8');
      }
      return [
        {
          tag: 'script',
          children: clientCode,
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}
