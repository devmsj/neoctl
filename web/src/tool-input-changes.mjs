// Consume structured protocol operations only. No JSON/text interpretation in the page.
export function applyActivityInput(input, changes) {
  let result=input
  for(const change of changes){
    const path=change.path
    if(!['set','append'].includes(change.op)||!Array.isArray(path)||!path.length||path.length>20||path.some(key=>!['string','number'].includes(typeof key)||['__proto__','constructor','prototype'].includes(String(key))||(typeof key==='number'&&(!Number.isSafeInteger(key)||key<0||key>80000))))continue
    const root={...result};let target=root,source=result
    for(let i=0;i<path.length;i++){
      const key=path[i],before=source&&typeof source==='object'?source[key]:undefined
      if(i===path.length-1)target[key]=change.op==='append'?(typeof before==='string'?before:'')+change.value:change.value
      else{const child=Array.isArray(before)?[...before]:before&&typeof before==='object'?{...before}:typeof path[i+1]==='number'?[]:{};target[key]=child;target=child;source=before}
    }
    result=root
  }
  return result
}
