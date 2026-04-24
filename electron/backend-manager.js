const { spawn, execFileSync } = require('child_process');
const { existsSync, appendFileSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { app, dialog } = require('electron');

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8001;
const HEALTH_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}/health`;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 2_000;

let child = null;
let ready = false;
let unexpectedExitHandler = null;

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Mission Control');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, 'backend.log');

function writeLog(prefix, args) {
  const line = `[${new Date().toISOString()}] ${prefix} ${args.map(String).join(' ')}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  // Also surface in console for `electron .` / dev mode.
  if (prefix === '[backend][err]') {
    // eslint-disable-next-line no-console
    console.error(prefix, ...args);
  } else {
    // eslint-disable-next-line no-console
    console.log(prefix, ...args);
  }
}

function log(...args) { writeLog('[backend]', args); }
function logErr(...args) { writeLog('[backend][err]', args); }

function resolvePython() {
  const candidates = [
    '/opt/homebrew/bin/python3.12',
    '/usr/local/bin/python3.12',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to python3 in PATH; spawn will try $PATH.
  return 'python3';
}

function resolveBackendDir() {
  // Packaged: backend lives in Resources/app/backend (extraResources).
  // Dev: backend lives in <repo>/backend.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'backend');
  }
  return path.join(__dirname, '..', 'backend');
}

function pollHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 1500 }, (res) => {
      // Drain the body so the socket can close.
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pollHealth()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
}

function killStalePortHolder() {
  // If a previous Mission Control session crashed or was Force Quit, the
  // python uvicorn child may have been orphaned and is still bound to 8001.
  // Find it and kill it so we can spawn a fresh backend cleanly.
  let pids = '';
  try {
    pids = execFileSync('lsof', ['-tiTCP:' + BACKEND_PORT, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // lsof exits 1 when nothing is listening — that's the happy path.
    return;
  }
  if (!pids) return;
  for (const pidStr of pids.split('\n')) {
    const pid = parseInt(pidStr, 10);
    if (!pid) continue;
    // Sanity-check it's a python process before killing — never kill
    // something we didn't spawn.
    let cmd = '';
    try {
      cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      continue;
    }
    if (/python|uvicorn/i.test(cmd)) {
      log(`Killing stale backend on port ${BACKEND_PORT} (pid ${pid}): ${cmd}`);
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // Give it 800ms to release the port; SIGKILL if it didn't.
      const deadline = Date.now() + 800;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { break; }
      }
      try { process.kill(pid, 'SIGKILL'); } catch {}
    } else {
      logErr(`Port ${BACKEND_PORT} held by non-python pid ${pid} (${cmd}); leaving it alone.`);
    }
  }
}

function startBackend({ onUnexpectedExit } = {}) {
  if (child) return Promise.resolve(true);

  killStalePortHolder();

  const python = resolvePython();
  const cwd = resolveBackendDir();

  if (!existsSync(cwd)) {
    dialog.showErrorBox(
      'Mission Control',
      `Backend folder not found at ${cwd}.`
    );
    app.quit();
    return Promise.resolve(false);
  }

  // Sanity-check Python is callable. spawn will fail loudly otherwise.
  if (python === 'python3' && !existsSync('/opt/homebrew/bin/python3.12') && !existsSync('/usr/local/bin/python3.12')) {
    log('No python3.12 found at the standard Homebrew paths; falling back to python3 in PATH.');
  }

  log(`Spawning ${python} -m uvicorn server:app (cwd=${cwd})`);

  unexpectedExitHandler = onUnexpectedExit || null;

  // MC_PACKAGED tells the backend it's running out of a .app bundle so it can
  // redirect writable paths (SQLite, etc.) to ~/Library/Application Support.
  // Without this, Path(__file__).parent.parent resolves inside Resources/app/
  // which macOS refuses to let us write to.
  const backendEnv = app.isPackaged
    ? { ...process.env, PYTHONUNBUFFERED: '1', MC_PACKAGED: '1' }
    : { ...process.env, PYTHONUNBUFFERED: '1' };

  child = spawn(
    python,
    ['-m', 'uvicorn', 'server:app', '--host', BACKEND_HOST, '--port', String(BACKEND_PORT)],
    {
      cwd,
      env: backendEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  child.stdout.on('data', (buf) => log(buf.toString().trimEnd()));
  child.stderr.on('data', (buf) => logErr(buf.toString().trimEnd()));

  child.on('error', (err) => {
    logErr('Failed to spawn backend:', err.message);
    if (err.code === 'ENOENT') {
      dialog.showErrorBox(
        'Python 3.12 required',
        'Mission Control could not find Python 3.12.\n\n' +
          'Run scripts/mac-setup.sh from the repo to install Python 3.12 and the backend dependencies, then relaunch.'
      );
      app.quit();
    }
  });

  child.on('exit', (code, signal) => {
    log(`Backend exited (code=${code}, signal=${signal})`);
    const wasReady = ready;
    const handler = unexpectedExitHandler;
    child = null;
    ready = false;
    // If we're already shutting down or never came up, do nothing here.
    if (wasReady && !app.isQuiting && handler) {
      handler({ code, signal });
    }
  });

  return waitForHealth().then((ok) => {
    ready = ok;
    if (!ok) {
      logErr('Backend failed to become healthy within timeout.');
    } else {
      log('Backend healthy.');
    }
    return ok;
  });
}

function stopBackend() {
  if (!child) return Promise.resolve();
  // Suppress the unexpected-exit dialog while we shut down on purpose.
  unexpectedExitHandler = null;
  const proc = child;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once('exit', done);
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      logErr('SIGTERM failed:', e.message);
    }
    setTimeout(() => {
      if (!settled) {
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          logErr('SIGKILL failed:', e.message);
        }
        // Give it one more tick to fire its exit event.
        setTimeout(done, 250);
      }
    }, SHUTDOWN_GRACE_MS);
  });
}

function backendReady() {
  return ready;
}

module.exports = {
  startBackend,
  stopBackend,
  backendReady,
  BACKEND_PORT,
};
