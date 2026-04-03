/**
 * ClaudeSession - Claude CLI 调用封装
 *
 * 用法：
 *   import { ClaudeSession } from "./claude-session.mjs";
 *   const session = new ClaudeSession({ model: "sonnet", debug: true });
 *   const result = await session.call("你好");
 *   const result2 = await session.callWithRetry("你好", { retries: 3 });
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, appendFileSync, rmSync } from "fs";
import { spawn } from "child_process";

const DEFAULT_OPTIONS = {
  model: "claude-sonnet-4-20250514",
  debug: false,
  retries: 5,
  timeout: 600000,       // 10 分钟
  heartbeatInterval: 30000, // 30 秒
  tools: false,           // 是否允许调用工具（默认关闭）
  allowedTools: [],       // 允许的工具列表（如 ["Bash", "Read"]），tools=true 时生效
  skills: false,          // 是否启用 skills 和项目设置
  tmpDir: null,           // 临时文件目录，不指定则自动创建
  errorDir: null,         // 错误日志目录
  label: "",              // 调用标签（用于日志）
  onStream: null,         // 流式回调 (type, data) => void
  onHeartbeat: null,      // 心跳回调 (elapsed, stdoutBytes, stderrBytes) => void
  onDebug: null,          // 调试回调 (msg) => void
};

export class ClaudeSession {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this._tmpDir = this.options.tmpDir || join(import.meta.dirname || ".", ".tmp-claude-session");
    this._errorDir = this.options.errorDir || null;
    if (!existsSync(this._tmpDir)) mkdirSync(this._tmpDir, { recursive: true });
    if (this._errorDir && !existsSync(this._errorDir)) mkdirSync(this._errorDir, { recursive: true });
  }

  _dbg(label, msg) {
    if (this.options.debug) {
      const line = `[DEBUG ${label}] ${msg}`;
      if (this.options.onDebug) this.options.onDebug(line);
      else console.log(`    ${line}`);
    }
  }

  /**
   * 单次调用 Claude CLI
   * @param {string} prompt - 输入 prompt
   * @param {object} callOptions - 覆盖 session 级选项
   * @returns {Promise<string>} - 模型输出文本
   */
  call(prompt, callOptions = {}) {
    const opts = { ...this.options, ...callOptions };
    const label = opts.label || "";
    const tmpFile = join(this._tmpDir, `${randomUUID()}.txt`);
    writeFileSync(tmpFile, prompt, "utf-8");
    const startTime = Date.now();

    const dbg = (msg) => this._dbg(label, msg);

    const debugFlag = opts.debug ? " --debug" : "";
    const skillFlags = opts.skills ? "" : " --disable-slash-commands --setting-sources user";
    const toolFlags = opts.tools
      ? (opts.allowedTools?.length ? ` --allowedTools ${opts.allowedTools.join(" ")}` : "")
      : " --disallowedTools Bash Read Edit Write Glob Grep Agent NotebookEdit";
    const cmd = `cat "${tmpFile}" | claude -p --verbose --model ${opts.model} --output-format stream-json --no-session-persistence --dangerously-skip-permissions${skillFlags}${toolFlags}${debugFlag}`;
    dbg(`cmd: ${cmd}`);
    dbg(`prompt length: ${prompt.length} chars`);

    return new Promise((resolve, reject) => {
      // 清除所有 Claude 相关环境变量
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE")) delete env[key];
      }

      const child = spawn("sh", ["-c", cmd], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      dbg(`child PID: ${child.pid}`);

      const stdoutChunks = [];
      const stderrChunks = [];
      let killed = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let printedTextLen = 0;

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        stdoutChunks.push(chunk);

        if (opts.onStream) {
          const raw = chunk.toString("utf-8");
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              opts.onStream(obj.type, obj, line);
            } catch {}
          }
        }
      });

      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
      });

      const timer = setTimeout(() => {
        killed = true;
        dbg(`TIMEOUT after ${Date.now() - startTime}ms`);
        child.kill("SIGKILL");
      }, opts.timeout);

      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        dbg(`heartbeat: ${elapsed}s elapsed, stdout: ${stdoutBytes} bytes`);
        if (opts.onHeartbeat) opts.onHeartbeat(elapsed, stdoutBytes, stderrBytes);
      }, opts.heartbeatInterval);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        try { unlinkSync(tmpFile); } catch {}

        const elapsed = Date.now() - startTime;
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        // 解析 stream-json
        let output = "";
        for (const line of rawStdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "result" && obj.result) {
              output = obj.result;
            }
            if (!output && obj.type === "assistant" && obj.message?.content) {
              output = obj.message.content
                .filter(c => c.type === "text")
                .map(c => c.text)
                .join("\n");
            }
          } catch {}
        }
        output = output.trim();

        dbg(`closed: code=${code} signal=${signal} elapsed=${elapsed}ms output=${output.length} chars`);

        if (killed) {
          return reject(new Error(`claude CLI 超时 (${opts.timeout / 1000}s)`));
        }
        if (output && (code === 0 || output.length > 50)) {
          return resolve(output);
        }
        const errMsg = !output
          ? `claude 返回空输出 (code=${code}, elapsed=${elapsed}ms, stderr=${stderr.trim().slice(0, 200)})`
          : (stderr.trim() || `exit code ${code}`);
        reject(new Error(errMsg));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        try { unlinkSync(tmpFile); } catch {}
        reject(err);
      });
    });
  }

  /**
   * 带重试的调用
   */
  async callWithRetry(prompt, callOptions = {}) {
    const opts = { ...this.options, ...callOptions };
    const label = opts.label || "";
    const retries = opts.retries || 5;
    let lastErr;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.call(prompt, callOptions);
      } catch (e) {
        lastErr = e;
        this._writeErrorLog(label, attempt, e, prompt);
        if (attempt < retries && this._isRetryable(e)) {
          const isEmpty = e.message.includes("返回空输出");
          const delay = isEmpty ? 0 : Math.min(1000 * 2 ** (attempt - 1), 30000);
          this._dbg(label, `第${attempt}次失败（${e.message.slice(0, 80)}），${delay ? delay / 1000 + "s 后" : "立即"}重试...`);
          if (delay) await new Promise(r => setTimeout(r, delay));
        } else if (!this._isRetryable(e)) {
          break;
        }
      }
    }
    throw new Error(`claude CLI 调用失败 (${retries}次尝试): ${lastErr.message.slice(0, 300)}`);
  }

  /**
   * 两步调用：pass1 → pass2（独立 session）
   * @param {string} pass1Prompt - 第一步 prompt
   * @param {string} pass2Prompt - 第二步 prompt，{{PASS1_OUTPUT}} 会被替换为第一步输出
   * @param {string} placeholder - 占位符，默认 {{PASS1_OUTPUT}}
   */
  async twoPass(pass1Prompt, pass2Prompt, callOptions = {}, placeholder = "{{PASS1_OUTPUT}}") {
    const label = callOptions.label || "";
    const pass1 = await this.callWithRetry(pass1Prompt, { ...callOptions, label: `${label}-P1` });
    const p2 = pass2Prompt.includes(placeholder)
      ? pass2Prompt.replace(placeholder, pass1)
      : pass2Prompt + "\n\n" + pass1;
    const pass2 = await this.callWithRetry(p2, { ...callOptions, label: `${label}-P2` });
    return { pass1, pass2 };
  }

  _isRetryable(err) {
    if (err.message.includes("返回空输出")) return true;
    const msg = err.message.toLowerCase();
    return msg.includes("network") || msg.includes("timeout") || msg.includes("econnreset")
      || msg.includes("econnrefused") || msg.includes("socket") || msg.includes("overloaded")
      || msg.includes("529") || msg.includes("500") || msg.includes("502") || msg.includes("503")
      || msg.includes("rate") || msg.includes("etimedout") || msg.includes("epipe");
  }

  _writeErrorLog(label, attempt, err, prompt) {
    if (!this._errorDir) return;
    const safeLabel = (label || "unknown").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_");
    const file = join(this._errorDir, `${safeLabel}-attempt${attempt}-${Date.now()}.log`);
    const content = [
      `label: ${label}`,
      `attempt: ${attempt}`,
      `time: ${new Date().toISOString()}`,
      `error: ${err.message}`,
      `---prompt (${prompt.length} chars)---`,
      prompt.slice(0, 2000),
      prompt.length > 2000 ? `\n...(truncated, total ${prompt.length} chars)` : "",
    ].join("\n");
    try { writeFileSync(file, content, "utf-8"); } catch {}
  }

  /**
   * 清理临时文件和错误日志
   */
  cleanup() {
    try { rmSync(this._tmpDir, { recursive: true, force: true }); } catch {}
    try { rmSync(this._errorDir, { recursive: true, force: true }); } catch {}
  }
}