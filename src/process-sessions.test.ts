import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const splitUnicode = [
  "const emit = (stream, parts, delay) => parts.forEach((part, index) => setTimeout(() => stream.write(Buffer.from(part)), delay + index * 100));",
  "emit(process.stdout, [Buffer.from('stdout:'), [0xe4], [0xb8, 0xad, 0xf0], [0x9f, 0x99, 0x82, 0x0a]], 0);",
  "emit(process.stderr, [Buffer.from('stderr:'), [0xe5], [0xa5, 0xbd, 0xf0], [0x9f, 0x8c, 0x9f, 0x0a]], 500);",
].join(" ");
const unicodeOutput = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e ${JSON.stringify(splitUnicode)}`,
  yieldTimeMs: 2_000,
});
assert.equal(unicodeOutput.running, false);
assert.match(unicodeOutput.output, /stdout:中🙂\n/);
assert.match(unicodeOutput.output, /stderr:好🌟\n/);

const incompleteUnicode = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e ${JSON.stringify(
    "process.stdout.write('stdout:'); process.stdout.write(Buffer.from([0xe4])); process.stderr.write('stderr:'); process.stderr.write(Buffer.from([0xf0, 0x9f]));",
  )}`,
  yieldTimeMs: 2_000,
});
assert.equal(incompleteUnicode.running, false);
assert.match(incompleteUnicode.output, /stdout:/);
assert.match(incompleteUnicode.output, /stderr:/);
assert.equal((incompleteUnicode.output.match(/�/g) ?? []).length, 2);

if (process.platform !== "win32" && existsSync("/bin/bash")) {
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/bash";
  try {
    const pipeLoginShell = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "shopt -q login_shell && printf 'login-shell\\n' || printf 'non-login-shell\\n'",
      yieldTimeMs: 2_000,
    });
    assert.equal(pipeLoginShell.running, false);
    assert.match(pipeLoginShell.output, /login-shell/);

    const ptyLoginShell = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "shopt -q login_shell && printf 'login-shell\\n' || printf 'non-login-shell\\n'",
      tty: true,
      yieldTimeMs: 2_000,
    });
    assert.equal(ptyLoginShell.running, false);
    assert.match(ptyLoginShell.output, /login-shell/);
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
}

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

if (process.platform !== "win32") {
  const nonReaderManager = new ProcessSessionManager({ completedSessionTtlMs: 1_000 });
  try {
    const nonReader = await nonReaderManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "sleep 2",
      yieldTimeMs: 10,
    });
    assert.equal(nonReader.running, true);
    assert.ok(nonReader.sessionId);

    const writeStartedAt = Date.now();
    const nonReaderResult = await nonReaderManager.write({
      workspaceId: "workspace-a",
      sessionId: nonReader.sessionId,
      chars: "x".repeat(1_000_000),
      yieldTimeMs: 10,
    });
    assert.ok(Date.now() - writeStartedAt < 1_000, "stdin writes must not wait for drain");
    assert.equal(nonReaderResult.running, true);
    nonReaderManager.terminate("workspace-a", nonReader.sessionId);
  } finally {
    await nonReaderManager.shutdown();
  }

  const closedStdinManager = new ProcessSessionManager({ completedSessionTtlMs: 1_000 });
  try {
    const closedStdin = await closedStdinManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "exec 0<&-; sleep 2",
      yieldTimeMs: 50,
    });
    assert.equal(closedStdin.running, true);
    assert.ok(closedStdin.sessionId);

    await new Promise((resolve) => setTimeout(resolve, 200));
    let firstWriteError: unknown;
    try {
      const firstWrite = await closedStdinManager.write({
        workspaceId: "workspace-a",
        sessionId: closedStdin.sessionId,
        chars: "hello",
        yieldTimeMs: 10,
      });
      assert.equal(firstWrite.running, true);
    } catch (error) {
      firstWriteError = error;
    }
    if (firstWriteError !== undefined) {
      assert.equal((firstWriteError as NodeJS.ErrnoException).code, "EPIPE");
    }

    const stillRunning = await closedStdinManager.write({
      workspaceId: "workspace-a",
      sessionId: closedStdin.sessionId,
      yieldTimeMs: 0,
    });
    assert.equal(stillRunning.running, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      closedStdinManager.write({
        workspaceId: "workspace-a",
        sessionId: closedStdin.sessionId,
        chars: "again",
        yieldTimeMs: 0,
      }),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE",
    );
    closedStdinManager.terminate("workspace-a", closedStdin.sessionId);
  } finally {
    await closedStdinManager.shutdown();
  }
}

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);

    const ptyCtrlCCode = [
      "process.stdin.setRawMode(true)",
      "process.stdin.on('data', data => {",
      "if (data.includes('\\u0003')) { process.stdout.write('pty-ctrl-c\\n'); process.exit(0); }",
      "})",
    ].join("; ");
    const ptyCtrlC = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e ${JSON.stringify(ptyCtrlCCode)}`,
      tty: true,
      yieldTimeMs: 100,
    });
    assert.equal(ptyCtrlC.running, true);
    assert.ok(ptyCtrlC.sessionId);

    const ptyInterrupted = await manager.write({
      workspaceId: "workspace-a",
      sessionId: ptyCtrlC.sessionId,
      chars: "\u0003",
      yieldTimeMs: 2_000,
    });
    assert.equal(ptyInterrupted.running, false);
    assert.match(ptyInterrupted.output, /pty-ctrl-c/);
  }
} finally {
  await manager.shutdown();
}

if (process.platform !== "win32") {
  const gracefulManager = new ProcessSessionManager({
    shutdownGracePeriodMs: 500,
  });
  try {
    const graceful = await gracefulManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `exec ${node} -e ${JSON.stringify(
        "console.log(process.pid); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120)); setInterval(() => {}, 1_000)",
      )}`,
      yieldTimeMs: 500,
    });
    assert.equal(graceful.running, true);
    const gracefulPid = Number(graceful.output.trim());
    assert.ok(Number.isInteger(gracefulPid) && gracefulPid > 0);

    const gracefulShutdownStartedAt = Date.now();
    const gracefulShutdown = gracefulManager.shutdown();
    assert.equal(gracefulManager.shutdown(), gracefulShutdown);
    await gracefulShutdown;
    assert.ok(
      Date.now() - gracefulShutdownStartedAt >= 80,
      "shutdown must await a gracefully exiting process",
    );
    assert.throws(() => process.kill(gracefulPid, 0), { code: "ESRCH" });
  } finally {
    await gracefulManager.shutdown();
  }

  const forcedManager = new ProcessSessionManager({
    shutdownGracePeriodMs: 100,
  });
  try {
    const forced = await forcedManager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `exec ${node} -e ${JSON.stringify(
        "console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      )}`,
      yieldTimeMs: 500,
    });
    assert.equal(forced.running, true);
    const forcedPid = Number(forced.output.trim());
    assert.ok(Number.isInteger(forcedPid) && forcedPid > 0);

    const forcedShutdownStartedAt = Date.now();
    await forcedManager.shutdown();
    assert.ok(
      Date.now() - forcedShutdownStartedAt >= 80,
      "shutdown must wait through the graceful grace period before force-killing",
    );
    assert.throws(() => process.kill(forcedPid, 0), { code: "ESRCH" });
  } finally {
    await forcedManager.shutdown();
  }
}
