/**
 * Generate the demo's CSS design tokens from the engine's brand palette, and
 * lint the repo for colour literals that escaped it.
 *
 *   node --experimental-strip-types scripts/gen-tokens.mjs           # write
 *   node --experimental-strip-types scripts/gen-tokens.mjs --check   # verify
 *
 * `--check` is wired into `npm run check`, so a stray hex or a stale token
 * file fails the build rather than quietly drifting.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, CLUSTER_HUES, hexToRgb } from '../packages/orb-engine/src/brand.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'apps/demo/src/styles/tokens.css');
const FAVICON = join(ROOT, 'apps/demo/public/favicon.svg');

/**
 * Typography is app-level, not engine-level: the engine draws no text. The
 * families are self-hosted by `apps/demo/src/styles/fonts.css`; the fallbacks
 * are what the brief asked for (Menlo behind IBM Plex Mono).
 */
const TYPOGRAPHY = {
  'font-display': `'Unbounded', 'Trebuchet MS', system-ui, sans-serif`,
  'font-body': `'Bricolage Grotesque', system-ui, -apple-system, sans-serif`,
  'font-mono': `'IBM Plex Mono', Menlo, 'SF Mono', ui-monospace, monospace`,
};

/** Semantic aliases. UI rules reference these, never a raw brand token. */
const SEMANTIC = {
  bg: 'var(--dw-ink)',
  surface: 'var(--dw-panel)',
  'surface-raised': 'var(--dw-border)',
  hairline: 'var(--dw-border)',
  'text-strong': 'var(--dw-text)',
  'text-muted': 'var(--dw-muted)',
  'text-dim': 'var(--dw-dim)',
  focus: 'var(--dw-accent)',
  /* Repointed from script to the current state's colour. */
  state: 'var(--dw-accent)',
  'state-idle': 'var(--dw-accent)',
  'state-arming': 'var(--dw-listening)',
  'state-listening': 'var(--dw-listening)',
  'state-processing': 'var(--dw-secondary)',
  'state-speaking': 'var(--dw-accent)',
  'state-error': 'var(--dw-error)',
};

function render() {
  const lines = [
    '/*',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * Source of truth: packages/orb-engine/src/brand.ts',
    ' * Regenerate:     npm run tokens',
    ' * Verify:         npm run lint:tokens',
    ' *',
    ' * Every colour in the UI comes from here. The scene is dark-only, so',
    ' * there is one set; the block below is the single place a light set',
    ' * would be added.',
    ' */',
    '',
    ':root {',
    '  color-scheme: dark;',
    '',
    '  /* --- brand palette ------------------------------------------------ */',
  ];

  for (const [name, hex] of Object.entries(BRAND)) {
    const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
    lines.push(`  --dw-${name}: ${hex};`);
    // Bare triples so rules can build translucent variants with rgb(... / a)
    // without hard-coding a second copy of the colour.
    lines.push(`  --dw-${name}-rgb: ${r} ${g} ${b};`);
  }

  lines.push('', '  /* --- cluster hues (one per star cluster) --------------------------- */');
  CLUSTER_HUES.forEach((hex, i) => lines.push(`  --dw-cluster-${i}: ${hex};`));

  lines.push('', '  /* --- semantic aliases --------------------------------------------- */');
  for (const [name, value] of Object.entries(SEMANTIC)) lines.push(`  --dw-${name}: ${value};`);

  lines.push('', '  /* --- typography --------------------------------------------------- */');
  for (const [name, value] of Object.entries(TYPOGRAPHY)) lines.push(`  --dw-${name}: ${value};`);

  lines.push('}', '');
  return lines.join('\n');
}

/**
 * The favicon is generated too, rather than hand-written, so the one colour
 * it needs cannot drift from the palette — and so the demo answers the
 * browser's automatic /favicon.ico request instead of logging a 404.
 */
function renderFavicon() {
  return [
    '<!-- GENERATED FILE - do not edit. Source: packages/orb-engine/src/brand.ts -->',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Jarwick">',
    `  <rect width="32" height="32" rx="7" fill="${BRAND.ink}" />`,
    `  <circle cx="16" cy="16" r="9" fill="none" stroke="${BRAND.accent}" stroke-width="1.6" opacity="0.9" />`,
    `  <ellipse cx="16" cy="16" rx="9" ry="3.4" fill="none" stroke="${BRAND.accent}" stroke-width="1.1" opacity="0.55" />`,
    `  <circle cx="16" cy="16" r="2.6" fill="${BRAND.accent}" />`,
    '</svg>',
    '',
  ].join('\n');
}

// --- stray colour lint -------------------------------------------------------

/** Files allowed to contain colour literals. */
const COLOUR_ALLOWLIST = new Set(
  [
    'packages/orb-engine/src/brand.ts',
    'apps/demo/src/styles/tokens.css',
    'apps/demo/public/favicon.svg',
    // A copy-and-paste starting point for another project, deliberately
    // self-contained rather than wired to this repo's tokens.
    'examples/embed.html',
    'scripts/gen-tokens.mjs',
  ].map((p) => p.split('/').join(sep)),
);

const SCAN_DIRS = [
  'packages/orb-engine/src',
  'packages/voice/src',
  'apps/demo/src',
  'apps/demo/public',
  'examples',
  'scripts',
];
const SCAN_EXT = /\.(ts|tsx|css|mjs|js|html|svg)$/;
// Generated declarations mirror whatever their source says, including the
// palette's own literals. The lint polices authored code.
const SKIP_EXT = /\.d\.ts$/;
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;
const FUNCTIONAL = /\b(?:rgba?|hsla?|oklch|color-mix)\s*\(/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCAN_EXT.test(entry) && !SKIP_EXT.test(entry)) yield full;
  }
}

function lintColours() {
  const offences = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (COLOUR_ALLOWLIST.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // Functional notation built from a custom property is the sanctioned
        // way to make a translucent or mixed variant: rgb(var(--dw-x-rgb) / a)
        // and color-mix(in srgb, var(--chip) 12%, transparent) both ultimately
        // resolve to a palette token. A literal with no var() does not.
        const usesToken = line.includes('var(--');
        for (const m of line.matchAll(HEX)) {
          offences.push(`${rel}:${i + 1}  colour literal ${m[0]}`);
        }
        if (!usesToken) {
          for (const m of line.matchAll(FUNCTIONAL)) {
            offences.push(`${rel}:${i + 1}  colour function ${m[0].trim()} not built from a token`);
          }
        }
      });
    }
  }
  return offences;
}

// --- main --------------------------------------------------------------------

const check = process.argv.includes('--check');
const artefacts = [
  { path: OUT, content: render() },
  { path: FAVICON, content: renderFavicon() },
];
let failed = false;

for (const { path, content } of artefacts) {
  const rel = relative(ROOT, path);
  if (check) {
    let existing = null;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      /* missing counts as drift */
    }
    if (existing !== content) {
      console.error(`✗ ${rel} is out of date. Run: npm run tokens`);
      failed = true;
    } else {
      console.log(`✓ ${rel} matches brand.ts`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`✓ wrote ${rel}`);
  }
}

const offences = lintColours();
if (offences.length > 0) {
  console.error(`✗ ${offences.length} colour literal(s) outside the palette:`);
  for (const o of offences) console.error(`    ${o}`);
  console.error('  Add the colour to packages/orb-engine/src/brand.ts and use a token instead.');
  failed = true;
} else {
  console.log('✓ no colour literals outside the palette');
}

if (failed) process.exit(1);
