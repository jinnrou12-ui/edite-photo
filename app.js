import {
  rgbToHsl,hslToRgb,clamp,clamp255,isSkin,brightenSkin,
  balanceLight,boostVibrancy,applyClarity,boxBlurRGBA,
  buildForegroundMask,applyBgBlur,buildCDF,buildLUT,analysePixels,
  smoothSkin,upscaleTo2K
} from './engine.js';

/* ── STATE ── */
const state={refImage:null,refData:null,targets:[],results:[]};

/* ── DOM ── */
const $=id=>document.getElementById(id);
const refDropZone=$('refDropZone'),refInput=$('refInput'),refPreviewWrap=$('refPreviewWrap');
const refPreviewImg=$('refPreviewImg'),refStats=$('refStats'),refActions=$('refActions');
const clearRefBtn=$('clearRefBtn'),targetDropZone=$('targetDropZone');
const targetInputDrop=$('targetInputDrop'),targetInput=$('targetInput');
const addMoreBtn=$('addMoreBtn'),clearTargetsBtn=$('clearTargetsBtn');
const targetsGrid=$('targetsGrid'),applyBtn=$('applyBtn');
const processingOverlay=$('processingOverlay'),processingLabel=$('processingLabel');
const processingFill=$('processingFill'),processingCount=$('processingCount');
const resultsSection=$('resultsSection'),resultsGrid=$('resultsGrid');
const downloadAllBtn=$('downloadAllBtn'),statusText=$('statusText'),statusPill=$('statusPill');

/* ── SLIDER WIRING ── */
const skinStrength=$('skinStrength'),skinStrengthVal=$('skinStrengthVal');
const blurRadius=$('blurRadius'),blurRadiusVal=$('blurRadiusVal');
const smoothStr=$('smoothStr'),smoothStrVal=$('smoothStrVal');
skinStrength.addEventListener('input',()=>skinStrengthVal.textContent=skinStrength.value+'%');
blurRadius.addEventListener('input',()=>blurRadiusVal.textContent=blurRadius.value+'px');
smoothStr.addEventListener('input',()=>smoothStrVal.textContent=smoothStr.value+'%');

function getToggles(){
  return{
    skin:$('togSkin').checked,skinStr:skinStrength.value/100,
    light:$('togLight').checked,
    blur:$('togBlur').checked,blurR:parseInt(blurRadius.value),
    vibrance:$('togVibrance').checked,
    grade:$('togGrade').checked,
    smooth:$('togSmooth').checked,smoothStr:($('smoothStr').value/100),
    upscale:$('togUpscale').checked,
  };
}

/* ── UTILS ── */
function setStatus(msg,col){
  statusText.textContent=msg;
  const d=statusPill.querySelector('.status-dot');
  d.style.background=col||'var(--green)';d.style.boxShadow=`0 0 8px ${col||'var(--green)'}`;
}
const readFile=f=>new Promise(r=>{const fr=new FileReader();fr.onload=e=>r(e.target.result);fr.readAsDataURL(f);});
const loadImg=src=>new Promise((r,j)=>{const i=new Image();i.onload=()=>r(i);i.onerror=j;i.src=src;});

function getPixels(img,max=512){
  const c=document.createElement('canvas');
  const s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
  c.width=Math.round(img.naturalWidth*s);c.height=Math.round(img.naturalHeight*s);
  c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  return c.getContext('2d').getImageData(0,0,c.width,c.height).data;
}

/* ── MAIN PROCESSING ── */
function processImage(img,lut,srcStats,opts){
  const c=document.createElement('canvas');
  c.width=img.naturalWidth;c.height=img.naturalHeight;
  const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
  const id=ctx.getImageData(0,0,c.width,c.height);
  let d=new Uint8ClampedArray(id.data);
  const w=c.width,h=c.height;

  // 1. Lighting balance
  if(opts.light){
    const expF=srcStats.exposure==='under'?computeExpGamma(srcStats.mL):srcStats.exposure==='over'?computeExpGamma(srcStats.mL):1;
    for(let i=0;i<d.length;i+=4){
      const[r,g,b]=balanceLight(d[i],d[i+1],d[i+2]);
      if(expF!==1){
        d[i]=clamp255(Math.pow(r/255,1/expF)*255);
        d[i+1]=clamp255(Math.pow(g/255,1/expF)*255);
        d[i+2]=clamp255(Math.pow(b/255,1/expF)*255);
      } else {d[i]=r;d[i+1]=g;d[i+2]=b;}
    }
  }

  // 2. Skin brightening
  if(opts.skin){
    for(let i=0;i<d.length;i+=4){
      if(isSkin(d[i],d[i+1],d[i+2])){
        const[r,g,b]=brightenSkin(d[i],d[i+1],d[i+2],opts.skinStr);
        d[i]=r;d[i+1]=g;d[i+2]=b;
      }
    }
  }

  // 3. Skin smoothing beauty filter
  if(opts.smooth) d=smoothSkin(d,w,h,opts.smoothStr);

  // 4. Color grade transfer via histogram LUT
  if(opts.grade&&lut){
    for(let i=0;i<d.length;i+=4){
      d[i]=lut[0][d[i]];d[i+1]=lut[1][d[i+1]];d[i+2]=lut[2][d[i+2]];
    }
  }

  // 5. Vibrancy
  if(opts.vibrance){
    for(let i=0;i<d.length;i+=4){
      const[r,g,b]=boostVibrancy(d[i],d[i+1],d[i+2],0.28);
      d[i]=r;d[i+1]=g;d[i+2]=b;
    }
  }

  // 6. Clarity (unsharp mask)
  if(opts.vibrance) d=applyClarity(d,w,h,2,0.45);

  // 7. Background blur
  if(opts.blur){
    const mask=buildForegroundMask(d,w,h);
    d=applyBgBlur(d,w,h,opts.blurR,mask);
  }

  const out=ctx.createImageData(w,h);
  out.data.set(d);ctx.putImageData(out,0,0);
  // 8. 2K upscale (last step so all edits are at full res first)
  return opts.upscale?upscaleTo2K(c):c;
}

function computeExpGamma(mL){
  const target=128,diff=target-mL,s=0.5;
  return clamp(1+(diff/Math.max(mL,1))*s,0.65,2.0);
}

/* ── REFERENCE ── */
async function loadReference(file){
  const src=await readFile(file);const img=await loadImg(src);
  state.refImage=img;refPreviewImg.src=src;
  refDropZone.style.display='none';refPreviewWrap.style.display='grid';refActions.style.display='flex';
  const px=getPixels(img);const cdf=buildCDF(px);const stats=analysePixels(px);
  state.refData={cdf,stats};renderRefStats(stats);updateApply();
  setStatus('Reference analysed','var(--purple)');
}

function renderRefStats(s){
  const p=v=>Math.round(v/255*100);
  const wl=s.warmBias>0.06?'warm':s.warmBias<-0.06?'cool':'neutral';
  const el=s.exposure==='under'?'dark':s.exposure==='over'?'bright':'neutral';
  refStats.innerHTML=`
    <div class="stat-card"><div class="stat-label">Luminance</div><div class="stat-value">${Math.round(s.mL)}</div>
      <div class="stat-bar"><div class="stat-bar-fill" style="width:${p(s.mL)}%;background:var(--grad-primary)"></div></div></div>
    <div class="stat-card"><div class="stat-label">Red</div><div class="stat-value">${Math.round(s.mR)}</div>
      <div class="stat-bar"><div class="stat-bar-fill" style="width:${p(s.mR)}%;background:linear-gradient(90deg,#f87171,#f472b6)"></div></div></div>
    <div class="stat-card"><div class="stat-label">Green</div><div class="stat-value">${Math.round(s.mG)}</div>
      <div class="stat-bar"><div class="stat-bar-fill" style="width:${p(s.mG)}%;background:linear-gradient(90deg,#34d399,#38bdf8)"></div></div></div>
    <div class="stat-card"><div class="stat-label">Blue</div><div class="stat-value">${Math.round(s.mB)}</div>
      <div class="stat-bar"><div class="stat-bar-fill" style="width:${p(s.mB)}%;background:linear-gradient(90deg,#60a5fa,#a78bfa)"></div></div></div>
    <div class="stat-card"><div class="stat-label">Tone</div><div class="stat-value" style="font-size:1rem">${wl.charAt(0).toUpperCase()+wl.slice(1)}</div>
      <span class="tone-tag ${wl}">${wl}</span></div>
    <div class="stat-card"><div class="stat-label">Exposure</div><div class="stat-value" style="font-size:1rem">${el.charAt(0).toUpperCase()+el.slice(1)}</div>
      <span class="tone-tag ${el}">${el}</span></div>`;
}

clearRefBtn.addEventListener('click',()=>{
  state.refImage=null;state.refData=null;
  refPreviewWrap.style.display='none';refDropZone.style.display='flex';refActions.style.display='none';
  refStats.innerHTML='';updateApply();setStatus('Ready');
});

/* ── TARGETS ── */
async function addTargets(files){
  const arr=Array.from(files).filter(f=>f.type.startsWith('image/'));
  if(!arr.length)return;
  for(const file of arr){
    const src=await readFile(file);const img=await loadImg(src);
    const px=getPixels(img,256);const stats=analysePixels(px);
    state.targets.push({file,src,img,stats,id:Date.now()+Math.random()});
  }
  renderGrid();updateApply();
  setStatus(`${state.targets.length} image${state.targets.length>1?'s':''} ready`,'var(--blue)');
}

function renderGrid(){
  if(!state.targets.length){targetsGrid.style.display='none';targetDropZone.style.display='flex';addMoreBtn.style.display='none';clearTargetsBtn.style.display='none';return;}
  targetDropZone.style.display='none';targetsGrid.style.display='grid';addMoreBtn.style.display='inline-flex';clearTargetsBtn.style.display='inline-flex';
  targetsGrid.innerHTML=state.targets.map((t,i)=>{
    const ec=t.stats.exposure==='under'?'badge-under':t.stats.exposure==='over'?'badge-over':'badge-normal';
    const et=t.stats.exposure==='under'?'Underexposed':t.stats.exposure==='over'?'Overexposed':'Normal';
    return`<div class="target-card" data-idx="${i}">
      <img class="target-thumb" src="${t.src}" alt="${t.file.name}"/>
      <span class="exposure-badge ${ec}">${et}</span>
      <button class="target-remove" onclick="removeTarget(${i})" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <div class="target-info">
        <div class="target-name">${t.file.name}</div>
        <div class="target-meta">${Math.round(t.file.size/1024)} KB · ${t.img.naturalWidth}×${t.img.naturalHeight}</div>
      </div></div>`;}).join('');
}

window.removeTarget=(idx)=>{state.targets.splice(idx,1);renderGrid();updateApply();};
clearTargetsBtn.addEventListener('click',()=>{state.targets=[];renderGrid();updateApply();resultsSection.style.display='none';setStatus('Ready');});
addMoreBtn.addEventListener('click',()=>targetInput.click());
targetInput.addEventListener('change',e=>{addTargets(e.target.files);e.target.value='';});

/* ── DROP ZONES ── */
function setupDrop(zone,onFiles){
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');onFiles(e.dataTransfer.files);});
  zone.addEventListener('click',e=>{if(e.target.classList.contains('link-text'))return;zone.querySelector('input[type=file]')?.click();});
}
setupDrop(refDropZone,files=>{if(files[0])loadReference(files[0]);});
refInput.addEventListener('change',e=>{if(e.target.files[0])loadReference(e.target.files[0]);e.target.value='';});
setupDrop(targetDropZone,addTargets);
targetInputDrop.addEventListener('change',e=>{addTargets(e.target.files);e.target.value='';});

function updateApply(){applyBtn.disabled=!(state.refData&&state.targets.length>0);}

/* ── RUN ── */
applyBtn.addEventListener('click',async()=>{
  if(!state.refData||!state.targets.length)return;
  processingOverlay.style.display='flex';processingFill.style.width='0%';
  processingLabel.textContent='Preparing AI pipeline…';processingCount.textContent='';
  setStatus('Processing…','var(--orange)');
  await new Promise(r=>setTimeout(r,60));

  const opts=getToggles();
  const refCDF=state.refData.cdf;
  state.results=[];

  for(let i=0;i<state.targets.length;i++){
    const t=state.targets[i];
    processingLabel.textContent=`Processing ${i+1} / ${state.targets.length}`;
    processingCount.textContent=t.file.name;
    processingFill.style.width=`${(i/state.targets.length)*100}%`;
    await new Promise(r=>setTimeout(r,0));

    const srcPx=getPixels(t.img);
    const lut=opts.grade?buildLUT(buildCDF(srcPx),refCDF):null;
    const adjs=[];
    if(opts.skin)adjs.push('Skin brightening');
    if(opts.smooth)adjs.push('Skin smooth');
    if(opts.light)adjs.push(t.stats.exposure!=='normal'?'Exposure fix':'Lighting');
    if(opts.blur)adjs.push('BG blur');
    if(opts.vibrance)adjs.push('Vibrancy+Clarity');
    if(opts.grade)adjs.push('Color grade');
    if(opts.upscale)adjs.push('2K upscale');

    const canvas=processImage(t.img,lut,t.stats,opts);
    state.results.push({originalSrc:t.src,gradedSrc:canvas.toDataURL('image/jpeg',0.96),filename:t.file.name,adjs,exposure:t.stats.exposure});
  }

  processingFill.style.width='100%';
  await new Promise(r=>setTimeout(r,280));
  processingOverlay.style.display='none';
  renderResults();
  setStatus(`${state.results.length} images done ✓`,'var(--green)');
});

/* ── RESULTS ── */
function renderResults(){
  resultsSection.style.display='block';resultsGrid.innerHTML='';
  state.results.forEach((res,idx)=>{
    const card=document.createElement('div');card.className='result-card';
    card.innerHTML=`
      <div class="result-comparison" id="comp-${idx}">
        <img class="result-img-before" src="${res.originalSrc}" alt="Before" draggable="false"/>
        <img class="result-img-after" src="${res.gradedSrc}" alt="After" draggable="false" id="after-${idx}"/>
        <div class="result-divider" id="divider-${idx}"><div class="result-divider-handle">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l-6-6 6-6M15 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div></div>
        <div class="result-labels"><span class="result-label">Before</span><span class="result-label">After</span></div>
      </div>
      <div class="result-info">
        <span class="result-filename">${res.filename}</span>
        <button class="btn-download" onclick="dlResult(${idx})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke-linecap="round" stroke-linejoin="round"/></svg>Save
        </button>
      </div>
      <div class="adjustments-info">${res.adjs.map((a,i)=>`<span class="adj-tag ${i===0?'exposure':i===1?'grade':'saturation'}">${a}</span>`).join('')}</div>`;
    resultsGrid.appendChild(card);
    setupComp(idx);
  });
  resultsSection.scrollIntoView({behavior:'smooth',block:'start'});
}

function setupComp(idx){
  const comp=document.getElementById(`comp-${idx}`);
  const after=document.getElementById(`after-${idx}`);
  const div=document.getElementById(`divider-${idx}`);
  let drag=false;
  const upd=x=>{const r=comp.getBoundingClientRect();let p=((x-r.left)/r.width)*100;p=Math.max(2,Math.min(98,p));after.style.clipPath=`inset(0 ${100-p}% 0 0)`;div.style.left=`${p}%`;};
  comp.addEventListener('mousedown',e=>{drag=true;upd(e.clientX);});
  window.addEventListener('mousemove',e=>{if(drag)upd(e.clientX);});
  window.addEventListener('mouseup',()=>{drag=false;});
  comp.addEventListener('touchstart',e=>{drag=true;upd(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchmove',e=>{if(drag)upd(e.touches[0].clientX);},{passive:true});
  window.addEventListener('touchend',()=>{drag=false;});
}

window.dlResult=idx=>{const res=state.results[idx];const a=document.createElement('a');a.href=res.gradedSrc;a.download=`chromagrade_${res.filename.replace(/\.[^.]+$/,'')}.jpg`;a.click();};
downloadAllBtn.addEventListener('click',()=>state.results.forEach((_,i)=>setTimeout(()=>dlResult(i),i*300)));
