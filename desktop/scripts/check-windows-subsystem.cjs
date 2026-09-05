// Inspect the artifact without launching it or affecting an installed instance.
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[2] || path.join(__dirname, '../src-tauri/target/release/neoctl-desktop.exe');
const data = fs.readFileSync(file);
if (data.toString('ascii', 0, 2) !== 'MZ') throw Error('Not a Windows executable');
const pe = data.readUInt32LE(0x3c);
if (data.readUInt32LE(pe) !== 0x4550) throw Error('Invalid PE signature');
const optionalHeader = pe + 24;
const subsystem = data.readUInt16LE(optionalHeader + 68);
if (subsystem !== 2) throw Error(`Expected Windows GUI subsystem 2, got ${subsystem} (3 = console)`);
console.log('PASS: Windows GUI subsystem (2); main executable does not allocate a console.');
