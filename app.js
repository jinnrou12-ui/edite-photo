import {
  rgbToHsl,hslToRgb,clamp,clamp255,isSkin,brightenSkin,
  balanceLight,boostVibrancy,applyClarity,boxBlurRGBA,
  buildForegroundMask,applyBgBlur,buildCDF,buildLUT,analysePixels,
  smoothSkin,upscaleTo2K,applyPreset
} from './engine.js';

/* ── STATE ── */
const state={refImage:null,refData:null,targets:[],results:[],activePreset:''};

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
const blurRadius=$('blurRadius'),blurRadiusVal=$('blurRadiusVal');
const smoothStr=$('smoothStr'),smoothStrVal=$('smoothStrVal');
blurRadius.addEventListener('input',()=>blurRadiusVal.textContent=blurRadius.value+'px');
smoothStr.addEventListener('input',()=>smoothStrVal.textContent=smoothStr.value+'%');

function getToggles(){
  return{
    blur:$('togBlur').checked,blurR:parseInt(blurRadius.value),
    vibrance:$('togVibrance').checked,
    grade:$('togGrade').checked,
    smooth:$('togSmooth').checked,smoothStr:($('smoothStr').value/100),
    upscale:$('togUpscale').checked,
    preset:state.activePreset,
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
async function processImage(img,lut,srcStats,opts){
  // Work at capped resolution — all heavy ops at ≤900px, scale up at end
  const MAX=900;
  const sc=Math.min(1,MAX/Math.max(img.naturalWidth,img.naturalHeight));
  const wW=Math.round(img.naturalWidth*sc),wH=Math.round(img.naturalHeight*sc);

  const c=document.createElement('canvas');
  c.width=wW;c.height=wH;
  const ctx=c.getContext('2d');
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(img,0,0,wW,wH);
  let d=new Uint8ClampedArray(ctx.getImageData(0,0,wW,wH).data);

  // 1. AUTO: Lighting balance + exposure (always on)
  const expF=srcStats.exposure!=='normal'?computeExpGamma(srcStats.mL):1;
  for(let i=0;i<d.length;i+=4){
    let[r,g,b]=balanceLight(d[i],d[i+1],d[i+2]);
    if(expF!==1){
      r=clamp255(Math.pow(r/255,1/expF)*255);
      g=clamp255(Math.pow(g/255,1/expF)*255);
      b=clamp255(Math.pow(b/255,1/expF)*255);
    }
    if(isSkin(r,g,b)){
      const sL=(0.299*r+0.587*g+0.114*b)/255;
      if(sL<0.45){const lf=1+(0.45-sL)*0.6;r=clamp255(r*lf);g=clamp255(g*lf);b=clamp255(b*lf);}
      else if(sL>0.88){const pl=1-(sL-0.88)*0.5;r=clamp255(r*pl);g=clamp255(g*pl);b=clamp255(b*pl);}
    }
    d[i]=r;d[i+1]=g;d[i+2]=b;
  }
  await tick();

  // 2. Skin smoothing
  if(opts.smooth){d=smoothSkin(d,wW,wH,opts.smoothStr);await tick();}

  // 3. Color grade: preset OR LUT
  if(opts.preset){
    d=applyPreset(d,opts.preset);
  } else if(opts.grade&&lut){
    for(let i=0;i<d.length;i+=4){d[i]=lut[0][d[i]];d[i+1]=lut[1][d[i+1]];d[i+2]=lut[2][d[i+2]];}
  }
  await tick();

  // 4. Vibrancy + clarity
  if(opts.vibrance){
    for(let i=0;i<d.length;i+=4){const[r,g,b]=boostVibrancy(d[i],d[i+1],d[i+2],0.28);d[i]=r;d[i+1]=g;d[i+2]=b;}
    d=applyClarity(d,wW,wH,2,0.45);
    await tick();
  }

  // 5. Background blur (uses fast dilation now)
  if(opts.blur){
    const mask=buildForegroundMask(d,wW,wH);
    d=applyBgBlur(d,wW,wH,opts.blurR,mask);
    await tick();
  }

  // Write back at work resolution
  const od=ctx.createImageData(wW,wH);od.data.set(d);ctx.putImageData(od,0,0);

  // 6. Scale to original or 2K
  if(opts.upscale) return upscaleTo2K(c);
  if(sc<1){
    // Scale back to original resolution
    const orig=document.createElement('canvas');
    orig.width=img.naturalWidth;orig.height=img.naturalHeight;
    const octx=orig.getContext('2d');
    octx.imageSmoothingEnabled=true;octx.imageSmoothingQuality='high';
    octx.drawImage(c,0,0,img.naturalWidth,img.naturalHeight);
    // Apply final sharpening at full res
    const fid=octx.getImageData(0,0,orig.width,orig.height);
    const sharp=applyClarity(fid.data,orig.width,orig.height,1,0.3);
    const sod=octx.createImageData(orig.width,orig.height);sod.data.set(sharp);octx.putImageData(sod,0,0);
    return orig;
  }
  return c;
}
const tick=()=>new Promise(r=>setTimeout(r,0));


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

function updateApply(){
  applyBtn.disabled=!(state.targets.length>0&&(state.refData||state.activePreset));
}

/* ── PRESET BUTTONS ── */
document.querySelectorAll('.preset-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.activePreset=btn.dataset.preset||'';
    updateApply();
    if(state.activePreset){
      setStatus(`Preset: ${btn.textContent.trim()}`,'var(--purple)');
    } else {
      setStatus('Ready');
    }
  });
});

/* ── RUN ── */
applyBtn.addEventListener('click',async()=>{
  if(!state.targets.length||((!state.refData)&&!state.activePreset))return;
  processingOverlay.style.display='flex';processingFill.style.width='0%';
  processingLabel.textContent='Preparing AI pipeline…';processingCount.textContent='';
  setStatus('Processing…','var(--orange)');
  await new Promise(r=>setTimeout(r,60));

  const opts=getToggles();
  const refCDF=state.refData?state.refData.cdf:null;
  state.results=[];

  for(let i=0;i<state.targets.length;i++){
    const t=state.targets[i];
    processingLabel.textContent=`Processing ${i+1} / ${state.targets.length}`;
    processingCount.textContent=t.file.name;
    processingFill.style.width=`${(i/state.targets.length)*100}%`;
    await new Promise(r=>setTimeout(r,0));

    const srcPx=getPixels(t.img);
    const lut=opts.grade?buildLUT(buildCDF(srcPx),refCDF):null;
    const adjs=['Auto Lighting'];
    if(opts.smooth)adjs.push('Skin smooth');
    if(opts.blur)adjs.push('BG blur');
    if(opts.vibrance)adjs.push('Vibrancy+Clarity');
    if(opts.preset)adjs.push('Preset: '+opts.preset);
    else if(opts.grade)adjs.push('Color grade');
    if(opts.upscale)adjs.push('2K upscale');

    const canvas=await processImage(t.img,lut,t.stats,opts);
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
