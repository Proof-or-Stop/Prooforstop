#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const installStatusPath = "/opt/cell06/install-status.json";
let install = { status: "missing_install_status" };

if (fs.existsSync(installStatusPath)) {
  try {
    install = JSON.parse(fs.readFileSync(installStatusPath, "utf8"));
  } catch (error) {
    install = {
      status: "invalid_install_status",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const versionResult = spawnSync("codex", ["--version"], {
  encoding: "utf8",
  timeout: 30000,
});

const payload = {
  installStatus: install.status,
  installExitCode: install.exitCode ?? 0,
  codexVersion: null,
  versionStatus: "not_found",
  versionExitCode: versionResult.status ?? null,
  stderr: null,
};

if (versionResult.error) {
  payload.versionStatus = "not_found";
  payload.stderr = versionResult.error.message;
} else if (versionResult.status === 0) {
  payload.versionStatus = "ok";
  payload.codexVersion = (versionResult.stdout || "").trim() || null;
  payload.stderr = (versionResult.stderr || "").trim() || null;
} else {
  payload.versionStatus = "failed";
  payload.codexVersion = (versionResult.stdout || "").trim() || null;
  payload.stderr = (versionResult.stderr || "").trim() || null;
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
