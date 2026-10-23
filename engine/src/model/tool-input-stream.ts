// Decode only the provider's tool-argument JSON protocol, never assistant prose.
// These drafts cannot execute tools; execution uses the validated final tool_use.
export const TOOL_INPUT_PREVIEW_LIMIT = 80_000;
export type ToolInputChange = { op: 'set'; path: (string | number)[]; value: unknown }
  | { op: 'append'; path: (string | number)[]; value: string };
type Frame = { value: Record<string, unknown> | unknown[]; path?: (string | number)[]; state: 'key'|'keyAfterComma'|'colon'|'value'|'valueAfterComma'|'comma'; key?: string; index: number };
const safeKey = (key: string | number) => !['__proto__','constructor','prototype'].includes(String(key));
/** Immutable path-copying: unchanged branches retain identity for UI subscriptions. */
export function applyToolInputChanges(input: Record<string, unknown>, changes: readonly ToolInputChange[]): Record<string, unknown> {
  let result=input;
  for(const change of changes){
    if(!change.path.length || change.path.length>20 || change.path.some(key=>!safeKey(key)||(typeof key==='number'&&(!Number.isSafeInteger(key)||key<0||key>80000))))continue;
    const root={...result};let target:Record<string,unknown>|unknown[]=root,source:unknown=result;
    for(let i=0;i<change.path.length;i++){
      const key=change.path[i]!,at=target as Record<string|number,unknown>;
      const before=source&&typeof source==='object'?(source as Record<string|number,unknown>)[key]:undefined;
      if(i===change.path.length-1){at[key]=change.op==='append'?(typeof before==='string'?before:'')+change.value:structuredClone(change.value)}
      else {const child=Array.isArray(before)?[...before]:before&&typeof before==='object'?{...before}:typeof change.path[i+1]==='number'?[]:{};at[key]=child;target=child;source=before}
    }
    result=root;
  }
  return result;
}
export class ToolInputStream {
  private frames: Frame[]=[];
  private root?:Record<string,unknown>;
  private token?:{kind:'string'|'primitive';key:boolean;value:string;escape:boolean;unicode?:string;path?:(string|number)[]};
  private size=0;
  private invalid=false;
  private closed=false;
  private changes:ToolInputChange[]=[];
  truncated=false;
  /** Only newly decoded fields/string suffixes, not a full argument snapshot. */
  append(delta:string):ToolInputChange[]{
    this.changes=[];
    const room=Math.max(0,TOOL_INPUT_PREVIEW_LIMIT-this.size);
    if(delta.length>room)this.truncated=true;
    const chunk=delta.slice(0,room);this.size+=chunk.length;
    for(const c of chunk){if(this.invalid)break;this.consume(c)}
    return this.changes;
  }
  snapshot():Record<string,unknown>{return structuredClone(this.root||{})}
  private emit(change:ToolInputChange):void{
    const previous=this.changes.at(-1);
    if(previous?.op==='append'&&change.op==='append'&&JSON.stringify(previous.path)===JSON.stringify(change.path)){previous.value+=change.value;return}
    this.changes.push(change);
  }
  private path(): (string|number)[]|undefined{
    const f=this.frames.at(-1)!;
    const key=Array.isArray(f.value)?f.index:f.key;
    return f.path && key!==undefined && safeKey(key)?[...f.path,key]:undefined;
  }
  private finish():void{const f=this.frames.at(-1)!;f.state='comma';f.key=undefined;f.index++}
  private write(value:unknown):void{
    const f=this.frames.at(-1)!;
    const key=Array.isArray(f.value)?f.index:f.key;
    const path=this.path();
    if(path&&key!==undefined){(f.value as Record<string|number,unknown>)[key]=value;this.emit({op:'set',path,value:structuredClone(value)})}
  }
  private text(value:string):void{
    const t=this.token!;t.value+=value;
    if(!t.key&&t.path){
      const f=this.frames.at(-1)!;const key=t.path.at(-1)!;
      (f.value as Record<string|number,unknown>)[key]=t.value;
      this.emit({op:'append',path:t.path,value});
    }
  }
  private consume(c:string):void{
    const t=this.token;
    if(t?.kind==='string'){
      if(t.unicode!==undefined){
        if(!/[\da-f]/i.test(c)){this.invalid=true;return}
        t.unicode+=c;
        if(t.unicode.length===4){this.text(String.fromCharCode(parseInt(t.unicode,16)));t.unicode=undefined}
        return;
      }
      if(t.escape){
        t.escape=false;if(c==='u'){t.unicode='';return}
        const escape:Record<string,string>={'"':'"','\\':'\\','/':'/',n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'};
        if(!(c in escape)){this.invalid=true;return}this.text(escape[c]!);return;
      }
      if(c==='\\'){t.escape=true;return}
      if(c==='"'){
        if(t.key){const f=this.frames.at(-1)!;f.key=t.value;f.state='colon'}else this.finish();
        this.token=undefined;return;
      }
      if(c<' '){this.invalid=true;return}this.text(c);return;
    }
    if(t?.kind==='primitive'){
      if(/[\s,}\]]/.test(c)){
        try{this.write(JSON.parse(t.value));this.finish()}catch{this.invalid=true;return}
        this.token=undefined;this.consume(c);return;
      }
      t.value+=c;return;
    }
    if(/\s/.test(c))return;
    if(this.closed){this.invalid=true;return}
    const f=this.frames.at(-1);
    if(!f){if(c!=='{'||this.root){this.invalid=true;return}this.root={};this.frames.push({value:this.root,path:[],state:'key',index:0});return}
    if((c==='}'&&!Array.isArray(f.value)&&['key','comma'].includes(f.state))||(c===']'&&Array.isArray(f.value)&&['value','comma'].includes(f.state))){this.frames.pop();if(!this.frames.length)this.closed=true;return}
    if(f.state==='key'||f.state==='keyAfterComma'){
      if(c!=='"'){this.invalid=true;return}this.token={kind:'string',key:true,value:'',escape:false};return;
    }
    if(f.state==='colon'){if(c!==':'){this.invalid=true;return}f.state='value';return}
    if(f.state==='comma'){if(c!==','){this.invalid=true;return}f.state=Array.isArray(f.value)?'valueAfterComma':'keyAfterComma';return}
    if(c==='{'||c==='['){
      if(this.frames.length>=20){this.invalid=true;return}
      const path=this.path(),value=c==='{'?{}:[];this.write(value);this.finish();
      this.frames.push({value,path,state:c==='{'?'key':'value',index:0});return;
    }
    if(c==='"'){const path=this.path();this.write('');this.token={kind:'string',key:false,value:'',escape:false,path};return}
    if(!/[-\dtfn]/.test(c)){this.invalid=true;return}this.token={kind:'primitive',key:false,value:c,escape:false};
  }
}
