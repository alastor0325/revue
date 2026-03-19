#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { startServer } = require('../src/server');
const { discoverWorktrees } = require('../src/git');

const mainRepoPath = path.join(os.homedir(), 'firefox');
const PIDS_DIR = path.join(os.homedir(), '.firefox-review.pids');
// Legacy single-instance PID file — cleaned up on first use.
const LEGACY_PID_FILE = path.join(os.homedir(), '.firefox-review.pid');

function ensurePidsDir() {
  if (!fs.existsSync(PIDS_DIR)) fs.mkdirSync(PIDS_DIR, { recursive: true });
}

function pidFilePath(pid) {
  return path.join(PIDS_DIR, String(pid));
}

/**
 * Returns all tracked instances as { pid, port, filePath }.
 * port is null if the daemon hasn't written it yet.
 */
function readAllInstances() {
  if (!fs.existsSync(PIDS_DIR)) return [];
  const results = [];
  for (const name of fs.readdirSync(PIDS_DIR)) {
    const pid = parseInt(name, 10);
    if (isNaN(pid)) continue;
    const filePath = path.join(PIDS_DIR, name);
    try {
      const parts = fs.readFileSync(filePath, 'utf8').trim().split(':');
      const port = parts.length === 2 ? parseInt(parts[1], 10) : null;
      results.push({ pid, port: !isNaN(port) ? port : null, filePath });
    } catch {
      // ignore unreadable files
    }
  }
  return results;
}

/** Backward-compatible: returns the first tracked PID, or null. */
function readPid() {
  const all = readAllInstances();
  return all.length > 0 ? all[0].pid : null;
}

function buildEntries() {
  const entries = [];
  if (fs.existsSync(mainRepoPath)) {
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

  // Handle legacy single-instance PID file — kill the process it tracks.
  if (fs.existsSync(LEGACY_PID_FILE)) {
    try {
      const content = fs.readFileSync(LEGACY_PID_FILE, 'utf8').trim();
      const pid = parseInt(content.split(':')[0], 10);
      if (!isNaN(pid) && isRunning(pid)) {
        process.kill(pid, 'SIGTERM');
        const port = content.split(':')[1];
        console.log(`Stopped firefox-review (PID ${pid}${port ? `, port ${port}` : ''}).`);
        stoppedAny = true;
      }
    } catch {}
    try { fs.unlinkSync(LEGACY_PID_FILE); } catch {}
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
    console.log(`Stopped firefox-review (PID ${inst.pid}${portStr}).`);
    stoppedAny = true;
  }

  if (!stoppedAny) {
    console.log('No running firefox-review instance found.');
    return false;
  }
  return true;
}

async function daemonize(worktreeArgs) {
  ensurePidsDir();

  const child = spawn(process.execPath, [__filename, ...worktreeArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FIREFOX_REVIEW_DAEMON: '1' },
  });
  child.unref();
  fs.writeFileSync(pidFilePath(child.pid), String(child.pid));

  // Wait for daemon to write pid:port, then print the URL
  const url = await waitForPort(child.pid, 2000);
  if (url) {
    console.log(`firefox-review running at ${url}`);
  } else {
    console.log('firefox-review started — opening browser.');
  }
  console.log('Use "firefox-review --stop" to stop it.');
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
 * Parse CLI args, extracting --port and the optional worktree name.
 * Returns { port, rest } where rest is the remaining args
 * with --port and its value removed (for forwarding to the daemon).
 */
function parseArgs(args) {
  let port = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else {
      rest.push(args[i]);
    }
  }
  return { port, rest };
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
    daemonize(rawArgs.slice(1)); // forward all args (including --port) to new daemon
    return;
  }

  // Not already running as daemon — fork into background
  if (!process.env.FIREFOX_REVIEW_DAEMON) {
    daemonize(rawArgs);
    return;
  }

  // --- Running as daemon from here ---

  // Clean up this instance's PID file on exit
  const myPidFile = pidFilePath(process.pid);
  process.on('exit', () => { try { fs.unlinkSync(myPidFile); } catch {} });
  process.on('SIGTERM', () => process.exit(0));

  const { port, rest: positional } = parseArgs(rawArgs);
  const argName = positional[0];
  let worktreeName;
  let worktreePath;

  if (argName) {
    worktreeName = argName;
    worktreePath = path.join(os.homedir(), `firefox-${worktreeName}`);
  } else {
    const entries = buildEntries();
    if (entries.length === 0) {
      console.error('No Firefox repos or worktrees found under ~/firefox.');
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

module.exports = { readPid, readAllInstances, isRunning, stopDaemon, waitForPort, buildEntries, pickDefaultEntry, parseArgs, pidFilePath, ensurePidsDir, LEGACY_PID_FILE };
