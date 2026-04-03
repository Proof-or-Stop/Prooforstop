/**
 * Vite plugin: dev 模式自动注入浏览器 WS 客户端
 * build 模式不注入任何代码
 *
 * 注入到 <head> 最前面，确保 WS 调试桥在任何应用代码之前建立
 */

// vite 不是 main 的依赖，用 any 类型
type Plugin = any;
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export function browserVitePlugin(): Plugin {
  let clientCode: string | null = null;

  return {
    name: 'koala-browser-test',
    apply: 'serve',

    transformIndexHtml() {
      if (!clientCode) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const candidates = [
          join(__dirname, 'browser-client.js'),                        // 从 dist/tasks/ 运行
          join(__dirname, '..', '..', 'dist', 'tasks', 'browser-client.js'), // 从 src/tasks/ 运行
        ];
        const compiledPath = candidates.find(p => existsSync(p));
        if (!compiledPath) {
          console.error('[koala] browser-client.js not found, tried:', candidates);
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
