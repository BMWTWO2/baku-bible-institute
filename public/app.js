document.querySelectorAll('[data-count]').forEach(el=>{const t=+el.dataset.count;let n=0;const s=Math.max(1,Math.ceil(t/40));const i=setInterval(()=>{n=Math.min(t,n+s);el.textContent=n;if(n>=t)clearInterval(i)},30)});
requestAnimationFrame(()=>setTimeout(()=>document.querySelectorAll('.bar i[data-w]').forEach(i=>i.style.width=i.dataset.w+'%'),150));
document.querySelectorAll('[data-apply]').forEach(f=>{const sel=f.querySelector('[data-act]');const sync=()=>f.querySelectorAll('[data-for]').forEach(s=>s.hidden=!s.dataset.for.split(' ').includes(sel.value));sel.addEventListener('change',sync);sync()});
// QR check-in display: full screen, print, copy image, live roster polling (CSP: no inline scripts).
document.querySelectorAll('[data-print]').forEach(b=>b.addEventListener('click',()=>window.print()));
document.querySelectorAll('[data-fullscreen]').forEach(b=>b.addEventListener('click',()=>{const el=document.querySelector('.qr-stage')||document.documentElement;(document.fullscreenElement?document.exitFullscreen():el.requestFullscreen?.())}));
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{const msg=document.querySelector('[data-copy-msg]');
  try{if(!navigator.clipboard||!window.ClipboardItem)throw new Error('no clipboard');await navigator.clipboard.write([new ClipboardItem({'image/png':fetch(b.dataset.copy,{credentials:'same-origin'}).then(r=>{if(!r.ok)throw new Error('fetch');return r.blob()})})]);
    b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy image',2500)}catch(e){if(msg){msg.textContent='Your browser blocked copying. Right-click the QR code and choose “Copy image” instead.';msg.classList.add('err')}}}));
(()=>{const w=document.querySelector('[data-roster]');if(!w)return;const url=w.dataset.roster;const $=s=>w.querySelector(s);
  const li=(t,sub)=>{const e=document.createElement('li');e.textContent=t;if(sub){const s=document.createElement('span');s.className='muted';s.textContent=' '+sub;e.append(s)}return e};
  const fill=(sel,arr,f,empty)=>{const ul=$(sel);if(!ul)return;ul.replaceChildren(...arr.map(f));if(!arr.length&&empty){const e=li(empty);e.className='muted';ul.append(e)}};
  const tick=async()=>{try{const r=await fetch(url,{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;const d=await r.json();
    $('[data-n-scanned]').textContent=d.scanned.length+d.marked.length;$('[data-n-total]').textContent=d.total;
    fill('[data-missing]',d.missing,x=>li(x.name),'Everyone is in ✓');fill('[data-scanned]',d.scanned,x=>li(x.name,x.time));fill('[data-marked]',d.marked,x=>li(x.name,x.status));
    $('[data-updated]').textContent='· updated '+d.now_baku+' Baku'}catch(e){}};setInterval(tick,5000);})();
document.querySelectorAll('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault()}));
// Lessons: fill a textarea from a chosen .txt/.md file (read in the browser; nothing uploaded separately).
document.querySelectorAll('input[type=file][data-fill]').forEach(inp=>inp.addEventListener('change',()=>{const f=inp.files[0];const ta=document.getElementById(inp.dataset.fill);if(!f||!ta)return;const r=new FileReader();r.onload=()=>{ta.value=String(r.result).slice(0,100000);const s=inp.form&&inp.form.querySelector('[name=source]');if(s)s.value='paste'};r.readAsText(f)}));
// Five questions: live "x of 3 chosen" counter.
document.querySelectorAll('form[data-choose]').forEach(f=>{const n=+f.dataset.choose;const out=f.querySelector('[data-choose-count]');const tas=[...f.querySelectorAll('textarea')];const upd=()=>{const k=tas.filter(t=>t.value.trim()).length;if(out){out.textContent=`Seçilib: ${k} / ${n}`;out.classList.toggle('err',k>n)}};tas.forEach(t=>t.addEventListener('input',upd));upd()});
