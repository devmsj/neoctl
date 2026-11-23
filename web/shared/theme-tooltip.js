// One delegated tooltip per document, including native chrome shadow roots.
// No transcript scans, per-row listeners or streaming mutation observers.
(() => {
  if (window.__neoTooltipInstalled) return;
  window.__neoTooltipInstalled = true;
  const mount = () => {
    const host = document.createElement('neo-tooltip-layer');
    const shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>
      :host{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:var(--appearance-ui-font,var(--chrome-sans,system-ui,sans-serif));--tip-accent:var(--appearance-accent,var(--chrome-accent,#8c456e))}
      [hidden]{display:none}
      .tip{position:fixed;box-sizing:border-box;max-width:min(440px,calc(100vw - 16px));max-height:calc(100dvh - 16px);overflow:auto;pointer-events:auto;padding:7px 10px;border:1px solid color-mix(in srgb,var(--tip-accent) 48%,transparent);border-radius:var(--appearance-radius,5px);background:color-mix(in srgb,var(--tip-accent) 8%,var(--chrome-raised,#fff));color:var(--chrome-text,#20252d);box-shadow:0 4px 16px #0001;font-size:calc(12px * var(--appearance-ui-scale,1));line-height:1.6;font-weight:400;white-space:pre-wrap;overflow-wrap:anywhere;animation:show .12s ease-out}
      @keyframes show{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}
      @media(prefers-reduced-motion:reduce){.tip{animation:none}}
      @media(forced-colors:active){.tip{background:Canvas;color:CanvasText;border-color:CanvasText}}
    </style><div class="tip" role="tooltip" hidden></div>`;
    document.body.append(host);
    const tip = shadow.querySelector('.tip');
    // The light-DOM description supports accessibility across shadow boundaries.
    const description = document.createElement('span'); description.id='neo-tooltip-description';
    description.style.cssText='position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);pointer-events:none';
    host.append(description);
    // Hover hints wait for the pointer to rest so passing over controls stays quiet.
    const HOVER_DELAY = 700, FOCUS_DELAY = 100;
    const CONTROL = 'button,a,summary,[role="button"]';
    let target, timer, closeTimer, observer, suppressed;
    // Icon controls without an explicit hint fall back to their accessible name.
    const text = el => el?.getAttribute?.('data-tooltip') || (el?.matches?.(CONTROL) && iconOnly(el) ? (el.getAttribute('aria-label') || '').trim() : '');
    function position() {
      if (!target?.isConnected) { hide(); return; }
      const r=target.getBoundingClientRect(), w=tip.offsetWidth,h=tip.offsetHeight;
      const x=Math.max(8,Math.min(r.left+(r.width-w)/2,innerWidth-w-8));
      const y=r.top>=h+14?r.top-h-7:Math.min(r.bottom+7,innerHeight-h-8);
      tip.style.left=x+'px';tip.style.top=Math.max(8,y)+'px';
    }
    function hide() {
      clearTimeout(timer);clearTimeout(closeTimer);observer?.disconnect();
      if(target){const ids=(target.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==description.id);if(ids.length)target.setAttribute('aria-describedby',ids.join(' '));else target.removeAttribute('aria-describedby');}
      target=undefined;tip.hidden=true;description.textContent='';
    }
    function show() {
      if(!target?.isConnected || !text(target)){hide();return;}
      tip.textContent=description.textContent=text(target);tip.hidden=false;
      const ids=new Set((target.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(description.id);target.setAttribute('aria-describedby',[...ids].join(' '));
      position();
      observer=new MutationObserver(()=>{if(!text(target)){hide();return;}tip.textContent=description.textContent=text(target);position();});
      observer.observe(target,{attributes:true,attributeFilter:['data-tooltip','aria-label']});
    }
    // Icon controls (no visible words) show their hint after a hover pause or
    // keyboard focus; text titles/paths still expand the same way.
    function iconOnly(node) {
      if(node.namespaceURI==='http://www.w3.org/2000/svg') return true;
      const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      let content='', part;
      while((part=walker.nextNode())) {
        if(part.parentElement?.closest('svg,[aria-hidden="true"],.sr-only,.visually-hidden'))continue;
        content+=part.textContent;
      }
      return !/[\p{L}]/u.test(content) && (node.matches('button,a,summary,[role="button"]') || !!node.querySelector('svg,img,i') || !!content.trim());
    }
    function find(event) {
      const path=event.composedPath().filter(node=>node instanceof Element);
      // Strip legacy native titles before their own browser hover delay, even
      // when a nested icon will suppress the custom tooltip.
      for(const node of path) {
        if(node.hasAttribute('title') && node.tagName!=='IFRAME') {
          node.setAttribute('data-tooltip',node.getAttribute('title'));node.removeAttribute('title');
        }
      }
      for(const node of path) {
        const hint=text(node);
        if(hint) {
          if(!node.hasAttribute('aria-label') && iconOnly(node))node.setAttribute('aria-label',hint);
          return node;
        }
        // An unnamed icon control never borrows an ancestor's hint.
        if(node.matches(CONTROL) && iconOnly(node))return;
      }
    }
    function enter(event) {
      if(event.pointerType==='touch')return;
      if(event.composedPath().includes(host)){clearTimeout(closeTimer);return;}
      // Mouse clicks also focus controls; only keyboard focus should reveal hints.
      if(event.type==='focusin' && !event.composedPath()[0]?.matches?.(':focus-visible'))return;
      const next=find(event);if(next===target){clearTimeout(closeTimer);return;}
      // After a click, stay quiet until the pointer moves onto something else.
      if(event.type==='pointerover'){if(next&&next===suppressed)return;suppressed=undefined;}
      hide();if(!next)return;target=next;timer=setTimeout(show,event.type==='focusin'?FOCUS_DELAY:HOVER_DELAY);
    }
    document.addEventListener('pointerover',enter);
    document.addEventListener('focusin',enter);
    document.addEventListener('pointerout',event=>{if(target&&!event.composedPath().includes(host)&&!target.contains(event.relatedTarget))closeTimer=setTimeout(hide,140);});
    host.addEventListener('pointerleave',()=>{closeTimer=setTimeout(hide,140);});
    document.addEventListener('focusout',()=>{closeTimer=setTimeout(hide,140);});
    document.addEventListener('pointerdown',event=>{if(event.composedPath().includes(host))return;hide();suppressed=find(event);},true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')hide();},true);
    // Columns scroll independently (transcript auto-follow streams constantly);
    // only a scroll that moves the hovered element dismisses its hint.
    const movesTarget=source=>{if(!target?.isConnected||!source||source===document||source===document.documentElement||source===document.body)return true;for(let n=target;n;n=n.parentNode||n.host)if(n===source)return true;return false;};
    document.addEventListener('scroll',event=>{if(target&&!event.composedPath().includes(host)&&movesTarget(event.target))hide();},true);
    window.addEventListener('resize',hide);window.addEventListener('blur',hide);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
