#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { startServer } = require('../src/server');
const { discoverWorktrees } = require('../src/git');

const mainRepoPath = path.join(os.homedir(), 'firefox');
const PID_FILE = path.join(os.homedir(), '.firefox-review.pid');

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

function readPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').split(':')[0], 10);
  return isNaN(pid) ? null : pid;
}

function stopDaemon() {
  const pid = readPid();
  if (!pid) {
    console.log('No running firefox-review instance found.');
    return false;
  }
  if (!isRunning(pid)) {
    fs.unlinkSync(PID_FILE);
    console.log('Cleaned up stale PID file (process was not running).');
    return false;
  }
  process.kill(pid, 'SIGTERM');
  fs.unlinkSync(PID_FILE);
  console.log(`Stopped firefox-review (PID ${pid}).`);
  return true;
}

async function daemonize(worktreeArgs) {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`firefox-review is already running (PID ${pid}).`);
    console.log('Use --restart to restart it, or --stop to stop it.');
    process.exit(0);
  }

  const child = spawn(process.execPath, [__filename, ...worktreeArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FIREFOX_REVIEW_DAEMON: '1' },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  // Wait for daemon to write the port, then print the URL
  const url = await waitForPort(2000);
  if (url) {
    console.log(`firefox-review running at ${url}`);
  } else {
    console.log('firefox-review started — opening browser.');
  }
  console.log('Use "firefox-review --stop" to stop it.');
  process.exit(0);
}

function waitForPort(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function poll() {
      if (!fs.existsSync(PID_FILE)) return resolve(null);
      const content = fs.readFileSync(PID_FILE, 'utf8').trim().split(':');
      if (content.length === 2) return resolve(`http://localhost:${content[1]}`);
      if (Date.now() < deadline) setTimeout(poll, 50);
      else resolve(null);
    }
    setTimeout(poll, 50);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (flag === '--stop') {
    stopDaemon();
    return;
  }

  if (flag === '--restart') {
    stopDaemon();
    // Brief pause to let the port free up
    await new Promise((r) => setTimeout(r, 500));
    daemonize(args.slice(1));
    return;
  }

  // Not already running as daemon — fork into background
  if (!process.env.FIREFOX_REVIEW_DAEMON) {
    daemonize(args);
    return;
  }

  // --- Running as daemon from here ---

  // Clean up PID file on exit
  process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
  process.on('SIGTERM', () => process.exit(0));

  const argName = args[0];
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

  startServer({ worktreeName, worktreePath, mainRepoPath, pidFile: PID_FILE });
}

if (require.main === module) {
  main();
}

module.exports = { readPid, isRunning, stopDaemon, waitForPort, buildEntries, pickDefaultEntry };
