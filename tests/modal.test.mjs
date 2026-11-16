/** 异步确认/输入弹窗：用最小 DOM 桩验证提交、取消与清理。 */
import assert from 'node:assert/strict';
class El {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.className='';this.textContent='';this.value='';this.open=false;this.form=null;}
  append(...c){c.forEach(x=>{if(x instanceof El){x.parent=this;this.children.push(x)}});}
  addEventListener(t,f){(this.listeners[t] ||= []).push(f);}
  emit(t,e={}){(this.listeners[t]||[]).forEach(f=>f({target:this,...e}));}
  showModal(){this.open=true;} close(){this.open=false;this.emit('close');}
  remove(){this.removed=true;} focus(){} select(){}
  closest(){let n=this;while(n&&n.tag!=='dialog')n=n.parent;return n;}
  requestSubmit(){this.emit('submit');}
}
globalThis.document={createElement:t=>new El(t),body:new El('body'),getElementById(){return new El('x')}};
const { askConfirm, askInput } = await import('../public/js/ui/modal.js');
const find=(n,pred)=>{if(pred(n))return n;for(const c of n.children){const r=find(c,pred);if(r)return r}};
const dlg=()=>document.body.children.at(-1);
// confirm: submit => true
let p=askConfirm({message:'x'}); let d=dlg(); assert.ok(d.open);
let form=d.children[0]; form.emit('submit'); d.close(); assert.equal(await p,true); assert.ok(d.removed);
// confirm: close without submit => false
p=askConfirm({}); d=dlg(); d.close(); assert.equal(await p,false);
// input: submit returns value; cancel returns null
p=askInput({defaultValue:'a/b'}); d=dlg(); const field=find(d,n=>n.tag==='input'); assert.equal(field.value,'a/b'); field.value='new'; d.children[0].emit('submit'); d.close(); assert.equal(await p,'new');
p=askInput({}); d=dlg(); d.close(); assert.equal(await p,null);
console.log('modal ok');
