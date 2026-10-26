import test from 'node:test'
import assert from 'node:assert/strict'
import { createObservationIdle } from '../src/observation-idle.mjs'
test('five seconds starts only at bottom; updates reset, identical checks do not; updates revive',()=>{
 let bottom=false,now=0,next=0;const timers=new Map(),changes=[]
 const idle=createObservationIdle({atBottom:()=>bottom,onHidden:v=>changes.push(v),setTimer:(f,ms)=>{timers.set(++next,{f,at:now+ms});return next},clearTimer:id=>timers.delete(id)})
 const tick=ms=>{now+=ms;for(const [id,t]of [...timers])if(t.at<=now){timers.delete(id);t.f()}}
 idle.changed();tick(6000);assert.deepEqual(changes,[])
 bottom=true;idle.check();tick(4000);idle.check();tick(999);assert.deepEqual(changes,[]);tick(1);assert.deepEqual(changes,[true])
 idle.changed();assert.deepEqual(changes,[true,false]);tick(4000);idle.changed();tick(4000);assert.equal(changes.length,2)
 bottom=false;idle.check();tick(6000);assert.equal(changes.length,2)
 bottom=true;idle.check();idle.dispose();tick(6000);assert.equal(changes.length,2)
})
