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
import { resolveSystemPi } from "../../scripts/smoke-real-pi.js";

function createExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

test("real Pi resolver skips the repository-local npm binary", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-resolve-pi-"));
  try {
    const localBin = join(root, "node_modules", ".bin");
    const systemBin = join(root, "system-bin");
    mkdirSync(localBin, { recursive: true });
    mkdirSync(systemBin, { recursive: true });
    createExecutable(join(localBin, "pi"));
    createExecutable(join(systemBin, "pi"));

    const resolved = resolveSystemPi({
      projectRoot: root,
      pathValue: [localBin, systemBin].join(delimiter),
    });

    assert.equal(resolved, realpathSync(join(systemBin, "pi")));
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
    mkdirSync(linkedBin, { recursive: true });
    mkdirSync(systemBin, { recursive: true });
    const localPi = join(localPackage, "pi");
    createExecutable(localPi);
    symlinkSync(localPi, join(linkedBin, "pi"));
    createExecutable(join(systemBin, "pi"));

    const resolved = resolveSystemPi({
      projectRoot: root,
      pathValue: [linkedBin, systemBin].join(delimiter),
    });

    assert.equal(resolved, realpathSync(join(systemBin, "pi")));
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
