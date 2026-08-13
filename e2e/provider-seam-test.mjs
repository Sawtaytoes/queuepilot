// Offline gate for the PROVIDER CONFIG + BLOCK STORAGE layer.
//
// What it guards, in one line each:
//   * an unset token FAILS LOUDLY and by name — never '', never an unauthenticated request.
//     Two production outages came from a placeholder that looked like config, and both
//     looked identical from the couch: the card opened Plex and nothing played.
//   * env BEATS the secrets file, so a deploy-time override still wins over a UI-set token.
//   * the secrets file is written 0600 and holds NOTHING but id -> token.
//   * a token NEVER appears in any public/API view — not even masked.
//   * blocks are a LIST from day one, and a pre-blocks set reads as ONE implicit Plex block
//     without being migrated on read or rewritten on disk.
//   * a MIXED set THROWS rather than guessing which provider hands off. That question is
//     the owner's open decision; a passing test here would mean someone answered it silently.
//
// Runs with no token, no network and no /config: every path is redirected into a scratch dir
// BEFORE any server module is imported, because env.js snapshots these at module-eval.
//
// Run:  node e2e/provider-seam-test.mjs   (from the repo root; non-zero on failure)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'providers-'));
process.env.PROVIDERS_PATH = path.join(SCRATCH, 'providers.yaml');
process.env.PROVIDERS_SECRETS_PATH = path.join(SCRATCH, 'providers.secrets.yaml');
process.env.KAVITA_API_SERVER_URL = 'https://kavita.invalid';
// Deliberately NOT set: KAVITA_API_KEY. The unconfigured path is the first thing under test.
delete process.env.KAVITA_API_KEY;
delete process.env.PROVIDER_TOKEN_KAVITA;

writeFileSync(
  process.env.PROVIDERS_PATH,
  'providers:\n'
  + '  - id: kavita\n    kind: kavita\n    label: Kavita\n    base_url: https://kavita.invalid\n'
  + '  - id: weird\n    kind: nosuchbackend\n    label: Weird\n',
);

const FAILS = [];
function ok(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${e.message}`);
    FAILS.push(name);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${e.message}`);
    FAILS.push(name);
  }
}

const config = await import('../server/src/providers/config.js');
const blocks = await import('../server/src/providers/blocks.js');
const { providerFor } = await import('../server/src/providers/index.js');

// --------------------------------------------------------------------------- //
// Fail loudly: an unset token is an ERROR, not a default
// --------------------------------------------------------------------------- //
ok('unconfigured provider reports NOT CONFIGURED', () => {
  assert.equal(config.isConfigured('kavita', 'kavita'), false);
});

ok('an unset token resolves to null, NEVER an empty string', () => {
  const { token } = config.tokenFor('kavita', 'kavita');
  assert.equal(token, null);
  assert.notEqual(token, '');
});

ok('requireToken throws, names the provider AND how to fix it', () => {
  assert.throws(() => config.requireToken('kavita', 'kavita'), (e) => {
    assert.match(e.message, /NOT CONFIGURED/);
    assert.match(e.message, /kavita/);
    // Actionable: it must say which env var, and which file.
    assert.match(e.message, /KAVITA_API_KEY/);
    assert.match(e.message, /providers\.secrets\.yaml/);
    return true;
  });
});

ok('instantiating an unconfigured provider throws rather than half-working', () => {
  assert.throws(() => providerFor('kavita'), /NOT CONFIGURED/);
});

ok('an unsupported kind is refused by name, not silently ignored', () => {
  assert.throws(() => providerFor('weird'), /unsupported kind 'nosuchbackend'/);
});

ok('an unknown provider id is refused', () => {
  assert.throws(() => providerFor('nope'), /unknown provider/);
});

// --------------------------------------------------------------------------- //
// The secrets file
// --------------------------------------------------------------------------- //
await okAsync('writeSecret creates the file 0600', async () => {
  await config.writeSecret('kavita', 's3cret-value');
  const mode = statSync(process.env.PROVIDERS_SECRETS_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `mode was 0${mode.toString(8)}`);
});

ok('the secrets file holds NOTHING but id -> token', () => {
  const text = readFileSync(process.env.PROVIDERS_SECRETS_PATH, 'utf8');
  // No base_url, no label, no kind — those live in the plaintext definitions file, which is
  // what lets the definitions be diffed, screenshotted and backed up freely.
  assert.doesNotMatch(text, /base_url|label|kind/);
  assert.match(text, /kavita:/);
});

ok('the token is then readable through the resolution order', () => {
  assert.equal(config.tokenFor('kavita', 'kavita').source, 'file');
  assert.equal(config.tokenFor('kavita', 'kavita').token, 's3cret-value');
  assert.equal(config.isConfigured('kavita', 'kavita'), true);
});

ok('env BEATS the secrets file', () => {
  process.env.KAVITA_API_KEY = 'from-env';
  const r = config.tokenFor('kavita', 'kavita');
  assert.equal(r.token, 'from-env');
  assert.equal(r.source, 'env:KAVITA_API_KEY');
  delete process.env.KAVITA_API_KEY;
});

ok('a generic PROVIDER_TOKEN_<ID> works for a runtime-added provider', () => {
  process.env.PROVIDER_TOKEN_KAVITA = 'generic-env';
  assert.equal(config.tokenFor('kavita', 'kavita').token, 'generic-env');
  delete process.env.PROVIDER_TOKEN_KAVITA;
});

// --------------------------------------------------------------------------- //
// A token must never leave the process
// --------------------------------------------------------------------------- //
ok('the public view exposes `configured` as a BOOLEAN and no token at all', () => {
  const view = config.publicList().find((p) => p.id === 'kavita');
  assert.equal(view.configured, true);
  const serialized = JSON.stringify(config.publicList());
  // Not the value, and not a masked prefix either — a masked token is still a leak when the
  // secret is short.
  assert.doesNotMatch(serialized, /s3cret/);
  assert.doesNotMatch(serialized, /token/i);
});

ok('the secrets file is NOT one of the history-managed config files', async () => {
  // The undo/redo stack mirrors to .history.json beside queues.yaml. A credential copied
  // into an undo stack has escaped its file, so the secrets path must never be adjacent to
  // that machinery under the same name.
  const { HISTORY_PATH } = await import('../server/src/config.js');
  assert.notEqual(HISTORY_PATH, process.env.PROVIDERS_SECRETS_PATH);
  assert.equal(existsSync(`${process.env.PROVIDERS_SECRETS_PATH}.bak`), false);
});

// --------------------------------------------------------------------------- //
// Block storage — a LIST from day one
// --------------------------------------------------------------------------- //
ok('a pre-blocks set reads as exactly ONE implicit Plex block', () => {
  const cfg = { source: 'queue', sections: [5, 15], requires_profile: 'Younger Kids' };
  const b = blocks.blocksForSet(cfg);
  assert.equal(b.length, 1);
  assert.equal(b[0].provider, 'plex');
  assert.equal(b[0].profile, 'Younger Kids');
  assert.deepEqual(b[0].libraries, ['5', '15']);
  assert.equal(b[0].implicit, true);
});

ok('reading a legacy set does NOT mutate it — no migration on read', () => {
  const cfg = { source: 'queue', sections: [5] };
  const before = JSON.stringify(cfg);
  blocks.blocksForSet(cfg);
  assert.equal(JSON.stringify(cfg), before);
  assert.equal('providers' in cfg, false);
});

ok('an explicit single block round-trips', () => {
  const cfg = { providers: [{ provider: 'kavita', profile: 'Sawtaytoes', libraries: [5, 2] }] };
  const b = blocks.blocksForSet(cfg);
  assert.equal(b.length, 1);
  assert.equal(b[0].provider, 'kavita');
  assert.deepEqual(b[0].libraries, ['5', '2']);
  assert.equal(blocks.providerIdForSet(cfg), 'kavita');
});

ok('N blocks are stored faithfully — the whole block repeats', () => {
  const cfg = {
    providers: [
      { provider: 'plex', profile: 'Younger Kids', libraries: [5] },
      { provider: 'kavita', profile: 'Sawtaytoes', libraries: [5, 2] },
      { provider: 'plex', profile: 'Older Kids', libraries: [15] },
    ],
  };
  const b = blocks.blocksForSet(cfg);
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.provider), ['plex', 'kavita', 'plex']);
  // Each block carries its OWN profile: the profile field is provider-scoped, and means a
  // different thing per provider (a Plex Home profile vs which Kavita user owns the list).
  assert.deepEqual(b.map((x) => x.profile), ['Younger Kids', 'Sawtaytoes', 'Older Kids']);
});

ok('library ids stay bare — provider identity is NEVER encoded into them', () => {
  const cfg = { providers: [{ provider: 'kavita', libraries: [5, 2] }] };
  const b = blocks.blocksForSet(cfg);
  for (const id of b[0].libraries) {
    assert.doesNotMatch(id, /:/, `library id '${id}' carries a provider prefix`);
  }
});

ok('a MIXED set is detected', () => {
  const cfg = {
    providers: [{ provider: 'plex', libraries: [5] }, { provider: 'kavita', libraries: [2] }],
  };
  assert.equal(blocks.isMixed(cfg), true);
});

ok('a mixed set THROWS rather than silently picking a provider', () => {
  // If this test ever starts passing by returning a provider, someone answered the owner's
  // open question in code. What a mixed queue hands off — a push target or a pull URL — is
  // his decision, not the implementation's.
  const cfg = {
    providers: [{ provider: 'plex', libraries: [5] }, { provider: 'kavita', libraries: [2] }],
  };
  assert.throws(() => blocks.providerIdForSet(cfg), /open decision/);
});

ok('N blocks on ONE provider is not mixed and resolves fine', () => {
  const cfg = {
    providers: [
      { provider: 'plex', profile: 'A', libraries: [5] },
      { provider: 'plex', profile: 'B', libraries: [15] },
    ],
  };
  assert.equal(blocks.isMixed(cfg), false);
  assert.equal(blocks.providerIdForSet(cfg), 'plex');
});

ok('validateBlocks rejects an unknown provider by name', () => {
  const r = blocks.validateBlocks([{ provider: 'ghost', libraries: [1] }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unknown provider 'ghost'/);
});

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nprovider seam OK');
process.exit(FAILS.length ? 1 : 0);
