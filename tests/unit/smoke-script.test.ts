import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCheckpointPreparationSettings, prepareCompactionFromBranch } from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { createSmokeSession, resolvePiLaunch, resolveSystemPi } from "../../scripts/smoke-real-pi.js";

const executableName = process.platform === "win32" ? "pi.cmd" : "pi";

function createExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

test("large real Pi smoke fixture requires both native summaries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-split-fixture-"));
  try {
    const sessionFile = createSmokeSession(root, SessionManager, true);
    const manager = SessionManager.open(sessionFile);
    const preparation = prepareCompactionFromBranch(
      manager.getBranch(), createCheckpointPreparationSettings(DEFAULT_CONFIG),
    );
    assert.ok(preparation);
    assert.equal(preparation.isSplitTurn, true);
    assert.ok(preparation.messagesToSummarize.length > 0);
    assert.ok(preparation.turnPrefixMessages.length > 0);
    const text = manager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    assert.ok(JSON.stringify(text).length > 400_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Pi resolver skips the repository-local npm binary", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-resolve-pi-"));
  try {
    const localBin = join(root, "node_modules", ".bin");
    const systemBin = join(root, "system-bin");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(systemBin, { recursive: true });
    createExecutable(join(localBin, executableName));
    createExecutable(join(systemBin, executableName));

    const resolved = resolveSystemPi({
      projectRoot: root,
      pathValue: [localBin, systemBin].join(delimiter),
    });

    assert.equal(resolved, realpathSync(join(systemBin, executableName)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Pi resolver skips an external symlink to repository node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-symlink-pi-"));
  try {
    const localPackage = join(root, "node_modules", "pi-package");
    const linkedBin = join(root, "linked-bin");
    const systemBin = join(root, "system-bin");
    mkdirSync(localPackage, { recursive: true });
    mkdirSync(systemBin, { recursive: true });
    const localPi = join(localPackage, executableName);
    createExecutable(localPi);
    if (process.platform === "win32") {
      symlinkSync(localPackage, linkedBin, "junction");
    } else {
      mkdirSync(linkedBin, { recursive: true });
      symlinkSync(localPi, join(linkedBin, executableName));
    }
    createExecutable(join(systemBin, executableName));

    const resolved = resolveSystemPi({
      projectRoot: root,
      pathValue: [linkedBin, systemBin].join(delimiter),
    });

    assert.equal(resolved, realpathSync(join(systemBin, executableName)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Pi launch uses the external npm package bin without a shell", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-windows-launch-"));
  try {
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    const executable = join(root, "pi.cmd");
    const entrypoint = join(packageRoot, "dist", "cli.js");
    createExecutable(executable);
    writeFileSync(entrypoint, "");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: "dist/cli.js" },
    }));
    assert.deepEqual(resolvePiLaunch(executable), {
      command: process.execPath,
      args: [realpathSync(entrypoint)],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Pi resolver rejects an explicit repository-local executable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-local-explicit-pi-"));
  try {
    const localBin = join(root, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true });
    const localPi = join(localBin, "pi");
    createExecutable(localPi);

    assert.throws(
      () => resolveSystemPi({
        projectRoot: root,
        pathValue: "",
        explicitPi: localPi,
      }),
      /仓库 node_modules/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Pi resolver honors an explicit executable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-explicit-pi-"));
  try {
    const explicitPi = join(root, "custom-pi");
    createExecutable(explicitPi);

    const resolved = resolveSystemPi({
      projectRoot: root,
      pathValue: "",
      explicitPi,
    });

    assert.equal(resolved, realpathSync(explicitPi));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
