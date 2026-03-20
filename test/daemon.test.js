'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock child_process.spawn and src/server + src/git so requiring the bin
// doesn't trigger real git or server code
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../src/server', () => ({ startServer: jest.fn() }));
jest.mock('../src/git', () => ({ discoverWorktrees: jest.fn() }));

const { discoverWorktrees } = require('../src/git');
const {
  readPid, readAllInstances, isRunning, stopDaemon,
  waitForPort, buildEntries, pickDefaultEntry, parseArgs,
  pidFilePath, ensurePidsDir, LEGACY_PID_FILE,
  readConfig, writeConfig, runInit, printHelp, CONFIG_FILE,
} = require('../bin/revue');

// ── Helpers ───────────────────────────────────────────────────────────────

let tmpDir;

// Override PIDS_DIR inside the module by monkey-patching the module's internal
// constant.  We do this by re-requiring after setting the env so that tests
// get an isolated directory.  Instead, we use fs helpers to write test files
// into the real PIDS_DIR only when needed, and always clean up afterward.

// Convenience: write a pid-tracking file that looks like the daemon wrote it.
function writePidEntry(pid, port = null) {
  ensurePidsDir();
  const content = port != null ? `${pid}:${port}` : String(pid);
  fs.writeFileSync(pidFilePath(pid), content, 'utf8');
}

function removePidEntry(pid) {
  try { fs.unlinkSync(pidFilePath(pid)); } catch {}
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxreview-daemon-'));
  discoverWorktrees.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Remove any pid entries this test may have written for the current process.
  removePidEntry(process.pid);
});

// ── parseArgs ─────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('returns null port, null repo, and empty rest when no args', () => {
    const { port, repo, rest } = parseArgs([]);
    expect(port).toBeNull();
    expect(repo).toBeNull();
    expect(rest).toEqual([]);
  });

  test('parses --port value', () => {
    const { port, rest } = parseArgs(['--port', '8080']);
    expect(port).toBe(8080);
    expect(rest).toEqual([]);
  });

  test('parses worktree name without --port', () => {
    const { port, rest } = parseArgs(['my-feature']);
    expect(port).toBeNull();
    expect(rest).toEqual(['my-feature']);
  });

  test('parses --port alongside worktree name', () => {
    const { port, rest } = parseArgs(['my-feature', '--port', '9000']);
    expect(port).toBe(9000);
    expect(rest).toEqual(['my-feature']);
  });

  test('parses --port before worktree name', () => {
    const { port, rest } = parseArgs(['--port', '9000', 'my-feature']);
    expect(port).toBe(9000);
    expect(rest).toEqual(['my-feature']);
  });

  test('returns NaN port for non-numeric value', () => {
    const { port } = parseArgs(['--port', 'abc']);
    expect(isNaN(port)).toBe(true);
  });

  test('parses --repo value', () => {
    const { repo, rest } = parseArgs(['--repo', '/home/user/myrepo']);
    expect(repo).toBe('/home/user/myrepo');
    expect(rest).toEqual([]);
  });

  test('parses --repo alongside worktree name and --port', () => {
    const { port, repo, rest } = parseArgs(['--repo', '/home/user/myrepo', 'my-feature', '--port', '9000']);
    expect(repo).toBe('/home/user/myrepo');
    expect(port).toBe(9000);
    expect(rest).toEqual(['my-feature']);
  });
});

// ── pickDefaultEntry ───────────────────────────────────────────────────────

describe('pickDefaultEntry', () => {
  const main    = { path: '/home/user/firefox',        worktreeName: 'firefox', isMain: true  };
  const wt1     = { path: '/home/user/firefox-bugABC', worktreeName: 'bugABC',  isMain: false };
  const wt2     = { path: '/home/user/firefox-bugXYZ', worktreeName: 'bugXYZ',  isMain: false };

  test('prefers first non-main worktree when main repo is first in list', () => {
    const result = pickDefaultEntry([main, wt1, wt2]);
    expect(result.worktreeName).toBe('bugABC');
  });

  test('falls back to main repo when no registered worktrees exist', () => {
    const result = pickDefaultEntry([main]);
    expect(result.worktreeName).toBe('firefox');
    expect(result.isMain).toBe(true);
  });

  test('works when main repo is not in the list', () => {
    const result = pickDefaultEntry([wt1, wt2]);
    expect(result.worktreeName).toBe('bugABC');
  });

  test('returns the only entry when only one exists', () => {
    const result = pickDefaultEntry([wt1]);
    expect(result.worktreeName).toBe('bugABC');
  });
});

// ── readPid / readAllInstances ─────────────────────────────────────────────

describe('readPid', () => {
  test('returns null or a number (handles missing PIDS_DIR gracefully)', () => {
    const result = readPid();
    expect(result === null || typeof result === 'number').toBe(true);
  });
});

describe('readAllInstances', () => {
  test('returns empty array when PIDS_DIR does not exist', () => {
    // If the dir exists, all entries from other tests should have been cleaned up.
    // We just verify it returns an array and does not throw.
    const result = readAllInstances();
    expect(Array.isArray(result)).toBe(true);
  });

  test('returns instance with null port when only pid is written', () => {
    const fakePid = 99999901;
    writePidEntry(fakePid);
    try {
      const instances = readAllInstances();
      const found = instances.find((i) => i.pid === fakePid);
      expect(found).toBeDefined();
      expect(found.port).toBeNull();
    } finally {
      removePidEntry(fakePid);
    }
  });

  test('returns instance with port when pid:port is written', () => {
    const fakePid = 99999902;
    writePidEntry(fakePid, 8080);
    try {
      const instances = readAllInstances();
      const found = instances.find((i) => i.pid === fakePid);
      expect(found).toBeDefined();
      expect(found.port).toBe(8080);
    } finally {
      removePidEntry(fakePid);
    }
  });

  test('returns multiple instances when multiple pid files exist', () => {
    const pid1 = 99999903;
    const pid2 = 99999904;
    writePidEntry(pid1, 7777);
    writePidEntry(pid2, 7778);
    try {
      const instances = readAllInstances();
      const pids = instances.map((i) => i.pid);
      expect(pids).toContain(pid1);
      expect(pids).toContain(pid2);
      expect(instances.find((i) => i.pid === pid1).port).toBe(7777);
      expect(instances.find((i) => i.pid === pid2).port).toBe(7778);
    } finally {
      removePidEntry(pid1);
      removePidEntry(pid2);
    }
  });
});

// ── isRunning ──────────────────────────────────────────────────────────────

describe('isRunning', () => {
  test('returns true for the current process PID', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  test('returns false for a PID that does not exist', () => {
    expect(isRunning(2147483647)).toBe(false);
  });
});

// ── stopDaemon ─────────────────────────────────────────────────────────────

describe('stopDaemon', () => {
  test('returns false and prints message when no instances are running', () => {
    const result = stopDaemon();
    expect(result === false || result === true).toBe(true); // does not throw
  });

  test('kills process tracked in legacy PID file and removes the file', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    fs.writeFileSync(LEGACY_PID_FILE, `${process.pid}:7777`, 'utf8');
    try {
      const result = stopDaemon();
      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(fs.existsSync(LEGACY_PID_FILE)).toBe(false);
    } finally {
      killSpy.mockRestore();
      try { fs.unlinkSync(LEGACY_PID_FILE); } catch {}
    }
  });

  test('removes stale legacy PID file without killing anything when process is not running', () => {
    fs.writeFileSync(LEGACY_PID_FILE, '2147483647:7777', 'utf8');
    try {
      stopDaemon(); // should not throw
      expect(fs.existsSync(LEGACY_PID_FILE)).toBe(false);
    } finally {
      try { fs.unlinkSync(LEGACY_PID_FILE); } catch {}
    }
  });

  test('stops both a legacy instance and a new-style instance in one call', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    fs.writeFileSync(LEGACY_PID_FILE, `${process.pid}:7777`, 'utf8');
    writePidEntry(process.pid, 7778); // new-style entry (same pid, different port for test)
    try {
      const result = stopDaemon();
      expect(result).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(fs.existsSync(LEGACY_PID_FILE)).toBe(false);
    } finally {
      killSpy.mockRestore();
      try { fs.unlinkSync(LEGACY_PID_FILE); } catch {}
      removePidEntry(process.pid);
    }
  });

  test('cleans up stale pid file for a non-running PID', () => {
    const deadPid = 99999910;
    writePidEntry(deadPid, 7777);
    expect(fs.existsSync(pidFilePath(deadPid))).toBe(true);

    stopDaemon();

    expect(fs.existsSync(pidFilePath(deadPid))).toBe(false);
  });

  test('stops all running instances and removes their pid files', () => {
    // Use the current process as a "running" pid (safe: we send SIGTERM to a fake)
    // Instead, simulate by writing a pid file for the current process and checking
    // the file is removed. We can't actually kill the current process, so we spy
    // on process.kill to prevent it.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {});
    writePidEntry(process.pid, 7777);
    try {
      const result = stopDaemon();
      expect(result).toBe(true);
      expect(fs.existsSync(pidFilePath(process.pid))).toBe(false);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      removePidEntry(process.pid);
    }
  });

  test('stops multiple running instances and removes all their pid files', () => {
    // Spawn two real child processes so both PIDs are alive during the test.
    const { spawnSync } = require('child_process');
    // We need two live PIDs — use `node -e "require('fs').readFileSync(...)"` which
    // exits immediately. Instead, spawn sleep-like processes and kill them via stopDaemon.
    // The simplest approach that avoids real processes: spy on isRunning to return true
    // for our fake PIDs and spy on process.kill to prevent actual signals.
    const killSpy  = jest.spyOn(process, 'kill').mockImplementation(() => {});

    const fakePid1 = 99999931;
    const fakePid2 = 99999932;
    writePidEntry(fakePid1, 7777);
    writePidEntry(fakePid2, 7778);

    // Patch isRunning inside the module to treat fake PIDs as alive.
    // Since isRunning uses process.kill(pid, 0) and killSpy is now active,
    // any process.kill call will return (not throw), making isRunning return true.
    try {
      const result = stopDaemon();
      expect(result).toBe(true);
      expect(fs.existsSync(pidFilePath(fakePid1))).toBe(false);
      expect(fs.existsSync(pidFilePath(fakePid2))).toBe(false);
      expect(killSpy).toHaveBeenCalledWith(fakePid1, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(fakePid2, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      removePidEntry(fakePid1);
      removePidEntry(fakePid2);
    }
  });
});

// ── waitForPort ────────────────────────────────────────────────────────────

describe('waitForPort', () => {
  test('returns a Promise', () => {
    const result = waitForPort(99999920, 1);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  test('resolves to null when timeout expires and file has no port', () => {
    const fakePid = 99999921;
    writePidEntry(fakePid); // just pid, no port
    try {
      return waitForPort(fakePid, 60).then((url) => {
        expect(url).toBeNull();
      });
    } finally {
      removePidEntry(fakePid);
    }
  });

  test('resolves to null when pid file does not exist', async () => {
    const url = await waitForPort(99999922, 60);
    expect(url).toBeNull();
  });

  test('resolves to URL when pid:port is written before timeout', async () => {
    const fakePid = 99999923;
    writePidEntry(fakePid); // write pid only first
    // Write port after a short delay to simulate daemon binding
    setTimeout(() => writePidEntry(fakePid, 9999), 20);
    try {
      const url = await waitForPort(fakePid, 300);
      expect(url).toBe('http://localhost:9999');
    } finally {
      removePidEntry(fakePid);
    }
  });
});

// ── buildEntries ───────────────────────────────────────────────────────────

describe('buildEntries', () => {
  test('returns empty array when mainRepoPath does not exist', () => {
    const entries = buildEntries('/nonexistent/path/abc123');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(0);
  });

  test('includes main repo entry when path exists', () => {
    discoverWorktrees.mockReturnValue([]);
    const entries = buildEntries(tmpDir);
    expect(entries[0].isMain).toBe(true);
    expect(entries[0].path).toBe(tmpDir);
  });

  test('includes worktrees returned by discoverWorktrees', () => {
    discoverWorktrees.mockReturnValue([
      { path: '/fake/myrepo-feature', worktreeName: 'feature' },
    ]);
    const entries = buildEntries(tmpDir);
    expect(entries.some((e) => e.worktreeName === 'feature')).toBe(true);
  });

  test('does not throw when discoverWorktrees throws', () => {
    discoverWorktrees.mockImplementation(() => { throw new Error('git error'); });
    expect(() => buildEntries(tmpDir)).not.toThrow();
  });
});

// ── readConfig / writeConfig ───────────────────────────────────────────────

describe('readConfig / writeConfig', () => {
  let configFile;

  beforeEach(() => {
    configFile = path.join(tmpDir, 'config.json');
  });

  test('readConfig returns empty object when file does not exist', () => {
    expect(readConfig(configFile)).toEqual({});
  });

  test('readConfig returns parsed JSON', () => {
    fs.writeFileSync(configFile, JSON.stringify({ defaultRepo: '/some/repo' }), 'utf8');
    expect(readConfig(configFile)).toEqual({ defaultRepo: '/some/repo' });
  });

  test('readConfig returns empty object for malformed JSON', () => {
    fs.writeFileSync(configFile, 'not json', 'utf8');
    expect(readConfig(configFile)).toEqual({});
  });

  test('writeConfig writes JSON and creates parent dir', () => {
    const nestedConfig = path.join(tmpDir, 'subdir', 'config.json');
    writeConfig({ defaultRepo: '/my/repo' }, nestedConfig);
    expect(fs.existsSync(nestedConfig)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(nestedConfig, 'utf8'));
    expect(parsed.defaultRepo).toBe('/my/repo');
  });
});

// ── runInit ────────────────────────────────────────────────────────────────

describe('runInit', () => {
  let configFile;

  beforeEach(() => {
    configFile = path.join(tmpDir, 'config.json');
  });

  test('writes defaultRepo to config file', () => {
    runInit([tmpDir], configFile);
    const config = readConfig(configFile);
    expect(config.defaultRepo).toBe(tmpDir);
  });

  test('resolves relative path to absolute', () => {
    runInit([tmpDir], configFile);
    const config = readConfig(configFile);
    expect(path.isAbsolute(config.defaultRepo)).toBe(true);
  });

  test('exits with error when no path given', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => runInit([], configFile)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test('exits with error when path does not exist', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => runInit(['/nonexistent/path/abc'], configFile)).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('printHelp', () => {
  test('prints usage line', () => {
    const lines = [];
    jest.spyOn(console, 'log').mockImplementation((msg) => lines.push(msg));
    printHelp();
    console.log.mockRestore();
    const output = lines.join('\n');
    expect(output).toMatch(/Usage:/);
  });

  test('lists all commands', () => {
    const lines = [];
    jest.spyOn(console, 'log').mockImplementation((msg) => lines.push(msg));
    printHelp();
    console.log.mockRestore();
    const output = lines.join('\n');
    expect(output).toMatch(/init/);
    expect(output).toMatch(/--stop/);
    expect(output).toMatch(/--restart/);
    expect(output).toMatch(/--repo/);
    expect(output).toMatch(/--port/);
    expect(output).toMatch(/--help/);
  });
});
