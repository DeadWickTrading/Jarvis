#!/usr/bin/env node
/**
 * Finish what Vite deliberately leaves undone.
 *
 * For any build where `build.lib` and the output format is `es`, Vite hard-
 * codes `minifyWhitespace: false` no matter what `build.minify` says — see
 * `resolveEsbuildTranspileOptions` in its own source. Identifiers and syntax
 * are still minified; only whitespace survives. That choice makes sense for
 * a library meant to be handed to another bundler, which will minify it
 * again itself. It does not make sense here: this file is the final
 * artifact, served straight to a browser with nothing downstream. Left as
 * Vite produces it, jarwick.standalone.js was 23,410 lines and 918KB for code
 * that compacts to under 400KB.
 *
 * This runs esbuild directly on Vite's already-correct output — module
 * structure and tree-shaking are already done — and asks it to do the one
 * thing Vite withheld. `format: 'esm'` keeps the export statement intact.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';

const file = resolve(process.argv[2] ?? '');
if (!file) {
  console.error('usage: node compress-standalone.mjs <path-to-es-module-bundle.js>');
  process.exit(1);
}

const before = statSync(file).size;
const source = readFileSync(file, 'utf8');

const result = await esbuild.transform(source, {
  loader: 'js',
  format: 'esm',
  minifyWhitespace: true,
  // Already done by Vite; redoing them is harmless but wasted work.
  minifyIdentifiers: false,
  minifySyntax: false,
  target: 'es2022',
});

writeFileSync(file, result.code);
const after = statSync(file).size;

console.log(
  `${file}: ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB ` +
    `(${Math.round((1 - after / before) * 100)}% smaller)`,
);
