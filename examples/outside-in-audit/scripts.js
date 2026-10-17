for (const b of document.querySelectorAll(".copybtn")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.clip);
        const old = b.textContent; b.textContent = "copied";
        setTimeout(() => { b.textContent = old; }, 1600);
      } catch { b.textContent = "select + copy"; }
    });
  }

(() => {
  const cvs = document.getElementById("hero-art");
  if (!cvs) return;
  const ctx = cvs.getContext("2d");
  if (!ctx) return;
  const PAL = ["#e8dcc0","#cdd6a0","#a9c06a","#cf9a54","#cd8a4f","#c1703c","#9e4e29","#6e2b26"];
  const BAYER = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]].map(r=>r.map(v=>(v+0.5)/16));
  const CELL = 4, N = PAL.length, dot = CELL - 1;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function hash(x,y){ let h=x*374761393+y*668265263; h=(h^(h>>>13))>>>0; h=Math.imul(h,1274126177)>>>0; return (h&0xffffffff)/0xffffffff; }
  const ss = t => t*t*(3-2*t);
  function vn(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const a=hash(xi,yi),b=hash(xi+1,yi),c=hash(xi,yi+1),d=hash(xi+1,yi+1); const u=ss(xf),v=ss(yf);
    return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v; }
  function fbm(x,y){ let amp=1,f=1,s=0,n=0; for(let i=0;i<6;i++){ s+=amp*vn(x*f,y*f); n+=amp; amp*=0.54; f*=1.98; } return s/n; }
  let E=new Float32Array(0), cols=0, rows=0;
  function computeField(){
    const W=cvs.clientWidth, H=cvs.clientHeight; if(!W||!H) return;
    cvs.width=Math.floor(W*dpr); cvs.height=Math.floor(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
    cols=Math.ceil(W/CELL)+1; rows=Math.ceil(H/CELL)+1; const sc=3.9/cols; E=new Float32Array(cols*rows);
    let mn=Infinity,mx=-Infinity;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ const v=fbm(3.1+c*sc,1.4+r*sc); E[r*cols+c]=v; if(v<mn)mn=v; if(v>mx)mx=v; }
    const d=mx-mn||1;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
      const u=c/cols; let e=(E[r*cols+c]-mn)/d;
      e=Math.pow(e,1.7);            // airier — most cells stay light, paper shows through
      e=e*(0.45+u*0.8);            // light on the left, warming to the right
      E[r*cols+c]=Math.min(1,e);
    }
  }
  function frame(T,inten,cx,cy){
    const W=cvs.clientWidth,H=cvs.clientHeight; ctx.clearRect(0,0,W,H); const live=inten>0.002;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
      let t=E[r*cols+c];
      if(live){ t+=0.045*inten*Math.sin(T*0.9+c*0.09+r*0.07);
        const dx=c-cx,dy=r-cy,dd=Math.sqrt(dx*dx+dy*dy); t+=(0.16*inten*Math.sin(dd*0.45-T*4.5))/(1+dd*0.05); }
      if(t<0)t=0; if(t>1)t=1;
      const p=t*(N-1),lo=Math.floor(p),frac=p-lo;
      const idx=frac>BAYER[r&3][c&3]?Math.min(N-1,lo+1):lo; if(idx===0) continue;
      ctx.fillStyle=PAL[idx]; ctx.fillRect(c*CELL,r*CELL,dot,dot);
    }
  }
  let inten=0,target=0,cx=0,cy=0,raf=0,start=0,running=false;
  function loop(now){ if(!start)start=now; const T=(now-start)/1000; inten+=(target-inten)*0.09; frame(T,inten,cx,cy);
    if(target>0||inten>0.01) raf=requestAnimationFrame(loop); else { running=false; frame(T,0,0,0); } }
  function onMove(e){ if(reduce) return; const rect=cvs.getBoundingClientRect(); const x=e.clientX-rect.left,y=e.clientY-rect.top;
    if(x>=0&&y>=0&&x<=rect.width&&y<=rect.height){ target=1; cx=x/CELL; cy=y/CELL; if(!running){ running=true; raf=requestAnimationFrame(loop); } } else target=0; }
  computeField(); frame(0,0,0,0);
  new ResizeObserver(()=>{ computeField(); frame(0,inten,cx,cy); }).observe(cvs.parentElement);
  window.addEventListener("mousemove", onMove, {passive:true});
})();
