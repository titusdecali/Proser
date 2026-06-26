/* Fixture test for the shared passive-voice heuristic in
 * src/features/spellcheck/passiveRegex.ts. Transpiles the real source (so it tests
 * exactly what ships) and asserts the pre-filter detects real passives, skips
 * predicate adjectives / progressives, and that passiveHits() powers the
 * "suggestion must remove passive" guard. Run: node scripts/_passive_regex_test.cjs */
const fs = require('fs');
const esbuild = require('esbuild');

const src = fs.readFileSync('src/features/spellcheck/passiveRegex.ts', 'utf8');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { PASSIVE_RE, passiveHits } = mod.exports;

const hit = (s) => {
  PASSIVE_RE.lastIndex = 0;
  return PASSIVE_RE.test(s);
};

let fails = 0;
const check = (label, got, want, note) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}=${got} want=${want}  ${note}`);
};

console.log('--- DETECT: real passives must be candidates (true) ---');
[
  'The ball was thrown by the boy.',
  'The letter was written by Marcus in a trembling hand.',
  'The bridge had been built centuries before anyone could remember.',
  'Mistakes were made by the committee.',
  'The window had been broken.',
  'She was raised by her grandmother.',
  // newly added irregulars
  'He was shot by the sniper.',
  'The picture was hung on the wall.',
  'The bells were rung at noon.',
  'She was stung by a bee.',
  'The news was spread quickly.',
  'The veto was overridden by the senate.',
  'The seeds were sown in spring.',
  'He was bitten by the dog.',
  'The vase was sunk in the lake.',
  'The role was cast months ago.'
].forEach((s) => check('detect', hit(s), true, s));

console.log('\n--- SKIP: predicate adjectives / progressives must NOT be candidates (false) ---');
[
  'She was tired.',
  'He was excited about the trip.',
  'They were worried.',
  'The crowd was bored.',
  'He was drunk.', // deliberately omitted from the list
  'I was stuck in traffic.', // deliberately omitted
  'The room was lit.', // deliberately omitted (adjectival)
  'The door was shut.', // deliberately omitted (adjectival)
  'He is running through the rain.',
  'They are leaving tomorrow.',
  'The boy threw the ball.',
  'Rain fell on the quiet street.'
].forEach((s) => check('detect', hit(s), false, s));

console.log('\n--- GUARD: passiveHits(fix) < passiveHits(orig) keeps a finding ---');
[
  ['The ball was thrown by the boy.', 'The boy threw the ball.', true],
  ['The letter was written by Marcus.', 'Marcus wrote the letter.', true],
  ['He was shot by the sniper.', 'The sniper shot him.', true],
  ['The ball was thrown by the boy.', 'The ball was thrown.', false], // still passive → drop
  ['Mistakes were made.', 'Mistakes were made by us.', false] // still passive → drop
].forEach(([orig, fix, want]) =>
  check('keep', passiveHits(fix) < passiveHits(orig), want, `"${fix}" (orig ${passiveHits(orig)} / fix ${passiveHits(fix)})`)
);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails === 0 ? 0 : 1);
