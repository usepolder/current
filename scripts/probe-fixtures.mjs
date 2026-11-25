#!/usr/bin/env node
/**
 * Runs the preview probes against real HTML in a real browser.
 *
 * Why this is a script and not a test. Every test in this repo injects a fake
 * prober, deliberately — `npm test` must not download a browser, and CI runs
 * `npm ci && npm test` on a runner with no browser binary. But the probe
 * checks are the only ones whose correctness lives outside TypeScript: their
 * findings depend on what Chromium builds and, for CO4, on what a third-party
 * screen reader says about it. Nothing that can be mocked tells you whether
 * those answers are right.
 *
 * It is not decoration. Two real bugs in CO4 were caught here and by nothing
 * else:
 *
 *   - A control whose accessible name happens to be a role word — a button
 *     labelled "Menu", "Search" or "Link" — was reported as having NO name,
 *     because the first attempt identified the spoken role by testing the
 *     announcement's first segment against a list of ARIA roles, and the name
 *     segment was itself a role word. A confident No on a correct component.
 *   - A hand-written list of state words had "collapsed" in it. The reader
 *     says "not expanded". Every correctly built disclosure button reported
 *     its state as missing.
 *
 * Both looked right in review and both were wrong. Run this after touching
 * anything under the probe path:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   npm run build && node scripts/probe-fixtures.mjs
 *
 * Every page is served with `script-src 'self'`, because a deployed Storybook
 * sends a Content-Security-Policy and the screen reader has to be injected
 * through a route that CSP does not govern. A regression there would make CO4
 * report N/A on every real preview while passing every local test.
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../packages/core/lib/index.js');

/**
 * [label, body, expected answer]
 *
 * The expectations are not guesses. Each was read off the probe's own output
 * first, and the surprising ones carry the reason.
 */
const SCREEN_READER_CASES = [
  // --- the clean read: never Yes, always N/A ---
  [
    'named controls',
    '<button>Save changes</button><a href="#x">Docs</a>' +
      '<input type="checkbox" id="c"><label for="c">Subscribe</label>' +
      '<div role="switch" tabindex="0" aria-checked="false">Dark mode</div>',
    'N/A',
  ],
  // Regression: the name is a role word on all three.
  ['name IS a role word', '<button>Menu</button><button>Search</button><button>Link</button>', 'N/A'],

  // --- unnamed: announced as a bare role ---
  [
    'unnamed icon button',
    '<button>Save</button>' +
      '<button><svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg></button>',
    'No',
  ],

  // --- unroled: announced as its text, so it sounds like a paragraph ---
  ['focusable div', '<div tabindex="0" onclick="void 0">Click me</div>', 'No'],
  ['div named a role word', '<div tabindex="0" onclick="void 0">Menu</div>', 'No'],

  // --- a declared state the reader drops, because the role cannot carry it ---
  ['link + aria-pressed', '<a href="#" aria-pressed="true">More</a>', 'No'],
  ['button + aria-checked', '<div role="button" tabindex="0" aria-checked="true">Toggle</div>', 'No'],
  [
    'heading + aria-expanded',
    '<div role="heading" aria-level="2" tabindex="0" aria-expanded="false">Title</div>',
    'No',
  ],

  // --- states that DO reach the user, so there is nothing to report ---
  // The reader supplies a stateful role's implicit default, which is why the
  // state clause keys off declared attributes and not off the role.
  ['button + aria-expanded', '<button aria-expanded="false">Menu</button>', 'N/A'],
  ['switch, no aria-checked', '<div role="switch" tabindex="0">Dark mode</div>', 'N/A'],
  ['tab, no aria-selected', '<div role="tab" tabindex="0">Overview</div>', 'N/A'],

  // combobox is not a name-from-content role, so its text is not its name.
  ['combobox bare', '<div role="combobox" tabindex="0">Pick</div>', 'No'],

  // --- reported, not scored ---
  [
    'aria-hidden control',
    '<button>Save</button><div role="button" tabindex="0" aria-hidden="true">Close</div>',
    'N/A',
  ],
  ['nothing interactive', '<p>Just text.</p>', 'N/A'],
];

/**
 * [label, body, expected CO10 answer]
 *
 * These run at 400px, narrow enough that a fixed-width box is under real
 * pressure, and every body is styled inline so the fixture is readable next
 * to its expectation.
 *
 * Two of them exist because the first draft got them wrong. "already spilling"
 * and "already clipped" are broken BEFORE the text is touched, and without
 * the baseline diff both were reported as CO10 failures — charging this norm
 * for breakage it did not cause.
 */
const EXPANSION_CASES = [
  // --- holds under expansion ---
  ['fluid button', '<button style="padding:8px 16px;font:14px sans-serif">Save changes</button>', 'Yes'],
  [
    'wrapping div',
    '<div style="width:90px;font:14px sans-serif;border:1px solid">Save changes</div>',
    'Yes',
  ],

  // --- a declared limit IS CO10 being satisfied, not failed ---
  [
    'ellipsis declared',
    '<div style="width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:14px sans-serif">Save changes</div>',
    'Yes',
  ],
  [
    'max-width declared',
    '<div style="max-width:90px;overflow:hidden;white-space:nowrap;font:14px sans-serif">Save changes</div>',
    'Yes',
  ],
  [
    'line clamp declared',
    '<div style="width:90px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font:14px sans-serif">Save the changes now</div>',
    'Yes',
  ],
  // overflow: auto is the author saying the content may exceed the box.
  [
    'scrollable',
    '<div style="width:90px;overflow:auto;white-space:nowrap;font:14px sans-serif">Save changes</div>',
    'Yes',
  ],

  // --- spills out of its container ---
  [
    'nowrap, overflow visible',
    '<div style="width:90px;white-space:nowrap;font:14px sans-serif;border:1px solid">Save changes</div>',
    'No',
  ],

  // --- cut off with nothing declaring it may be ---
  [
    'hidden, no ellipsis',
    '<div style="width:90px;overflow:hidden;white-space:nowrap;font:14px sans-serif">Save changes</div>',
    'No',
  ],

  // --- pushes the viewport sideways ---
  [
    'viewport overflow',
    '<div style="white-space:nowrap;font:14px sans-serif;width:max-content">Save the changes now please Save the changes now please </div>',
    'No',
  ],

  // --- regression: breakage that pre-dates the expansion is not CO10's ---
  [
    'already spilling',
    '<div style="display:flex;width:120px;border:1px solid"><span style="flex:0 0 auto;white-space:nowrap;font:14px sans-serif">Save changes</span><span style="flex:0 0 auto;white-space:nowrap;font:14px sans-serif">Cancel</span></div>',
    'Yes',
  ],
  [
    'already clipped',
    '<button style="height:18px;overflow:hidden;width:200px;font:14px sans-serif">Save changes now and later too</button>',
    'Yes',
  ],

  // --- nothing to stress ---
  ['no text at all', '<div style="width:40px;height:40px;background:#ccc"></div>', 'N/A'],
];

/**
 * [label, body, expected CO13 answer]
 *
 * Every expectation was read off the engine's own reason codes first. The
 * three `potential_*` cases are the reason this norm is worth having: the
 * engine declines to commit where the effective background is not
 * determinable, rather than guessing, and a guess on contrast would be wrong
 * in one direction or the other.
 */
const CONTRAST_CASES = [
  [
    'passing contrast',
    '<p style="color:#111;background:#fff;font:16px sans-serif">Readable text here</p>',
    'Yes',
  ],
  [
    'failing contrast',
    '<p style="color:#bbb;background:#fff;font:16px sans-serif">Faint text here</p>',
    'No',
  ],
  // The AA threshold is lower for large text, and the engine knows it: this
  // grey fails at 16px and passes at bold 24px.
  [
    'large text clears a lower bar',
    '<p style="color:#949494;background:#fff;font:bold 24px sans-serif">Big text</p>',
    'Yes',
  ],
  [
    'small text fails the same grey',
    '<p style="color:#949494;background:#fff;font:16px sans-serif">Small text</p>',
    'No',
  ],
  [
    'failing button label',
    '<button style="color:#ccc;background:#fff;font:14px sans-serif;border:1px solid #eee">Save</button>',
    'No',
  ],

  // --- the engine will not commit, so neither does the norm ---
  [
    'same colour both ways',
    '<p style="color:#fff;background:#fff;font:16px sans-serif">Invisible</p>',
    'N/A',
  ],
  [
    'text over an image',
    '<p style="color:#888;background:url(data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=);font:16px sans-serif">On an image</p>',
    'N/A',
  ],
  [
    'text with a shadow',
    '<p style="color:#999;background:#fff;text-shadow:0 0 2px #000;font:16px sans-serif">Shadowed</p>',
    'N/A',
  ],
  // A real failure outranks an unmeasurable element: the No is a finding and
  // the N/A is an absence of one.
  [
    'one failing, one unmeasurable',
    '<p style="color:#bbb;background:#fff;font:16px sans-serif">Faint</p>' +
      '<p style="color:#999;background:#fff;text-shadow:0 0 2px #000;font:16px sans-serif">Shadowed</p>',
    'No',
  ],

  ['no text at all', '<div style="width:40px;height:40px;background:#ccc"></div>', 'N/A'],
];

const SUITES = [
  { name: 'CO4  code.screenreader', check: 'code.screenreader', cases: SCREEN_READER_CASES, width: 1280 },
  { name: 'CO10 code.text-expansion', check: 'code.text-expansion', cases: EXPANSION_CASES, width: 400 },
  { name: 'CO13 code.contrast', check: 'code.contrast', cases: CONTRAST_CASES, width: 800 },
];

/** Every case across every suite, so one server can serve them all. */
const ALL = SUITES.flatMap((s) => s.cases.map((c) => ({ suite: s, case: c })));

const server = http.createServer((req, res) => {
  const i = Number(req.url.slice(1));
  const body = ALL[i] === undefined ? '<p>404</p>' : ALL[i].case[1];
  res.writeHead(200, {
    // `script-src 'self'` is the point: CO4 injects a screen reader into the
    // page, and a deployed Storybook sends a policy like this one, so the
    // injection has to survive it. `style-src` has to allow inline styles or
    // the fixtures below are served unstyled — which is not a hypothetical:
    // it silently broke three CO10 fixtures, every one of which reported a
    // clean Yes because its `width` never applied. Real design systems need
    // inline styles too, for the same reason every CSS-in-JS library does.
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><html><head><title>fixture</title></head>` +
      `<body style="margin:0">${body}</body></html>`,
  );
});

const verbose = process.argv.includes('--verbose');

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const prober = core.createPlaywrightProber({
  logger: { trace: (m) => verbose && console.log(`      trace: ${m}`) },
});

let failed = 0;
let suiteStart = 0;
for (const suite of SUITES) {
  console.log(`\n${suite.name}`);
  const check = core.LIVE_CHECKS[suite.check];
  for (let j = 0; j < suite.cases.length; j++) {
    const [label, , want] = suite.cases[j];
    const probe = await prober(`${base}/${suiteStart + j}`, [suite.width]);
    const result = check({ componentName: 'Fixture', probe, absence: null });
    const ok = result.answer === want;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'pass' : 'FAIL'}  ${label.padEnd(26)} ${result.answer.padEnd(4)} (want ${want})`,
    );
    if (!ok || verbose) {
      console.log(`        ${result.evidence}`);
      for (const s of probe.screenReader?.stops ?? []) {
        console.log(
          `          phrase=${JSON.stringify(s.phrase)} role=${s.spokenRole} ` +
            `name=${JSON.stringify(s.name)} state=${s.spokenState} expects=${s.expectsState}`,
        );
      }
      for (const s of probe.screenReader?.silent ?? []) console.log(`          silent: ${s}`);
      for (const f of probe.contrast?.findings ?? []) {
        console.log(
          `          <${f.tag}> resolved=${f.resolved} passes=${f.passes} ${f.message}`,
        );
      }
      for (const e of probe.expansion ?? []) {
        console.log(
          `          ${e.width}px nodes=${e.textNodes} chars=${e.chars} vp=${e.viewportOverflow}` +
            ` by=${e.overflowBy} clipped=${JSON.stringify(e.clipped)}` +
            ` spilling=${JSON.stringify(e.spilling)}`,
        );
      }
    }
  }
  suiteStart += suite.cases.length;
}

await core.closeProber(prober);
server.close();

console.log(failed === 0 ? `\nall ${ALL.length} fixtures pass` : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
