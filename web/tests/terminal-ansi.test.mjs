import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalAnsi, terminalAnsiSegments } from '../src/terminal-ansi.mjs'
const text = spans => spans.map(span => span.text).join('')
test('plain output stays plain including markup-looking content', () => {
 const input='<img src=x onerror=alert(1)>\nerror is just a word\t完成'
 const spans=terminalAnsiSegments(input)
 assert.equal(text(spans),input);assert.deepEqual(spans[0].style,{})
})
test('standard/bright foreground, background and individual/default resets', () => {
 const spans=terminalAnsiSegments('\x1b[31mred\x1b[104mblue background\x1b[39mdefault fg\x1b[49mplain\x1b[92mbright\x1b[0mend')
 assert.equal(spans[0].style.color,'var(--terminal-color-1)')
 assert.equal(spans[1].style.backgroundColor,'var(--terminal-color-12)')
 assert.equal(spans[2].style.color,undefined)
 assert.equal(spans[3].style.backgroundColor,undefined)
 assert.equal(spans[4].style.color,'var(--terminal-color-10)')
 assert.deepEqual(spans[5].style,{})
})
test('256 colors and exact truecolor with semicolon/colon sequences', () => {
 const spans=terminalAnsiSegments('\x1b[38;5;196mA\x1b[48;5;244mB\x1b[38;2;1;22;233mC\x1b[38:2::12:34:56mD\x1b[48:2:0:6:7:8mE')
 assert.equal(spans[0].style.color,'rgb(255, 0, 0)')
 assert.equal(spans[1].style.backgroundColor,'rgb(128, 128, 128)')
 assert.equal(spans[2].style.color,'rgb(1, 22, 233)')
 assert.equal(spans[3].style.color,'rgb(12, 34, 56)')
 assert.equal(spans[4].style.backgroundColor,'rgb(6, 7, 8)')
})
test('text styles and inverse reset without executing blink/conceal',()=>{
 const spans=terminalAnsiSegments('\x1b[1;2;3;4;9;7mstyled\x1b[22;23;24;29;27mplain\x1b[5;8mvisible')
 assert.deepEqual(spans[0].style,{color:'var(--terminal-background)',backgroundColor:'var(--terminal-foreground)',fontWeight:'700',opacity:'.7',fontStyle:'italic',textDecoration:'underline line-through'})
 assert.deepEqual(spans[1].style,{})
 assert.equal(spans[1].text,'plainvisible')
})
test('all split positions decode identically including unfinished OSC and RGB',()=>{
 const input='start\x1b[38;2;4;50;200mcolored\x1b[0m\x1b]8;;https://example.invalid\x1b\\label\x1b]8;;\x1b\\end'
 const expected=terminalAnsiSegments(input)
 for(let i=0;i<=input.length;i++) {const parser=createTerminalAnsi();parser.push(input.slice(0,i));assert.deepEqual(parser.push(input.slice(i)),expected)}
})
test('OSC/DCS controls are dropped and cannot introduce links/HTML/styles',()=>{
 const input='a\x1b]52;c;clipboard\x07b\x1bPprivate payload\x1b\\c\x1b[2Jd\x1b[?25le\x1b[31m<img>\x1b[0m'
 const spans=terminalAnsiSegments(input)
 assert.equal(text(spans),'abcde<img>')
 assert.equal(spans[1].style.color,'var(--terminal-color-1)')
 assert.equal(JSON.stringify(spans).includes('clipboard'),false)
})
test('invalid ranges never become CSS; control storage is bounded',()=>{
 const spans=terminalAnsiSegments('\x1b[38;2;999;-1;44mtext\x1b[38;5;999mplain')
 assert.ok(spans.every(span=>!JSON.stringify(span.style).includes('999')))
 const parser=createTerminalAnsi();parser.push('\x1b['+'1'.repeat(100000));assert.equal(text(parser.push('mhello')),'hello')
})
test('bounded tail preserves style from earlier chunks and avoids low surrogate cut',()=>{
 const parser=createTerminalAnsi({maxChars:5})
 parser.push('\x1b[31m123456789');let spans=parser.push('AB')
 assert.equal(text(spans),'789AB');assert.equal(spans[0].style.color,'var(--terminal-color-1)')
 spans=parser.push('\x1b[0m🙂XYZ');assert.equal(text(spans),'🙂XYZ')
 parser.reset();assert.deepEqual(parser.push('clean')[0].style,{})
})
test('independent stream decoders do not leak stdout color to stderr',()=>{
 const stdout=createTerminalAnsi(),stderr=createTerminalAnsi()
 stdout.push('\x1b[31mred');assert.deepEqual(stderr.push('plain')[0].style,{})
 assert.equal(stdout.push(' more')[0].style.color,'var(--terminal-color-1)')
})
