#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inkPath = path.join(root, 'node_modules', 'ink', 'build', 'ink.js');

const unsafeNeedle = 'ansiEscapes.clearTerminal + this.fullStaticOutput + output';
// Do not use ansiEscapes.clearTerminal here: ansi-escapes implements it as
// ESC[2J ESC[3J ESC[H on modern terminals, and ESC[3J clears the scrollback
// buffer. Ink reaches this branch when dynamic output fills the terminal, which
// makes terminal REPL scrollback look like it was reset to the top.
const safeReplacement = "'\\u001B[2J\\u001B[H' + this.fullStaticOutput + output";

function main() {
  if (!fs.existsSync(inkPath)) {
    console.warn(`[patch-ink-clear-terminal] skip: ${path.relative(root, inkPath)} not found`);
    return;
  }

  const source = fs.readFileSync(inkPath, 'utf8');
  if (source.includes(safeReplacement)) {
    console.log('[patch-ink-clear-terminal] already patched');
    return;
  }
  if (!source.includes(unsafeNeedle)) {
    console.warn('[patch-ink-clear-terminal] skip: expected Ink clearTerminal call not found');
    return;
  }

  const next = source.replace(unsafeNeedle, safeReplacement);
  fs.writeFileSync(inkPath, next);
  console.log('[patch-ink-clear-terminal] patched Ink fullscreen render to preserve terminal scrollback');
}

main();
