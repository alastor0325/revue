#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { startServer } = require('../src/server');
const { discoverWorktrees } = require('../src/git');

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

function runInit(args, configFile = CONFIG_FILE) {
  const repoArg = args[0];
  if (!repoArg) {
    console.error('Usage: revue init <repo-path>');
    process.exit(1);
  }
  const repoPath = resolvePath(repoArg);
  if (!fs.existsSync(repoPath)) {
    console.error(`Error: path does not exist: ${repoPath}`);
    process.exit(1);
  }
  writeConfig({ defaultRepo: repoPath }, configFile);
  console.log(`Default repo set to: ${repoPath}`);
  console.log(`Config saved to: ${configFile}`);
}

// ── PID tracking ───────────────────────────────────────────────────────────

function ensurePidsDir() {
  if (!fs.existsSync(PIDS_DIR)) fs.mkdirSync(PIDS_DIR, { recursive: true });
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

function buildEntries(mainRepoPath) {
  const entries = [];
  if (mainRepoPath && fs.existsSync(mainRepoPath)) {
    entries.push({
      path: mainRepoPath,
      worktreeName: path.basename(mainRepoPath),
      isMain: true,
    });
    try {
      entries.push(...discoverWorktrees(mainRepoPath));
    } catch {
      // ignore
    }
  }
  return entries;
}

/**
 * Pick the default entry to open when no worktree arg is given.
 * Prefers the first registered worktree over the main repo so the user
 * sees actual patches instead of an empty "No patches found" state.
 */
function pickDefaultEntry(entries) {
  return entries.find((e) => !e.isMain) || entries[0];
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
 * Stop all running instances. Returns true if at least one was stopped.
 */
function stopDaemon() {
  let stoppedAny = false;

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
          stoppedAny = true;
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
    stoppedAny = true;
  }

  if (!stoppedAny) {
    console.log('No running revue instance found.');
    return false;
  }
  return true;
}

async function daemonize(worktreeArgs) {
  ensurePidsDir();

  const child = spawn(process.execPath, [__filename, ...worktreeArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, REVUE_DAEMON: '1' },
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
 * Parse CLI args, extracting --port and --repo and the optional worktree name.
 * Returns { port, repo, rest } where rest is the remaining positional args.
 */
function parseArgs(args) {
  let port = null;
  let repo = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { port, repo, rest };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const flag = rawArgs[0];

  if (flag === '--stop') {
    stopDaemon();
    return;
  }

  if (flag === '--restart') {
    stopDaemon();
    // Brief pause to let the ports free up
    await new Promise((r) => setTimeout(r, 500));
    daemonize(rawArgs.slice(1));
    return;
  }

  if (flag === 'init') {
    runInit(rawArgs.slice(1));
    return;
  }

  // Validate config/repo before forking so errors are visible to the user.
  if (!process.env.REVUE_DAEMON) {
    const { repo } = parseArgs(rawArgs);
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
    daemonize(rawArgs);
    return;
  }

  // --- Running as daemon from here ---

  // Clean up this instance's PID file on exit
  const myPidFile = pidFilePath(process.pid);
  process.on('exit', () => { try { fs.unlinkSync(myPidFile); } catch {} });
  process.on('SIGTERM', () => process.exit(0));

  const { port, repo, rest: positional } = parseArgs(rawArgs);
  const config = readConfig();
  const mainRepoPath = repo ? resolvePath(repo) : config.defaultRepo;

  const argName = positional[0];
  let worktreeName;
  let worktreePath;

  if (argName) {
    const entries = buildEntries(mainRepoPath);
    const found = entries.find((e) => e.worktreeName === argName);
    if (!found) {
      const names = entries.map((e) => e.worktreeName).join(', ') || 'none';
      console.error(`Error: worktree '${argName}' not found. Available: ${names}`);
      process.exit(1);
    }
    worktreeName = found.worktreeName;
    worktreePath = found.path;
  } else {
    const entries = buildEntries(mainRepoPath);
    if (entries.length === 0) {
      console.error(`No worktrees found for repo: ${mainRepoPath}`);
      process.exit(1);
    }
    const first = pickDefaultEntry(entries);
    worktreeName = first.worktreeName;
    worktreePath = first.path;
  }

  if (!fs.existsSync(worktreePath)) {
    console.error(`Error: Worktree not found at ${worktreePath}`);
    process.exit(1);
  }

  startServer({ worktreeName, worktreePath, mainRepoPath, pidFile: myPidFile, ...(port && { port }) });
}

if (require.main === module) {
  main();
}

module.exports = {
  readPid, readAllInstances, isRunning, stopDaemon, waitForPort,
  buildEntries, pickDefaultEntry, parseArgs, pidFilePath, ensurePidsDir,
  readConfig, writeConfig, runInit,
  LEGACY_PID_FILE, CONFIG_FILE,
};
