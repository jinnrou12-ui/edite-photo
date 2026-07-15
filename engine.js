/* ── ChromaGrade Processing Engine ── */

// ── Color conversions ──
export function rgbToHsl(r,g,b){
  r/=255;g/=255;b/=255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if(max===min){h=s=0;}
  else{
    const d=max-min;
    s=l>0.5?d/(2-max-min):d/(max+min);
    switch(max){
      case r:h=((g-b)/d+(g<b?6:0))/6;break;
      case g:h=((b-r)/d+2)/6;break;
      default:h=((r-g)/d+4)/6;
    }
  }
  return[h*360,s,l];
}

export function hslToRgb(h,s,l){
  h/=360;
  if(s===0)return[Math.round(l*255),Math.round(l*255),Math.round(l*255)];
  const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;
  const hue=(p,q,t)=>{
    if(t<0)t+=1;if(t>1)t-=1;
    if(t<1/6)return p+(q-p)*6*t;
    if(t<1/2)return q;
    if(t<2/3)return p+(q-p)*(2/3-t)*6;
    return p;
  };
  return[hue(p,q,h+1/3),hue(p,q,h),hue(p,q,h-1/3)].map(v=>Math.round(clamp(v)*255));
}

export const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
export const clamp255=(v)=>Math.max(0,Math.min(255,Math.round(v)));

// ── Skin detection (all tones) ──
export function isSkin(r,g,b){
  const[h,s,l]=rgbToHsl(r,g,b);
  return((h>=0&&h<=50)||(h>=340&&h<=360))&&s>=0.08&&s<=0.78&&l>=0.14&&l<=0.93&&r>b;
}

// ── Brighten skin toward fair complexion ──
export function brightenSkin(r,g,b,strength){
  let[h,s,l]=rgbToHsl(r,g,b);
  if(l<0.73){
    const tL=0.82,tS=0.33;
    l=l+(tL-l)*strength;
    if(s>tS)s=s-(s-tS)*strength*0.55;
    if(h>26)h=h-(h-22)*strength*0.25;
  }
  return hslToRgb(h,s,l);
}

// ── Lighting balance: lift shadows, recover highlights ──
export function balanceLight(r,g,b){
  const lum=(0.299*r+0.587*g+0.114*b)/255;
  let factor=1;
  if(lum<0.25)factor=1+(0.25-lum)*1.2;      // lift shadows
  else if(lum>0.82)factor=1-(lum-0.82)*0.9; // recover highlights
  return[clamp255(r*factor),clamp255(g*factor),clamp255(b*factor)];
}

// ── Vibrancy: boost saturation of dull colors, protect vivid ones ──
export function boostVibrancy(r,g,b,amount){
  let[h,s,l]=rgbToHsl(r,g,b);
  if(s>0.05&&l>0.1&&l<0.95){
    const boost=amount*(1-s); // less boost for already-vivid pixels
    s=clamp(s+boost,0,1);
  }
  return hslToRgb(h,s,l);
}

// ── Unsharp mask clarity ──
export function applyClarity(pixels,w,h,radius=2,amount=0.55){
  const blurred=boxBlurRGBA(pixels,w,h,radius);
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i+=4){
    for(let c=0;c<3;c++){
      const diff=pixels[i+c]-blurred[i+c];
      out[i+c]=clamp255(pixels[i+c]+diff*amount);
    }
    out[i+3]=pixels[i+3];
  }
  return out;
}

// ── Fast box blur (separable) ──
export function boxBlurRGBA(src,w,h,r){
  const tmp=new Float32Array(src.length);
  const out=new Uint8ClampedArray(src.length);
  const len=2*r+1;
  // Horizontal
  for(let y=0;y<h;y++){
    for(let c=0;c<3;c++){
      let sum=0;
      for(let x=-r;x<=r;x++)sum+=src[(y*w+clamp(x,0,w-1))*4+c];
      for(let x=0;x<w;x++){
        tmp[(y*w+x)*4+c]=sum/len;
        const add=clamp(x+r+1,0,w-1),rem=clamp(x-r,0,w-1);
        sum+=src[(y*w+add)*4+c]-src[(y*w+rem)*4+c];
      }
    }
  }
  // Vertical
  for(let x=0;x<w;x++){
    for(let c=0;c<3;c++){
      let sum=0;
      for(let y=-r;y<=r;y++)sum+=tmp[(clamp(y,0,h-1)*w+x)*4+c];
      for(let y=0;y<h;y++){
        out[(y*w+x)*4+c]=sum/len;
        const add=clamp(y+r+1,0,h-1),rem=clamp(y-r,0,h-1);
        sum+=tmp[(add*w+x)*4+c]-tmp[(rem*w+x)*4+c];
      }
    }
  }
  // Alpha
  for(let i=3;i<src.length;i+=4)out[i]=src[i];
  return out;
}

// ── Build foreground mask from skin pixels + center weight ──
export function buildForegroundMask(pixels,w,h){
  const mask=new Float32Array(w*h);
  const cx=w/2,cy=h/2,maxD=Math.sqrt(cx*cx+cy*cy);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const skin=isSkin(pixels[i],pixels[i+1],pixels[i+2])?1:0;
      const d=Math.sqrt((x-cx)**2+(y-cy)**2);
      const center=clamp(1-d/maxD*0.85,0,1);
      mask[y*w+x]=clamp(skin*0.75+center*0.25,0,1);
    }
  }
  // Fast separable dilation (horizontal then vertical max-filter)
  const dr=Math.max(6,Math.round(Math.min(w,h)*0.05));
  const tmp=new Float32Array(w*h);
  // Horizontal pass
  for(let y=0;y<h;y++){
    let mx=0;
    for(let x=0;x<dr;x++)mx=Math.max(mx,mask[y*w+x]);
    for(let x=0;x<w;x++){
      if(x+dr<w)mx=Math.max(mx,mask[y*w+x+dr]);
      tmp[y*w+x]=mx;
      if(x-dr>=0&&mask[y*w+x-dr]>=mx){
        mx=0;
        const lo=Math.max(0,x-dr+1),hi=Math.min(w-1,x+dr);
        for(let k=lo;k<=hi;k++)mx=Math.max(mx,mask[y*w+k]);
      }
    }
  }
  // Vertical pass
  const out=new Float32Array(w*h);
  for(let x=0;x<w;x++){
    let mx=0;
    for(let y=0;y<dr;y++)mx=Math.max(mx,tmp[y*w+x]);
    for(let y=0;y<h;y++){
      if(y+dr<h)mx=Math.max(mx,tmp[(y+dr)*w+x]);
      out[y*w+x]=mx;
      if(y-dr>=0&&tmp[(y-dr)*w+x]>=mx){
        mx=0;
        const lo=Math.max(0,y-dr+1),hi=Math.min(h-1,y+dr);
        for(let k=lo;k<=hi;k++)mx=Math.max(mx,tmp[k*w+x]);
      }
    }
  }
  return out;
}

// ── Apply background blur using mask ──
export function applyBgBlur(pixels,w,h,radius,mask){
  const blurred=boxBlurRGBA(pixels,w,h,radius);
  // Second pass for stronger blur
  const blurred2=boxBlurRGBA(blurred,w,h,Math.ceil(radius*0.6));
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<w*h;i++){
    const idx=i*4;
    const fg=mask[i]; // 1=foreground keep sharp, 0=background blur
    for(let c=0;c<3;c++){
      out[idx+c]=Math.round(pixels[idx+c]*fg+blurred2[idx+c]*(1-fg));
    }
    out[idx+3]=255;
  }
  return out;
}

// ── Histogram CDF ──
export function buildCDF(pixels){
  const hist=[new Float32Array(256),new Float32Array(256),new Float32Array(256)];
  const n=pixels.length/4;
  for(let i=0;i<pixels.length;i+=4){hist[0][pixels[i]]++;hist[1][pixels[i+1]]++;hist[2][pixels[i+2]]++;}
  const cdf=[new Float32Array(256),new Float32Array(256),new Float32Array(256)];
  for(let ch=0;ch<3;ch++){let s=0;for(let v=0;v<256;v++){s+=hist[ch][v];cdf[ch][v]=s/n;}}
  return cdf;
}

export function buildLUT(srcCDF,refCDF){
  const lut=[new Uint8Array(256),new Uint8Array(256),new Uint8Array(256)];
  for(let ch=0;ch<3;ch++){let j=0;for(let i=0;i<256;i++){while(j<255&&refCDF[ch][j]<srcCDF[ch][i])j++;lut[ch][i]=j;}}
  return lut;
}

export function analysePixels(pixels){
  let sR=0,sG=0,sB=0,sL=0;const n=pixels.length/4;
  for(let i=0;i<pixels.length;i+=4){const r=pixels[i],g=pixels[i+1],b=pixels[i+2];sR+=r;sG+=g;sB+=b;sL+=0.299*r+0.587*g+0.114*b;}
  const mR=sR/n,mG=sG/n,mB=sB/n,mL=sL/n;
  const warmBias=(mR-mB)/255;
  const exposure=mL<80?'under':mL>175?'over':'normal';
  return{mR,mG,mB,mL,warmBias,exposure};
}

// ── Built-in color grade presets ──
const _sCurve=(v,str=0.18)=>{const n=v/255;return clamp255((n+(str*Math.sin(Math.PI*n)))*255);};

export const PRESETS={
  golden:(r,g,b)=>{
    // Warm golden hour: lifted shadows, orange highlights, slight teal in darks
    const l=(r*0.299+g*0.587+b*0.114)/255;
    const w=l*22,c=l*8;
    return[clamp255(r+w),clamp255(g+w*0.25),clamp255(b-c)];
  },
  cinematic:(r,g,b)=>{
    // Classic teal-orange: cool shadows, warm highlights
    const l=(r*0.299+g*0.587+b*0.114)/255;
    if(l<0.42)return[clamp255(r*0.82),clamp255(g*1.04+4),clamp255(b*1.18+12)];
    return[clamp255(r*1.1+12),clamp255(g*1.0),clamp255(b*0.85)];
  },
  soft:(r,g,b)=>{
    // Airy & soft: lifted blacks, pastel, slight pink warmth
    return[clamp255(r*0.82+28+6),clamp255(g*0.82+28),clamp255(b*0.84+26)];
  },
  film:(r,g,b)=>{
    // Film emulation: faded blacks, desaturated, slight yellow cast
    let[h,s,l]=rgbToHsl(r,g,b);
    s*=0.72;
    if(l<0.12)l+=0.06;
    const[nr,ng,nb]=hslToRgb(h,s,l);
    return[clamp255(nr+4),clamp255(ng+2),clamp255(nb-3)];
  },
  vivid:(r,g,b)=>{
    // Punchy & vivid: deep shadows, rich color, high contrast
    let[h,s,l]=rgbToHsl(r,g,b);
    s=clamp(s*1.4,0,1);
    l=l<0.5?l*0.92:clamp(l*1.04,0,1);
    return hslToRgb(h,s,l);
  },
  moody:(r,g,b)=>{
    // Dark & moody: deep shadows, muted mids, cool blue-green tone
    const l=(r*0.299+g*0.587+b*0.114)/255;
    const crush=l<0.3?0.75:1;
    return[clamp255(r*crush*0.88),clamp255(g*crush*0.92+3),clamp255(b*crush*1.08+8)];
  },
};

export function applyPreset(pixels,presetName){
  const fn=PRESETS[presetName];
  if(!fn)return pixels;
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i+=4){
    const[r,g,b]=fn(pixels[i],pixels[i+1],pixels[i+2]);
    out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=pixels[i+3];
  }
  return out;
}

// ── Skin smoothing: edge-preserving beauty filter ──
export function smoothSkin(pixels,w,h,strength){
  // Two blur passes for smooth base
  const b1=boxBlurRGBA(pixels,w,h,3);
  const b2=boxBlurRGBA(b1,w,h,2);
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i+=4){
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(isSkin(r,g,b)){
      // Edge detection: diff between original and blurred
      const edge=(Math.abs(r-b1[i])+Math.abs(g-b1[i+1])+Math.abs(b-b1[i+2]))/3;
      // Edge weight: 0=smooth area (apply blur), 1=edge (keep sharp)
      const ew=Math.min(edge/25,1);
      const sw=strength*(1-ew); // smooth strength, reduced at edges
      out[i]  =clamp255(r*(1-sw)+b2[i]  *sw);
      out[i+1]=clamp255(g*(1-sw)+b2[i+1]*sw);
      out[i+2]=clamp255(b*(1-sw)+b2[i+2]*sw);
      // Subtle warm glow on skin
      const glow=sw*0.08;
      out[i]  =clamp255(out[i]  *(1+glow));
      out[i+1]=clamp255(out[i+1]*(1+glow*0.4));
    } else {
      out[i]=r;out[i+1]=g;out[i+2]=b;
    }
    out[i+3]=pixels[i+3];
  }
  return out;
}

// ── 2K upscaling: multi-step bicubic + post-sharpen ──
export function upscaleTo2K(canvas){
  const TARGET=2048;
  if(canvas.width>=TARGET)return canvas; // already 2K+
  const aspect=canvas.height/canvas.width;
  const tW=TARGET,tH=Math.round(TARGET*aspect);
  // Multi-step: scale by 1.5x increments for better quality than single jump
  let cur=canvas;
  while(cur.width<tW*0.72){
    const nW=Math.min(Math.round(cur.width*1.5),tW);
    const nH=Math.round(cur.height*(nW/cur.width));
    const step=document.createElement('canvas');
    step.width=nW;step.height=nH;
    const ctx=step.getContext('2d');
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(cur,0,0,nW,nH);
    cur=step;
  }
  // Final pass to exact 2K
  const out=document.createElement('canvas');
  out.width=tW;out.height=tH;
  const ctx=out.getContext('2d');
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(cur,0,0,tW,tH);
  // Post-sharpen: unsharp mask on upscaled result
  const id=ctx.getImageData(0,0,tW,tH);
  const sharpened=applyClarity(id.data,tW,tH,2,0.6);
  const od=ctx.createImageData(tW,tH);od.data.set(sharpened);ctx.putImageData(od,0,0);
  return out;
}
