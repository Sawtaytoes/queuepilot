// Stand-in for node:child_process when a test drives the REAL server/src/adb.js offline.
//
// adb.js funnels every shell-out through spawnSync(ADB_BIN, ['-s', target, ...args]), so
// faking this one call is enough to exercise ensurePlexOpen's real wake/launch/poll logic
// without a Shield. The script lives in ADB_SCRIPT below; the test sets it up per scenario.
export const ADB_SCRIPT = {
  order: [], // 'wake' / 'launch', in the order adb.js issued them
  awake: true,
  foreground: [], // queue of activities; the last one repeats once drained
  _lastForeground: null,
};

export function resetScript({ awake = true, foreground = [] } = {}) {
  ADB_SCRIPT.order = [];
  ADB_SCRIPT.awake = awake;
  ADB_SCRIPT.foreground = [...foreground];
  ADB_SCRIPT._lastForeground = foreground.length ? foreground[foreground.length - 1] : null;
}

const out = (stdout) => ({ status: 0, stdout, stderr: '', error: null });

function nextForeground() {
  if (ADB_SCRIPT.foreground.length) {
    const v = ADB_SCRIPT.foreground.shift();
    ADB_SCRIPT._lastForeground = v;
    return v;
  }
  return ADB_SCRIPT._lastForeground;
}

export function spawnSync(_bin, argv = []) {
  const args = argv[0] === 'connect' ? argv : argv.slice(2); // drop ['-s', target]
  const line = args.join(' ');

  if (args[0] === 'connect') return out('connected');
  if (line === 'get-state') return out('device\n');
  if (line.includes('mCurrentFocus')) {
    const act = nextForeground();
    // The real dumpsys line adb.js regex-matches: `...Window{hash u0 <component>}`.
    return out(act ? `  mCurrentFocus=Window{a1b2 u0 ${act}}\n` : '  mCurrentFocus=null\n');
  }
  if (line.includes('mWakefulness')) {
    return out(`  mWakefulness=${ADB_SCRIPT.awake ? 'Awake' : 'Dozing'}\n`);
  }
  if (line.includes('input keyevent')) {
    if (line.includes('KEYCODE_WAKEUP')) ADB_SCRIPT.order.push('wake');
    return out('');
  }
  if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') {
    ADB_SCRIPT.order.push('launch');
    return out('Starting: Intent { act=android.intent.action.VIEW dat=plex:// }');
  }
  return out('');
}
