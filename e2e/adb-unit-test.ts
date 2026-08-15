// Offline unit tests for the pure helpers in server/src/adb.js (D5).
//
// No real Shield, no adb binary, no plex.tv — these cover:
//   * alias-group normalisation (flat list vs nested)
//   * index / offset / same-profile matching (owner username vs display title)
//   * selected-tile parse from a recorded-style uiautomator dump fixture
//
// The full switch path needs the physical TV (see handoff-python-port-status.md D5).
//
// Run:  server/node_modules/.bin/tsx e2e/adb-unit-test.ts

// env BEFORE importing (env.js reads process.env at import).
process.env.ADB_ENABLED = 'false';
// Manual order override: alias groups so the owner matches by either name.
process.env.ADB_PROFILE_ORDER = JSON.stringify([
  ['sawtaytoes', 'Bob Smith'],
  ['Younger Kids'],
  ['Older Kids'],
  'Demo', // flat string — asGroups must wrap it
]);

const adb = await import('../server/src/adb.js');

let failures = 0;
const ok = (name: string, cond: boolean, extra: unknown = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

// --- asGroups ---------------------------------------------------------------- //
// Every `!` below asserts a group the preceding `.length` check has already established;
// each one erases at compile time, so the emitted assertion is byte-for-byte the original.
console.log('\n=== asGroups ===');
const flat = adb.asGroups(['A', 'B']);
ok('flat list becomes singleton groups', flat.length === 2 && flat[0]![0] === 'A' && flat[1]![0] === 'B');
const mixed = adb.asGroups([['a', 'b'], 'c']);
ok('mixed list keeps groups + wraps strings', mixed[0]!.length === 2 && mixed[1]![0] === 'c');
ok('empty/null → []', adb.asGroups(null).length === 0 && adb.asGroups([]).length === 0);

// --- index / offset / sameProfileInOrder ------------------------------------- //
console.log('\n=== index / offset / sameProfile ===');
const order = adb.asGroups([
  ['sawtaytoes', 'Bob Smith'],
  ['Younger Kids'],
  ['Older Kids'],
  ['Demo'],
]);

ok('indexOfName finds primary alias', adb.indexOfName(order, 'Younger Kids') === 1);
ok('indexOfName finds secondary alias (owner username)', adb.indexOfName(order, 'sawtaytoes') === 0);
ok('indexOfName finds owner display title', adb.indexOfName(order, 'Bob Smith') === 0);
ok('indexOfName unknown → null', adb.indexOfName(order, 'Nobody') === null);

ok(
  'offset rightward is positive',
  adb.offsetBetween(order, 'Younger Kids', 'Older Kids') === 1,
);
ok(
  'offset leftward is negative',
  adb.offsetBetween(order, 'Older Kids', 'Younger Kids') === -1,
);
ok(
  'offset via owner aliases (username → title target path)',
  adb.offsetBetween(order, 'sawtaytoes', 'Older Kids') === 2,
);
ok(
  'offset unknown end → null',
  adb.offsetBetween(order, 'Younger Kids', 'Ghost') === null,
);

ok('sameProfileInOrder equal strings', adb.sameProfileInOrder(order, 'Demo', 'Demo') === true);
ok(
  'sameProfileInOrder aliases of one slot',
  adb.sameProfileInOrder(order, 'sawtaytoes', 'Bob Smith') === true,
);
ok(
  'sameProfileInOrder different slots',
  adb.sameProfileInOrder(order, 'Younger Kids', 'Older Kids') === false,
);
ok('sameProfileInOrder empty/null is false', adb.sameProfileInOrder(order, '', 'Demo') === false);
ok('sameProfileInOrder both null-ish equal', adb.sameProfileInOrder(order, null, null) === true);

// Async sameProfile uses the env-overridden ADB_PROFILE_ORDER.
const sameAsync = await adb.sameProfile('sawtaytoes', 'Bob Smith');
ok('sameProfile (async, env order) resolves owner aliases', sameAsync === true);
const diffAsync = await adb.sameProfile('Younger Kids', 'Older Kids');
ok('sameProfile (async) different slots', diffAsync === false);

const orderLive = await adb.profileOrder();
ok(
  'profileOrder honors ADB_PROFILE_ORDER env (incl. flat string wrap)',
  orderLive.length === 4 &&
    orderLive[0]!.includes('sawtaytoes') &&
    orderLive[0]!.includes('Bob Smith') &&
    orderLive[3]![0] === 'Demo',
  JSON.stringify(orderLive),
);

// --- selectedProfileFromXml (uiautomator fixture) ---------------------------- //
console.log('\n=== selectedProfileFromXml ===');

// Minimal dump shaped like the Shield's PickUserActivity hierarchy: many nodes carry
// selected="true" (it propagates down the tile subtree), but only the title_text
// TextView exposes the NAME. The parser must anchor on resource-id, not selected alone.
const FIXTURE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" selected="false">
    <node index="0" text="" resource-id="" class="android.widget.LinearLayout" selected="false">
      <node index="0" text="" resource-id="com.plexapp.android:id/user_tile" class="android.view.ViewGroup" selected="true">
        <node index="0" text="" resource-id="com.plexapp.android:id/avatar" class="android.widget.ImageView" selected="true" />
        <node index="1" text="Younger Kids" resource-id="com.plexapp.android:id/title_text" class="android.widget.TextView" selected="true" />
      </node>
      <node index="1" text="" resource-id="com.plexapp.android:id/user_tile" class="android.view.ViewGroup" selected="false">
        <node index="0" text="" resource-id="com.plexapp.android:id/avatar" class="android.widget.ImageView" selected="false" />
        <node index="1" text="" resource-id="com.plexapp.android:id/title_text" class="android.widget.TextView" selected="false" />
      </node>
      <node index="2" text="" resource-id="com.plexapp.android:id/user_tile" class="android.view.ViewGroup" selected="false">
        <node index="1" text="Older Kids" resource-id="com.plexapp.android:id/title_text" class="android.widget.TextView" selected="false" />
      </node>
    </node>
  </node>
</hierarchy>
`;

ok(
  'selectedProfileFromXml reads the selected title_text',
  adb.selectedProfileFromXml(FIXTURE) === 'Younger Kids',
);

const ownerFixture = FIXTURE.replace('Younger Kids', 'sawtaytoes');
ok(
  'selectedProfileFromXml returns owner username as shown on tile',
  adb.selectedProfileFromXml(ownerFixture) === 'sawtaytoes',
);

// selected="true" on a non-title node must NOT win.
const decoy = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy>
  <node text="DECOY" resource-id="com.plexapp.android:id/avatar" selected="true" />
  <node text="Real Name" resource-id="com.plexapp.android:id/title_text" selected="true" />
</hierarchy>`;
ok(
  'selectedProfileFromXml ignores selected non-title nodes',
  adb.selectedProfileFromXml(decoy) === 'Real Name',
);

ok(
  'selectedProfileFromXml returns null when no selected title',
  adb.selectedProfileFromXml('<hierarchy><node text="X" resource-id="com.plexapp.android:id/title_text" selected="false" /></hierarchy>') === null,
);

ok(
  'selectedProfileFromXml returns null on empty/garbage',
  adb.selectedProfileFromXml('') === null && adb.selectedProfileFromXml(null) === null,
);

ok(
  'parseUiNodes finds every node tag',
  adb.parseUiNodes(FIXTURE).length >= 8,
);

// --- TITLE_ID constant matches Python ---------------------------------------- //
console.log('\n=== constants ===');
ok(
  'TITLE_ID is the Plex title_text resource-id',
  adb.TITLE_ID === 'com.plexapp.android:id/title_text',
);

// --- public surface smoke (functions exist; no device calls) ----------------- //
// The whole point of this block is a RUNTIME lookup by name — it asserts the module still
// exports each of these — so the namespace is read as a record. A `keyof typeof adb` lookup
// would make the list a compile-time tautology and stop testing anything.
const adbExports = adb as unknown as Record<string, unknown>;
console.log('\n=== exports ===');
for (const name of [
  'connect',
  'foregroundActivity',
  'isAwake',
  'ensurePlexOpen',
  'selectedProfile',
  'pickerReady',
  'profileOrder',
  'sameProfile',
  'summonPicker',
  'waitForPicker',
  'switchTo',
  'restartToPicker',
  'pickerViaMenu',
  'press',
  'run',
  'asGroups',
  'indexOfName',
  'offsetBetween',
  'sameProfileInOrder',
  'selectedProfileFromXml',
  'parseUiNodes',
  '_resetOrderCache',
]) {
  ok(`export ${name}`, typeof adbExports[name] === 'function');
}

// switchTo with ADB_ENABLED=false is a safe no-device call.
const [okSwitch, detail] = await adb.switchTo('Younger Kids');
ok('switchTo short-circuits when ADB_ENABLED is off', okSwitch === false, detail);
ok(
  'switchTo detail mentions ADB_ENABLED',
  String(detail).includes('ADB_ENABLED'),
  String(detail),
);

console.log(failures ? `\n${failures} adb assertion(s) failed` : '\nall adb assertions passed');
process.exit(failures ? 1 : 0);
