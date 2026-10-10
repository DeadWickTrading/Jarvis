/**
 * Everything, in one file, for a page with no build step.
 *
 * The normal packages leave three.js external so a host app that already uses
 * three does not end up with two copies of it. A plain HTML page has no
 * bundler to resolve that for it, so this entry inlines everything — three,
 * the engine, the voice layer — into a single ES module that a `<script
 * type="module">` can import directly.
 *
 * Use the packages instead if the host has a bundler. This exists for
 * dropping the orb into an existing page.
 */
export * from '@deadwick/orb-engine';
export * from './index.js';
