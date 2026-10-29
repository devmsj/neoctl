import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyAppearance, normalizeAppearance, normalizeScheme } from '../shared/appearance.mjs'
import { appearanceTokens } from '../src/appearance-tokens.mjs'

test('window material is optional, strictly validated and independent across day/night/presets', () => {
 const c=emptyAppearance();c.light={windowTransparency:38,windowFrost:2};c.dark={windowTransparency:66,windowFrost:2};c.presets=[{name:'glass',light:c.light,dark:c.dark}]
 assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(c))),c)
 for(const bad of [-1,101,NaN,Infinity,'50'])assert.throws(()=>normalizeScheme({windowTransparency:bad}))
 for(const bad of [-1,3,1.5,'1'])assert.throws(()=>normalizeScheme({windowFrost:bad}))
 assert.equal(appearanceTokens(c.dark,'dark')['--appearance-window-transparency'],'66')
 assert.equal(appearanceTokens(c.light,'light')['--appearance-window-frost'],'2')
 assert.equal(appearanceTokens({},'dark')['--appearance-window-transparency'],undefined)
 assert.equal(appearanceTokens(c.dark,'dark')['--appearance-panel'],appearanceTokens({},'dark')['--appearance-panel'])
})

test('CSS drafts and retired light preset migrate to system frosting; transparency stays independent',()=>{
 for(const value of [1,2])assert.deepEqual(normalizeScheme({windowFrost:value}),{windowFrost:2})
 assert.deepEqual(normalizeScheme({windowBlur:0}),{windowFrost:0})
 assert.deepEqual(normalizeScheme({windowBlur:7.5,windowFrost:0}),{windowFrost:0})
 assert.deepEqual(normalizeScheme({windowTransparency:0,windowBlur:17.5}),{windowTransparency:0,windowFrost:2})
 for(const bad of [-1,41,NaN,Infinity,'12'])assert.throws(()=>normalizeScheme({windowBlur:bad}))
 assert.equal(appearanceTokens({windowFrost:2},'dark')['--appearance-window-blur'],undefined)
})
