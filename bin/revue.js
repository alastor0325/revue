#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { openBrowser } = require('../src/server');
const { startHub, resolveEntry, resolveProject } = require('../src/hub');

const CONFIG_DIR  = path.join(os.homedir(), '.revue');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const PIDS_DIR       = path.join(os.homedir(), '.revue.pids');
const LEGACY_PID_FILE = path.join(os.homedir(), '.revue.pid');

// Migration: also read/stop instances from the old firefox-review PID locations.
const LEGACY_FIREFOX_PIDS_DIR = path.join(os.homedir(), '.firefox-review.pids');
const LEGACY_FIREFOX_PID_FILE = path.join(os.homedir(), '.firefox-review.pid');

// ── Config ─────────────────────────────────────────────────────────────────

function readConfig(configFile = CONFIG_FILE) {
  if (!fs.existsSync(configFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(data, configFile = CONFIG_FILE) {
  const dir = path.dirname(configFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function resolvePath(p) {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

/**
 * `revue init [<repo-path>] [--port <port>]` — remember the default repo and/or
 * the default port.  Each call updates only the keys it is given, so setting
 * the port (e.g. the port forwarded from a remote box) keeps the repo.
 */
function runInit(args, configFile = CONFIG_FILE) {
  const { port, rest } = parseArgs(args);
  const repoArg = rest[0];
  if (!repoArg && port == null) {
    console.error('Usage: revue init [<repo-path>] [--port <port>]');
    process.exit(1);
  }
  const config = readConfig(configFile);
  if (repoArg) {
    const repoPath = resolvePath(repoArg);
    if (!fs.existsSync(repoPath)) {
      console.error(`Error: path does not exist: ${repoPath}`);
      process.exit(1);
    }
    config.defaultRepo = repoPath;
    console.log(`Default repo set to: ${repoPath}`);
  }
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('Error: --port must be a number from 1 to 65535.');
      process.exit(1);
    }
    config.port = port;
    console.log(`Default port set to: ${port}`);
  }
  writeConfig(config, configFile);
  console.log(`Config saved to: ${configFile}`);
}


// ── PID tracking ───────────────────────────────────────────────────────────

function ensurePidsDir() {
  fs.mkdirSync(PIDS_DIR, { recursive: true });
}

function pidFilePath(pid) {
  return path.join(PIDS_DIR, String(pid));
}

/**
 * Returns all tracked instances as { pid, port, filePath }.
 * Also reads from the legacy firefox-review pids dir for migration.
 * port is null if the daemon hasn't written it yet.
 */
function readAllInstances() {
  const results = [];
  for (const dir of [PIDS_DIR, LEGACY_FIREFOX_PIDS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const pid = parseInt(name, 10);
      if (isNaN(pid)) continue;
      const filePath = path.join(dir, name);
      try {
        const parts = fs.readFileSync(filePath, 'utf8').trim().split(':');
        const port = parts.length === 2 ? parseInt(parts[1], 10) : null;
        results.push({ pid, port: !isNaN(port) ? port : null, filePath });
      } catch {
        // ignore unreadable files
      }
    }
  }
  return results;
}

/** Backward-compatible: returns the first tracked PID, or null. */
function readPid() {
  const all = readAllInstances();
  return all.length > 0 ? all[0].pid : null;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop all running instances by sending SIGTERM. Returns the array of PIDs that
 * were signalled (still running at the time). Callers should `waitForExit` on
 * the result before reusing the port — the processes don't die synchronously.
 */
function stopDaemon() {
  const killed = [];

  // Handle legacy single-instance PID files (both new and old tool names).
  for (const legacyFile of [LEGACY_PID_FILE, LEGACY_FIREFOX_PID_FILE]) {
    if (fs.existsSync(legacyFile)) {
      try {
        const content = fs.readFileSync(legacyFile, 'utf8').trim();
        const pid = parseInt(content.split(':')[0], 10);
        if (!isNaN(pid) && isRunning(pid)) {
          process.kill(pid, 'SIGTERM');
          const port = content.split(':')[1];
          console.log(`Stopped revue (PID ${pid}${port ? `, port ${port}` : ''}).`);
          killed.push(pid);
        }
      } catch {}
      try { fs.unlinkSync(legacyFile); } catch {}
    }
  }

  const instances = readAllInstances();
  const running = instances.filter((i) => isRunning(i.pid));
  const stale   = instances.filter((i) => !isRunning(i.pid));

  for (const inst of stale) {
    try { fs.unlinkSync(inst.filePath); } catch {}
  }

  for (const inst of running) {
    process.kill(inst.pid, 'SIGTERM');
    try { fs.unlinkSync(inst.filePath); } catch {}
    const portStr = inst.port ? `, port ${inst.port}` : '';
    console.log(`Stopped revue (PID ${inst.pid}${portStr}).`);
    killed.push(inst.pid);
  }

  if (killed.length === 0) {
    console.log('No running revue instance found.');
  }
  return killed;
}

/**
 * Wait for the given PIDs to actually exit after a SIGTERM, so the port they
 * held is released before we return.  SIGTERM is asynchronous: returning from
 * stopDaemon() immediately leaves a window where the dying daemon still holds
 * its port, which made a quick `--stop` + `--port N` reuse land on N+1.  Any
 * process that ignores SIGTERM past the timeout is force-killed with SIGKILL.
 */
async function waitForExit(pids, { timeoutMs = 5000, pollMs = 100 } = {}) {
  if (!pids || pids.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(isRunning);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    remaining = remaining.filter(isRunning);
  }
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// ── Hub client ─────────────────────────────────────────────────────────────
// A running daemon is a hub serving every project on its one port, so a new
// `revue --repo X` adds X to it instead of starting another daemon.

/** Running revue daemons ({ pid, port, filePath }), one per port, restricted to `port` if given. */
function runningHubs(port = null) {
  const byPort = new Map();
  for (const i of readAllInstances()) {
    if (i.port && isRunning(i.pid) && (port == null || i.port === port) && !byPort.has(i.port)) byPort.set(i.port, i);
  }
  return [...byPort.values()];
}

function runningHubPorts(port = null) {
  return runningHubs(port).map((h) => h.port);
}

async function hubRequest(port, method, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/hub/projects`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(1000), // loopback: a live hub answers in ms
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/**
 * Register a repo with the first running hub that accepts it.
 * Returns { url } on success, { error } when a hub rejected the request (e.g.
 * unknown worktree), or null when no hub accepted it, so the caller starts
 * one.  With null comes `legacy`: tracked daemons that answered 404, i.e. a
 * pre-0.3.0 revue with no hub endpoint, which the caller must replace or the
 * new daemon would be bumped off their port.
 */
async function registerWithHub({ repoPath, worktree, port = null }) {
  const legacy = [];
  for (const h of runningHubs(port)) {
    try {
      const { status, json } = await hubRequest(h.port, 'POST', { repoPath, worktree: worktree || null });
      if (status === 200 && json && json.path) return { url: `http://localhost:${h.port}${json.path}` };
      if (status === 400 && json && json.error) return { error: json.error };
      if (status === 404) legacy.push(h);
    } catch { /* not reachable — try the next one */ }
  }
  return legacy.length ? { legacy } : null;
}

/** Stop pre-0.3.0 daemons so the new hub can take their port. */
async function replaceLegacyDaemons(legacy) {
  for (const h of legacy) {
    console.log(`Replacing an older revue (before 0.3.0) on port ${h.port}.`);
    try { process.kill(h.pid, 'SIGTERM'); } catch {}
    try { fs.unlinkSync(h.filePath); } catch {}
  }
  await waitForExit(legacy.map((h) => h.pid));
}

/** Projects mounted on all running hubs, so --restart can bring them back. */
async function collectHubProjects() {
  const out = [];
  for (const p of runningHubPorts()) {
    try {
      const { status, json } = await hubRequest(p, 'GET');
      if (status === 200 && json && Array.isArray(json.projects)) out.push(...json.projects);
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Exit with the error if the repo/worktree in `args` can't be opened.  Runs in
 * the foreground before forking because the detached daemon's output is
 * discarded.  (A running hub validates registrations itself.)
 */
function exitIfUnresolvable(args) {
  const { repo, rest } = parseArgs(args);
  try {
    const target = resolveProject({ repoPath: repo ? resolvePath(repo) : readConfig().defaultRepo, worktree: rest[0] });
    resolveEntry(target.repoPath, target.worktree);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function daemonize(worktreeArgs, extraProjects = []) {
  ensurePidsDir();

  const child = spawn(process.execPath, [__filename, ...worktreeArgs], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      REVUE_DAEMON: '1',
      ...(extraProjects.length && { REVUE_PROJECTS: JSON.stringify(extraProjects) }),
    },
  });
  child.unref();
  fs.writeFileSync(pidFilePath(child.pid), String(child.pid));

  // Wait for daemon to write pid:port, then print the URL
  const url = await waitForPort(child.pid, 2000);
  if (url) {
    console.log(`revue running at ${url}`);
  } else {
    console.log('revue started — opening browser.');
  }
  console.log('Use "revue --stop" to stop it.');
  process.exit(0);
}

function waitForPort(pid, timeoutMs) {
  return new Promise((resolve) => {
    const file = pidFilePath(pid);
    const deadline = Date.now() + timeoutMs;
    function poll() {
      if (!fs.existsSync(file)) return resolve(null);
      const content = fs.readFileSync(file, 'utf8').trim().split(':');
      if (content.length === 2) return resolve(`http://localhost:${content[1]}`);
      if (Date.now() < deadline) setTimeout(poll, 50);
      else resolve(null);
    }
    setTimeout(poll, 50);
  });
}

/**
 * Parse CLI args, extracting --port, --repo, --no-open and the optional worktree name.
 * Returns { port, repo, noOpen, rest } where rest is the remaining positional args.
 */
function parseArgs(args) {
  let port = null;
  let repo = null;
  let noOpen = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[++i];
    } else if (args[i] === '--no-open') {
      noOpen = true;
    } else {
      rest.push(args[i]);
    }
  }
  return { port, repo, noOpen, rest };
}

function printHelp() {
  console.log(`
Usage: revue [worktree] [options]

Commands:
  revue                        Start with default repo (configured via init)
  revue init <repo-path>       Set the default repo path
  revue init --port <port>     Set the default port (e.g. a port forwarded over SSH)
  revue <worktree>             Open a specific worktree by name
  revue --stop                 Stop the running instance
  revue --restart              Restart the running instance

One daemon serves every repo on one port, each under /r/<repo-name>/.
Running revue for another repo while it is up adds that repo to it.

Options:
  --repo <path>                Override the default repo for this run
  --port <port>                Use (or join) the daemon on this port
                               (default: the port from init, else 7777)
  --no-open                    Do not open the browser on start
  --help, -h                   Show this help message
  --version, -v                Print the version and exit

Examples:
  revue init ~/code/firefox
  revue
  revue my-feature
  revue my-feature --port 8080
  revue --repo ~/other/repo feature
`.trim());
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const flag = rawArgs[0];

  if (flag === '--help' || flag === '-h') {
    printHelp();
    return;
  }

  if (flag === '--version' || flag === '-v') {
    console.log(require('../package.json').version);
    return;
  }

  if (flag === '--stop') {
    await waitForExit(stopDaemon()); // block until the port is actually released
    return;
  }

  if (flag === '--restart') {
    exitIfUnresolvable(rawArgs.slice(1)); // before stopping anything
    // Capture the mounted projects first so the new hub serves them all again.
    const previous = await collectHubProjects();
    // Wait for the old instance(s) to fully exit so the port is free before
    // the new one tries to bind it.
    await waitForExit(stopDaemon());
    daemonize(rawArgs.slice(1), previous);
    return;
  }

  if (flag === 'init') {
    runInit(rawArgs.slice(1));
    return;
  }

  // Validate config/repo before forking so errors are visible to the user.
  if (!process.env.REVUE_DAEMON) {
    const { repo, port, noOpen, rest } = parseArgs(rawArgs);
    const config = readConfig();
    const repoPath = repo ? resolvePath(repo) : config.defaultRepo;
    if (!repoPath) {
      console.error('No repo configured. Run: revue init <repo-path>');
      console.error('Or use: revue --repo <repo-path>');
      process.exit(1);
    }
    if (!fs.existsSync(repoPath)) {
      console.error(`Error: repo path does not exist: ${repoPath}`);
      process.exit(1);
    }
    const registered = await registerWithHub({ repoPath, worktree: rest[0], port: port || config.port });
    if (registered && registered.error) {
      console.error(`Error: ${registered.error}`);
      process.exit(1);
    }
    if (registered && registered.url) {
      console.log(`revue running at ${registered.url}`);
      if (!noOpen) openBrowser(registered.url);
      return;
    }
    exitIfUnresolvable(rawArgs); // before stopping anything
    if (registered && registered.legacy) await replaceLegacyDaemons(registered.legacy);
    daemonize(rawArgs);
    return;
  }

  // --- Running as daemon from here ---

  // Clean up this instance's PID file on exit
  const myPidFile = pidFilePath(process.pid);
  process.on('exit', () => { try { fs.unlinkSync(myPidFile); } catch {} });
  process.on('SIGTERM', () => process.exit(0));

  const { port: portArg, repo, noOpen, rest: positional } = parseArgs(rawArgs);
  const config = readConfig();
  const port = portArg || config.port;
  const mainRepoPath = repo ? resolvePath(repo) : config.defaultRepo;

  let extra = [];
  try { extra = JSON.parse(process.env.REVUE_PROJECTS || '[]'); } catch {}

  try {
    await startHub({
      projects: [{ repoPath: mainRepoPath, worktree: positional[0] || null }, ...extra],
      pidFile: myPidFile,
      ...(port && { port }),
      noOpen,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  readPid, readAllInstances, isRunning, stopDaemon, waitForExit, waitForPort,
  parseArgs, pidFilePath, ensurePidsDir,
  runningHubPorts, registerWithHub, replaceLegacyDaemons, collectHubProjects,
  readConfig, writeConfig, runInit, printHelp,
  LEGACY_PID_FILE, CONFIG_FILE,
};
