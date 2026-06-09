#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inkPath = path.join(root, 'node_modules', 'ink', 'build', 'ink.js');

const unsafePatterns = [
  // Ink 6.8.0 upstream shape.
  /ansiEscapes\.clearTerminal \+ this\.fullStaticOutput \+ output/g,
  /ansiEscapes\.clearTerminal \+ output/g,
  // Previously patched installs may already avoid ESC[3J.
  /'\\u001B\[2J\\u001B\[H' \+ this\.fullStaticOutput \+ output/g,
];
// Do not use ansiEscapes.clearTerminal here: ansi-escapes implements it as
// ESC[2J ESC[3J ESC[H on modern terminals, and ESC[3J clears the scrollback
// buffer. Ink reaches this branch when dynamic output fills the terminal.
// Only redraw the dynamic frame in fullscreen mode. Replaying fullStaticOutput
// here duplicates scrollback/static history on every animation tick, which is
// especially visible while subagent status panels are refreshing.
const safeReplacement = "'\\u001B[2J\\u001B[H' + output";

function fail(message) {
  console.error(`[patch-ink-clear-terminal] error: ${message}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(inkPath)) {
    fail(`${path.relative(root, inkPath)} not found`);
  }

  const source = fs.readFileSync(inkPath, 'utf8');
  if (source.includes(safeReplacement)) {
    console.log('[patch-ink-clear-terminal] already patched');
    return;
  }

  let next = source;
  for (const pattern of unsafePatterns) {
    next = next.replace(pattern, safeReplacement);
  }
  if (next === source) {
    fail('expected Ink fullscreen clear call not found');
  }

  fs.writeFileSync(inkPath, next);
  console.log('[patch-ink-clear-terminal] patched Ink fullscreen render to preserve terminal scrollback');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
