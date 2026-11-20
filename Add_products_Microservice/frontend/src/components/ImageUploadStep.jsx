import React, { useRef, useState, useEffect, useCallback } from 'react';
import { uploadImages, generateProductContent } from '../services/api';

/* ─── Client-side canvas compression ─── */
const compressImage = (file) =>
  new Promise((resolve) => {
    if (file.size < 300 * 1024 || !file.type.startsWith('image/')) return resolve(file);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1200;
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) {
        const ratio = Math.min(MAX / w, MAX / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob && blob.size < file.size)
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        else resolve(file);
      }, 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });

/* ─── Loading Messages & Milestones ─── */
const LOADING_MSGS = [
  '🔍 Searching the web for product information...',
  '🌐 Analyzing product pages and specifications...',
  '📊 Extracting technical details...',
  '✍️ Generating SEO-optimized title...',
  '📝 Creating product descriptions...',
  '🎯 Finalizing features and specs...',
  '✅ Almost done...'
];
const MILESTONES = [
  { at: 3,  text: 'Searching the web...' },
  { at: 8,  text: 'Scraping product pages...' },
  { at: 18, text: 'Analyzing specifications...' },
  { at: 25, text: 'AI generating descriptions...' },
  { at: 40, text: 'Finalizing content...' }
];

/* ─── Camera guide definitions ─── */
const GUIDES = {
  searching: { text: '🔍 Searching for product...', hint: 'Point the camera clearly at the item' },
  down:      { text: '⬇ Move DOWN',               hint: 'The product is too high in the frame' },
  up:        { text: '⬆ Move UP',                 hint: 'The product is too low in the frame' },
  right:     { text: '➡ Move RIGHT',              hint: 'The product is too far left' },
  left:      { text: '⬅ Move LEFT',               hint: 'The product is too far right' },
  back:      { text: '🔙 MOVE BACK',              hint: 'The object is clipped at the edges!' },
  perfect:   { text: '✅ [ READY TO CAPTURE ]',  hint: '⚡ Snap! Perfect alignment achieved.' },
  manual:    { text: '🎯 Manual Mode',             hint: 'Center product manually and tap capture' }
};

const LERP_SPEED = 0.3;
const MIN_FRAME_SIZE = 90;
const FRAME_PAD_RATIO = 0.12;
const EDGE_MARGIN = 8;
const PERFECT_FRAMES_NEEDED = 5;
const HYSTERESIS_FRAMES = 2;
const GUIDE_RANK = { perfect: 4, back: 2, left: 1, right: 1, up: 1, down: 1, searching: 0 };

function lerp(a, b, t) { return a + (b - a) * t; }

const SparkleIcon = ({ active, className = "w-3.5 h-3.5" }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 24 24" 
    fill={active ? "currentColor" : "none"} 
    stroke="currentColor" 
    strokeWidth="2.2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
  </svg>
);

export default function ImageUploadStep({
  images, setImages, onBack, onNext,
  setUploadedUrls, setUploadedTempMediaIds, setGeneratedContent, formData,
  isProcessing, setIsProcessing
}) {
  const [skipImageUpload, setSkipImageUpload] = useState(false);
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const [keepOriginalName, setKeepOriginalName] = useState(false);
  const [imageEnhancements, setImageEnhancements] = useState([]);
  const [previewProgress, setPreviewProgress] = useState({ done: 0, total: 0, label: '' });
  const [cameraOpen, setCameraOpen]     = useState(false);
  const [capturePreview, setCapturePreview] = useState(null); // data-url or null
  const [isManualMode, setIsManualMode] = useState(false);
  const [statusKey, setStatusKey]       = useState('searching');
  const [statusCls, setStatusCls]       = useState('warn');
  const [cdShow, setCdShow]             = useState(false);

  /* Loading screen state */
  const [loadingMsg, setLoadingMsg]     = useState(LOADING_MSGS[0]);
  const [elapsed, setElapsed]           = useState(0);
  const [progress, setProgress]         = useState(0);
  const [progressText, setProgressText] = useState('Starting...');
  const [loadError, setLoadError]       = useState(null);

  const videoRef     = useRef(null);
  const overlayRef   = useRef(null);
  const canvasRef    = useRef(null);          // hidden capture canvas
  const camStream    = useRef(null);
  const cocoModel    = useRef(null);
  const analyseTimer = useRef(null);
  const countdownTimer = useRef(null);
  const isAnalysing  = useRef(false);
  const camReady     = useRef(false);
  const smoothFrame  = useRef({ x:0, y:0, w:0, h:0, active:false });
  const perfectCount = useRef(0);
  const prevGuide    = useRef('searching');
  const badFrames    = useRef(0);
  const capturedBlob = useRef(null);
  const facingMode   = useRef('environment');
  const loadTimerRef = useRef(null);
  const loadMsgRef   = useRef(null);
  const startTimeRef = useRef(null);

  /* Load COCO-SSD once */
  useEffect(() => {
    const el1 = document.getElementById('coco-ssd-tf');
    const el2 = document.getElementById('coco-ssd-model');
    if (!el1) {
      const s = document.createElement('script');
      s.id = 'coco-ssd-tf';
      s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs';
      document.head.appendChild(s);
      s.onload = () => {
        const s2 = document.createElement('script');
        s2.id = 'coco-ssd-model';
        s2.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd';
        document.head.appendChild(s2);
        s2.onload = () => {
          window.cocoSsd?.load().then(m => { cocoModel.current = m; });
        };
      };
    } else if (!cocoModel.current && window.cocoSsd) {
      window.cocoSsd.load().then(m => { cocoModel.current = m; });
    }
  }, []);

  /* ─── File handling ─── */
  const addFiles = useCallback(async (files) => {
    const valid = files.filter(f => f.type.startsWith('image/') && f.size <= 20 * 1024 * 1024);
    if (images.length + valid.length > 4) { alert('Max 4 images.'); return; }
    if (valid.length === 0) return;

    setIsPreparingImages(true);
    setPreviewProgress({ done: 0, total: valid.length, label: 'Preparing image previews…' });

    try {
      const compressed = [];
      for (let index = 0; index < valid.length; index += 1) {
        const compressedFile = await compressImage(valid[index]);
        compressed.push(compressedFile);
        setPreviewProgress({
          done: index + 1,
          total: valid.length,
          label: index === 0 ? 'Generating first preview…' : 'Preparing preview images…',
        });
      }

      setImages(prev => [...prev, ...compressed]);
      setImageEnhancements(prev => [...prev, ...compressed.map(() => true)]);
    } finally {
      setIsPreparingImages(false);
      setPreviewProgress({ done: 0, total: 0, label: '' });
    }
  }, [images.length, setImages]);

  const removeImage = (idx) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
    setImageEnhancements(prev => prev.filter((_, i) => i !== idx));
  };

  /* ─── Camera stream ─── */
  const stopStream = useCallback(() => {
    camReady.current = false;
    if (analyseTimer.current) { clearInterval(analyseTimer.current); analyseTimer.current = null; }
    camStream.current?.getTracks().forEach(t => t.stop());
    camStream.current = null;
  }, []);

  const startStream = useCallback(async () => {
    stopStream();
    try {
      if (!cocoModel.current) {
        setStatusKey('Please wait…'); setStatusCls('warn');
        let tries = 0;
        while (!cocoModel.current && tries < 30) { await new Promise(r => setTimeout(r, 300)); tries++; }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode.current, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      camStream.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          camReady.current = true;
          setStatusKey('searching'); setStatusCls('warn');
          if (analyseTimer.current) clearInterval(analyseTimer.current);
          analyseTimer.current = setInterval(analyseFrame, 250);
        };
      }
    } catch (err) { setStatusKey('Camera access denied'); setStatusCls('bad'); }
  }, [stopStream]); // eslint-disable-line

  const openCamera = () => {
    smoothFrame.current = { x:0, y:0, w:0, h:0, active:false };
    perfectCount.current = 0; prevGuide.current = 'searching'; badFrames.current = 0;
    setIsManualMode(false); setCdShow(false); setStatusKey('searching'); setStatusCls('warn');
    setCameraOpen(true);
  };

  useEffect(() => {
    if (cameraOpen) startStream();
    return () => { if (!cameraOpen) stopStream(); };
  }, [cameraOpen]); // eslint-disable-line

  const closeCamera = () => { stopStream(); clearCountdown(); setCameraOpen(false); setCapturePreview(null); };

  const flipCamera = () => {
    facingMode.current = facingMode.current === 'environment' ? 'user' : 'environment';
    startStream();
  };

  /* ─── Object detection ─── */
  const analyseFrame = async () => {
    if (!camReady.current || !cocoModel.current || isAnalysing.current || isManualMode) return;
    isAnalysing.current = true;
    const vid = videoRef.current;
    const overlay = overlayRef.current;
    if (!vid?.videoWidth || !overlay) { isAnalysing.current = false; return; }

    try {
      const predictions = await cocoModel.current.detect(vid);
      const objects = predictions.filter(p => p.class !== 'person' && p.score > 0.15);
      const vw = vid.videoWidth, vh = vid.videoHeight;
      const ow = overlay.clientWidth, oh = overlay.clientHeight;
      let newGuide = 'searching';

      if (objects.length > 0) {
        const mainObj = objects.reduce((best, o) => o.bbox[2]*o.bbox[3] > best.bbox[2]*best.bbox[3] ? o : best);
        const [bx, by, bw, bh] = mainObj.bbox;
        const scale = Math.max(ow/vw, oh/vh);
        const offX = (ow - vw*scale)/2, offY = (oh - vh*scale)/2;
        const sc = { x: bx*scale+offX, y: by*scale+offY, w: bw*scale, h: bh*scale };

        const padX = sc.w*FRAME_PAD_RATIO, padY = sc.h*FRAME_PAD_RATIO;
        let tx = sc.x-padX, ty = sc.y-padY, tw = sc.w+padX*2, th = sc.h+padY*2;
        if (tw < MIN_FRAME_SIZE) { tx -= (MIN_FRAME_SIZE-tw)/2; tw = MIN_FRAME_SIZE; }
        if (th < MIN_FRAME_SIZE) { ty -= (MIN_FRAME_SIZE-th)/2; th = MIN_FRAME_SIZE; }

        // Clamp
        const m = EDGE_MARGIN;
        tw = Math.min(tw, ow-m*2); th = Math.min(th, oh-m*2);
        tx = Math.max(m, Math.min(tx, ow-tw-m)); ty = Math.max(m, Math.min(ty, oh-th-m));

        const sf = smoothFrame.current;
        if (!sf.active) Object.assign(sf, { x:tx, y:ty, w:tw, h:th, active:true });
        else { sf.x=lerp(sf.x,tx,LERP_SPEED); sf.y=lerp(sf.y,ty,LERP_SPEED); sf.w=lerp(sf.w,tw,LERP_SPEED); sf.h=lerp(sf.h,th,LERP_SPEED); }

        const THRESH = Math.min(ow,oh)*0.15;
        const ox = (sc.x+sc.w/2)-(ow/2), oy = (sc.y+sc.h/2)-(oh/2);
        let dir = '';
        if (Math.abs(ox)>THRESH||Math.abs(oy)>THRESH) {
          if (oy<-THRESH) dir='down'; else if (oy>THRESH) dir='up';
          else if (ox<-THRESH) dir='right'; else dir='left';
        }
        const EDGE_PAD = 30;
        const clipped = sc.x<EDGE_PAD||sc.y<EDGE_PAD||sc.x+sc.w>ow-EDGE_PAD||sc.y+sc.h>oh-EDGE_PAD;

        if (clipped) { newGuide='back'; perfectCount.current=0; }
        else if (dir) { newGuide=dir; perfectCount.current=0; }
        else { perfectCount.current++; newGuide='perfect'; }
      } else {
        perfectCount.current=0; smoothFrame.current.active=false; newGuide='searching';
      }

      // Hysteresis
      if (GUIDE_RANK[newGuide] >= GUIDE_RANK[prevGuide.current]) {
        prevGuide.current = newGuide; badFrames.current = 0;
      } else {
        badFrames.current++;
        if (badFrames.current >= HYSTERESIS_FRAMES) { prevGuide.current = newGuide; badFrames.current = 0; }
        newGuide = prevGuide.current;
      }

      const cls = newGuide==='perfect' ? 'good' : newGuide==='searching' ? 'bad' : 'warn';
      setStatusKey(newGuide); setStatusCls(cls);
      if (newGuide==='perfect') startCountdown(); else clearCountdown();
    } catch (e) { /* ignore */ }
    isAnalysing.current = false;
  };

  /* ─── Countdown & capture ─── */
  const startCountdown = () => {
    if (countdownTimer.current) return;
    setCdShow(true);
    countdownTimer.current = setTimeout(() => { countdownTimer.current = null; capturePhoto(); }, 800);
  };
  const clearCountdown = () => {
    if (countdownTimer.current) { clearTimeout(countdownTimer.current); countdownTimer.current = null; }
    setCdShow(false);
  };

  const capturePhoto = () => {
    if (!camReady.current) return;
    if (!isManualMode && perfectCount.current < PERFECT_FRAMES_NEEDED) return;
    clearCountdown();

    const vid = videoRef.current;
    const overlay = overlayRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const vw = vid.videoWidth, vh = vid.videoHeight;
    const ow = overlay.clientWidth, oh = overlay.clientHeight;
    const scale = Math.max(ow/vw, oh/vh);
    const offX = (vw*scale-ow)/2, offY = (vh*scale-oh)/2;

    const sf = smoothFrame.current;
    const fr = sf.active && !isManualMode ? sf : { x: ow*0.1, y: oh*0.1, w: ow*0.8, h: oh*0.8 };
    const sx=(fr.x+offX)/scale, sy=(fr.y+offY)/scale, sw=fr.w/scale, sh=fr.h/scale;

    canvas.width = sw; canvas.height = sh;
    ctx.drawImage(vid, sx, sy, sw, sh, 0, 0, sw, sh);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    canvas.toBlob(blob => { capturedBlob.current = blob; }, 'image/jpeg', 0.92);
    setCapturePreview(dataUrl);
    stopStream();
    setCameraOpen(false);
  };

  const useCapture = () => {
    if (!capturedBlob.current) return;
    if (images.length >= 4) { alert('Max 4 images.'); setCapturePreview(null); return; }
    const file = new File([capturedBlob.current], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
    addFiles([file]);
    setCapturePreview(null);
    capturedBlob.current = null;
  };
  const retakePhoto = () => {
    capturedBlob.current = null;
    smoothFrame.current = { x:0, y:0, w:0, h:0, active:false };
    perfectCount.current = 0;
    setCapturePreview(null);
    openCamera();
  };

  /* ─── Loading screen timer ─── */
  const startLoadingTimer = () => {
    startTimeRef.current = Date.now();
    setElapsed(0); setProgress(0); setProgressText('Starting...');
    let msgIndex = 0;
    loadMsgRef.current = setInterval(() => {
      msgIndex++;
      if (msgIndex < LOADING_MSGS.length) setLoadingMsg(LOADING_MSGS[msgIndex]);
    }, 4000);
    loadTimerRef.current = setInterval(() => {
      const sec = (Date.now() - startTimeRef.current) / 1000;
      setElapsed(Math.floor(sec));
      const pct = (1 - Math.exp(-sec / 18)) * 98;
      setProgress(pct);
      let mText = 'Starting...';
      for (const m of MILESTONES) { if (sec >= m.at) mText = m.text; }
      setProgressText(mText);
    }, 250);
  };

  const stopLoadingTimer = () => {
    if (loadTimerRef.current) { clearInterval(loadTimerRef.current); loadTimerRef.current = null; }
    if (loadMsgRef.current)   { clearInterval(loadMsgRef.current);   loadMsgRef.current   = null; }
  };

  /* ─── Submit ─── */
  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!skipImageUpload && images.length === 0) { alert('Please upload at least one image.'); return; }
    setLoadError(null); setLoadingMsg(LOADING_MSGS[0]);
    setIsProcessing(true);
    startLoadingTimer();

    try {
      const [uploadResult, generated] = await Promise.all([
        skipImageUpload ? Promise.resolve({ urls: [], tempMediaIds: [] }) : uploadImages(images, { enhance: imageEnhancements.join(',') || 'true' }),
        generateProductContent({
          ...formData,
          image_urls: '',
          product_name: formData.productName || '',
          brand: formData.brand || '',
          ean: formData.ean || '',
          category: formData.category || '',
          subcategory: formData.subcategory || '',
          unit: formData.unit || '',
          wholesale_qty: formData.wholesaleQty || '',
          price_wholesale: formData.priceWholesale || '',
          price_retail: formData.priceRetail || '',
          keepOriginalName: Boolean(keepOriginalName)
        })
      ]);

      setUploadedUrls(Array.isArray(uploadResult?.urls) ? uploadResult.urls : []);
      setUploadedTempMediaIds(Array.isArray(uploadResult?.tempMediaIds) ? uploadResult.tempMediaIds : []);
      // Snap progress to 100%
      setProgress(100); setProgressText('✅ Complete!');
      await new Promise(r => setTimeout(r, 600));

      setGeneratedContent({
        user_input: generated.user_input || formData,
        generated_content: {
          seo_title: generated.generated_content?.seo_title || formData.productName || '',
          overview: generated.generated_content?.overview || '',
          features: Array.isArray(generated.generated_content?.features) ? generated.generated_content.features : [],
          detailed_description: generated.generated_content?.detailed_description || '',
          specs: Array.isArray(generated.generated_content?.specs) ? generated.generated_content.specs : []
        }
      });
      stopLoadingTimer();
      onNext();
    } catch (err) {
      stopLoadingTimer();
      setLoadError(err.response?.data?.error || err.message || 'AI generation failed');
    }
  };

  const retrySubmit = () => {
    setLoadError(null); setProgress(0); setProgressText('Starting...'); setElapsed(0);
    handleSubmit();
  };

  const goBackFromLoading = () => {
    stopLoadingTimer(); setLoadError(null);
    setIsProcessing(false); setProgress(0);
  };

  /* ─── Computed camera frame styles ─── */
  const sf = smoothFrame.current;
  const frameStyle = cameraOpen && sf.active ? {
    position: 'absolute', left: sf.x, top: sf.y, width: sf.w, height: sf.h, transform: 'none'
  } : {};
  const guide = GUIDES[statusKey] || { text: statusKey, hint: '' };

  /* ═══════════════════════════════════════════════
     LOADING SCREEN
  ═══════════════════════════════════════════════ */
  if (isProcessing) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
        {!loadError ? (
          <>
            {/* Spinner */}
            <div style={{
              width: 60, height: 60, borderRadius: '50%',
              border: '4px solid rgba(14,30,55,0.1)',
              borderTop: '4px solid #0e1e37', borderRight: '4px solid #1a3055',
              animation: 'spin 1s linear infinite', margin: '0 auto 24px'
            }} />
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

            <div style={{ fontSize:'1.2rem', fontWeight:700, color:'#0e1e37', marginBottom: 8 }}>
              Generating Product Listing
            </div>
            <div style={{ color:'#6b7fa0', fontSize:'0.88rem', marginBottom: 6, minHeight: 24 }}>
              {loadingMsg}
            </div>
            <div style={{ fontSize:'1rem', fontWeight:700, color:'#0e1e37', marginBottom:18 }}>
              ⏱️ {elapsed}s
            </div>

            {/* Progress bar */}
            <div style={{ maxWidth: 320, margin: '0 auto' }}>
              <div style={{ height: 8, background:'rgba(14,30,55,0.08)', borderRadius: 8, overflow:'hidden' }}>
                <div style={{
                  height:'100%', borderRadius: 8, transition:'width 0.4s cubic-bezier(.4,0,.2,1)',
                  width: `${progress.toFixed(1)}%`,
                  background: progress >= 100
                    ? 'linear-gradient(90deg,#22c55e,#16a34a)'
                    : 'linear-gradient(90deg,#0e1e37,#1a3055,#22c55e)'
                }} />
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, fontSize:'0.75rem', color:'#6b7fa0' }}>
                <span>{progressText}</span>
                <span style={{ fontWeight:700, color:'#0e1e37' }}>{Math.floor(progress)}%</span>
              </div>
            </div>
            <div style={{ fontSize:'0.78rem', color:'#aab', marginTop:8 }}>
              Usually completes under 50 seconds
            </div>
          </>
        ) : (
          /* ─── Error state ─── */
          <>
            <div style={{ fontSize:'2rem', marginBottom:12 }}>⚠️</div>
            <div style={{ fontSize:'1.1rem', fontWeight:700, color:'#7f1d1d', marginBottom:8 }}>
              Something went wrong
            </div>
            <div style={{
              maxWidth:400, margin:'0 auto 16px',
              background:'#fef2f2', border:'1px solid #fecaca',
              borderRadius:12, padding:'16px 20px', color:'#991b1b',
              fontSize:'0.85rem', wordBreak:'break-word', textAlign:'left'
            }}>
              {loadError.length > 200 ? loadError.slice(0,200)+'...' : loadError}
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}>
              <button className="btn-primary" onClick={retrySubmit}>Retry</button>
              <button className="btn-secondary" onClick={goBackFromLoading}>← Edit Details</button>
            </div>
          </>
        )}
      </div>
    );
  }

  /* ═══════════════════════════════════════════════
     NORMAL UPLOAD FORM
  ═══════════════════════════════════════════════ */
  return (
    <div className="form-fade-in">
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
        <span style={{ fontSize:'1.5rem' }}>🖼️</span>
        <div>
          <div className="slide-title" style={{ margin:0 }}>Product Image</div>
          <div className="slide-sub" style={{ margin:0 }}>Upload a photo or capture one from your camera</div>
        </div>
      </div>

      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        background:'rgba(14,30,55,0.04)', border:'1px solid rgba(14,30,55,0.12)',
        borderRadius:12, padding:'10px 12px', marginBottom:14
      }}>
        <div style={{ color:'#1f2937', fontSize:'0.8rem', fontWeight:600 }}>
          Skip image for now
        </div>
        <button
          type="button"
          onClick={() => {
            setSkipImageUpload(prev => {
              const next = !prev;
              if (next) {
                setImages([]);
                closeCamera();
              }
              return next;
            });
          }}
          style={{
            width:44, height:24, borderRadius:999, border:'none', cursor:'pointer',
            background: skipImageUpload ? '#22c55e' : 'rgba(14,30,55,0.22)',
            position:'relative', transition:'background 0.2s ease'
          }}
          aria-label="Skip image upload"
          aria-pressed={skipImageUpload}
        >
          <span style={{
            position:'absolute', top:3, left: skipImageUpload ? 23 : 3,
            width:18, height:18, borderRadius:'50%', background:'#fff',
            transition:'left 0.2s ease', boxShadow:'0 1px 3px rgba(0,0,0,0.25)'
          }} />
        </button>
      </div>

      {/* Upload zone */}
      {!skipImageUpload && images.length < 4 && (
        <div className="upload-zone" style={{ marginBottom:12, position:'relative', overflow:'hidden' }}>
          <input type="file" multiple accept="image/*"
            onChange={e => addFiles(Array.from(e.target.files))}
            disabled={isPreparingImages || isProcessing}
            style={{ position:'absolute',inset:0,opacity:0,cursor:isPreparingImages || isProcessing ? 'not-allowed' : 'pointer',width:'100%',height:'100%' }}
          />
          <div style={{ fontSize:'2rem', marginBottom:8 }}>📁</div>
          <div style={{ color:'#6b7fa0', fontSize:'0.82rem' }}>
            <strong style={{ color:'#0e1e37' }}>Click to upload</strong> or drag &amp; drop<br />
            <em style={{ fontSize:'0.72rem' }}>PNG, JPG, WEBP — max 5MB (up to 4 images)</em>
          </div>
          {(isPreparingImages || isProcessing) && (
            <div style={{
              position:'absolute', inset:0, background:'linear-gradient(135deg, rgba(255,255,255,0.85), rgba(236,242,255,0.92))',
              backdropFilter:'blur(3px)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
              gap:12, textAlign:'center'
            }}>
              <div style={{
                width:44, height:44, borderRadius:'50%', border:'4px solid rgba(14,30,55,0.12)',
                borderTop:'4px solid #0e1e37', animation:'spin 0.9s linear infinite'
              }} />
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              <div style={{ fontSize:'0.9rem', fontWeight:700, color:'#0e1e37' }}>
                {previewProgress.label || 'Preparing image previews…'}
              </div>
              <div style={{ fontSize:'0.76rem', color:'#6b7fa0' }}>
                {previewProgress.total > 0 ? `${previewProgress.done}/${previewProgress.total} ready` : 'This only takes a moment'}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Camera button */}
      {!skipImageUpload && (
      <button type="button" onClick={openCamera} style={{
        width:'100%', padding:'0.9rem 1.2rem',
        background:'linear-gradient(135deg,#1a2f52,#0e1e37)',
        border:'1.5px dashed rgba(100,180,255,0.4)', borderRadius:14,
        color:'rgba(255,255,255,0.85)', fontFamily:'inherit', fontSize:'0.88rem', fontWeight:600,
        cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10,
        transition:'all 0.25s', marginBottom:16
      }}>
        <span style={{ fontSize:'1.3rem' }}>📸</span> Capture from Camera
      </button>
      )}

      {skipImageUpload && (
        <div style={{
          background:'#ecfeff', border:'1px solid #a5f3fc', color:'#0f766e',
          borderRadius:12, padding:'10px 12px', marginBottom:16, fontSize:'0.78rem', fontWeight:600
        }}>
          Image upload skipped. Empty image URLs will be saved for this product.
        </div>
      )}

      {/* Image previews */}
      {!skipImageUpload && images.length > 0 && (
        <div style={{ border:'1.5px solid rgba(14,30,55,0.13)', borderRadius:12, background:'white', padding:12, marginBottom:16 }}>
          {isPreparingImages && (
            <div style={{
              display:'flex', alignItems:'center', gap:12, padding:'10px 12px', marginBottom:12,
              borderRadius:12, background:'linear-gradient(135deg, rgba(14,30,55,0.04), rgba(59,130,246,0.08))',
              border:'1px solid rgba(14,30,55,0.08)'
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', border:'3px solid rgba(14,30,55,0.14)', borderTop:'3px solid #0e1e37', animation:'spin 0.9s linear infinite' }} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'0.85rem', fontWeight:700, color:'#0e1e37' }}>Image preview loading</div>
                <div style={{ fontSize:'0.74rem', color:'#6b7fa0' }}>Optimizing previews before upload</div>
              </div>
            </div>
          )}
          {images.map((img, idx) => {
            const isEnhanced = imageEnhancements[idx] === true;
            return (
              <div key={idx} style={{ display:'flex', alignItems:'center', gap:14, paddingBottom:10, marginBottom:idx < images.length-1 ? 10 : 0, borderBottom: idx < images.length-1 ? '1px solid rgba(14,30,55,0.08)':' none' }}>
                <img src={URL.createObjectURL(img)} alt="" style={{ width:64, height:64, objectFit:'cover', borderRadius:8 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:'0.85rem', fontWeight:600 }}>{img.name}</div>
                  <div style={{ fontSize:'0.72rem', color:'#6b7fa0' }}>{(img.size/1024).toFixed(1)} KB</div>
                </div>
                
                {/* Individual Sparkle Enhance Toggle */}
                <button
                  type="button"
                  onClick={() => {
                    setImageEnhancements(prev => {
                      const next = [...prev];
                      next[idx] = !prev[idx];
                      return next;
                    });
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    border: `1.5px solid ${isEnhanced ? '#4f46e5' : 'rgba(14,30,55,0.13)'}`,
                    background: isEnhanced ? 'rgba(99, 102, 241, 0.08)' : 'none',
                    color: isEnhanced ? '#4f46e5' : '#9ca3af',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                  title={isEnhanced ? "AI Image Enhancement: ON (Click to turn off)" : "AI Image Enhancement: OFF (Click to turn on)"}
                >
                  <SparkleIcon active={isEnhanced} className="w-3.5 h-3.5" />
                </button>

                <button onClick={() => removeImage(idx)} style={{
                  background:'none', border:'1.5px solid rgba(14,30,55,0.13)',
                  borderRadius:8, width:30, height:30, cursor:'pointer',
                  color:'#ef4444', fontSize:'0.9rem'
                }}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      {/* AI Options Settings */}
      <div style={{
        background: 'rgba(99, 102, 241, 0.05)',
        border: '1px dashed rgba(99, 102, 241, 0.25)',
        borderRadius: 14,
        padding: '12px 14px',
        marginBottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10
      }}>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#4f46e5', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>✨</span> AI Custom Options
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 600, color: '#374151', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={keepOriginalName}
              onChange={(e) => setKeepOriginalName(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#4f46e5' }}
            />
            Keep original Product Name (Disable AI Title)
          </label>
        </div>
      </div>

      {/* Nav buttons */}
      <div style={{ display:'flex', gap:12, marginTop:8, flexWrap:'wrap' }}>
        <button type="button" className="btn-secondary" onClick={onBack} disabled={isPreparingImages || isProcessing}>← Back</button>
        <button type="button" className="btn-primary accent" onClick={handleSubmit} disabled={isPreparingImages || isProcessing}>
          {isPreparingImages ? 'Preparing previews…' : 'Generate AI Listing ✨'}
        </button>
      </div>

      {/* ═══ CAMERA OVERLAY ═══ */}
      {cameraOpen && (
        <div ref={overlayRef} style={{
          position:'fixed', inset:0, zIndex:9999, background:'#000', display:'flex', flexDirection:'column'
        }}>
          <video ref={videoRef} autoPlay playsInline muted
            style={{ width:'100%', height:'100%', objectFit:'cover', position:'absolute', inset:0 }} />
          <canvas ref={canvasRef} style={{ display:'none' }} />

          {/* Close button */}
          <button onClick={closeCamera} style={{
            position:'absolute', top:58, right:18, zIndex:10,
            background:'rgba(0,0,0,0.5)', border:'1px solid rgba(255,255,255,0.2)',
            borderRadius:'50%', width:36, height:36, color:'white', fontSize:'1rem',
            cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(4px)'
          }}>✕</button>

          {/* Status pill + hint */}
          <div style={{
            position:'absolute', top:0, left:0, right:0,
            padding:'20px 20px 16px',
            background:'linear-gradient(to bottom,rgba(0,0,0,0.8),transparent)',
            display:'flex', flexDirection:'column', alignItems:'center', gap:10, zIndex:2
          }}>
            <div style={{
              display:'inline-flex', alignItems:'center', gap:10,
              background: statusCls==='good' ? 'rgba(22,163,74,0.85)' : statusCls==='bad' ? 'rgba(185,28,28,0.85)' : 'rgba(202,138,4,0.85)',
              border: `1.5px solid ${statusCls==='good' ? 'rgba(34,197,94,0.7)' : statusCls==='bad' ? 'rgba(239,68,68,0.7)' : 'rgba(234,179,8,0.7)'}`,
              borderRadius:999, padding:'10px 24px', fontSize:'1rem', fontWeight:700, color:'#fff',
              backdropFilter:'blur(8px)'
            }}>
              <div style={{ width:10, height:10, borderRadius:'50%', background:'currentColor', animation:'pulseDot 1.2s ease-in-out infinite' }}/>
              <style>{`@keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}`}</style>
              <span>{guide.text}</span>
            </div>
            <div style={{ fontSize:'0.88rem', color:'rgba(255,255,255,0.88)', fontWeight:500, textShadow:'0 1px 4px rgba(0,0,0,0.6)' }}>
              {guide.hint}
            </div>
          </div>

          {/* Detection frame */}
          <div style={{ position:'absolute', inset:0, zIndex:2, pointerEvents:'none' }}>
            <div style={{
              position:'absolute',
              left: sf.active ? sf.x : '50%', top: sf.active ? sf.y : '50%',
              width: sf.active ? sf.w : 'min(68vw,280px)', height: sf.active ? sf.h : 'min(68vw,280px)',
              transform: sf.active ? 'none' : 'translate(-50%,-50%)',
              transition:'width 0.18s,height 0.18s,left 0.18s,top 0.18s',
              boxShadow: statusKey==='perfect' ? '0 0 0 2px rgba(52,211,153,0.6),0 0 28px rgba(52,211,153,0.35)' : 'none'
            }}>
              {/* Corner brackets */}
              {[
                { top:0,left:0, borderWidth:'3px 0 0 3px', borderRadius:'5px 0 0 0' },
                { top:0,right:0, borderWidth:'3px 3px 0 0', borderRadius:'0 5px 0 0' },
                { bottom:0,left:0, borderWidth:'0 0 3px 3px', borderRadius:'0 0 0 5px' },
                { bottom:0,right:0, borderWidth:'0 3px 3px 0', borderRadius:'0 0 5px 0' }
              ].map((s,i) => (
                <div key={i} style={{
                  position:'absolute', borderColor: statusKey==='perfect' ? 'rgba(52,211,153,1)' : 'rgba(100,200,255,0.88)',
                  borderStyle:'solid', ...s,
                  width:'clamp(18px,24%,52px)', height:'clamp(18px,24%,52px)',
                  filter: statusKey==='perfect' ? 'drop-shadow(0 0 8px rgba(52,211,153,0.9))' : 'none',
                  transition:'border-color 0.25s,filter 0.25s'
                }}/>
              ))}
              {/* Scan line */}
              <div style={{
                position:'absolute', left:6, right:6, height:2,
                background:`linear-gradient(90deg,transparent,${statusKey==='perfect' ? 'rgba(52,211,153,0.9)' : 'rgba(100,200,255,0.75)'},transparent)`,
                animation:'scanline 2s ease-in-out infinite', borderRadius:2
              }}/>
              <style>{`@keyframes scanline{0%{top:6px;opacity:.9}100%{top:calc(100% - 8px);opacity:.15}}`}</style>
              {/* Countdown tick */}
              {cdShow && (
                <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center' }}>
                  <div style={{ fontSize:'4rem',fontWeight:800,color:'rgba(255,255,255,0.95)',textShadow:'0 0 24px rgba(52,211,153,0.9)' }}>✓</div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom controls */}
          <div style={{
            position:'absolute', bottom:0, left:0, right:0,
            padding:'20px 24px 36px',
            background:'linear-gradient(to top,rgba(0,0,0,0.8),transparent)',
            display:'flex', alignItems:'center', justifyContent:'center', gap:24, zIndex:2
          }}>
            {/* Flip */}
            <button onClick={flipCamera} style={{
              background:'rgba(0,0,0,0.5)', border:'1px solid rgba(255,255,255,0.2)',
              borderRadius:'50%', width:46, height:46, color:'white', fontSize:'1.2rem',
              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
              backdropFilter:'blur(4px)'
            }}>🔄</button>
            {/* Shutter */}
            <button onClick={capturePhoto} style={{
              width:68, height:68, borderRadius:'50%', background:'white',
              border:'4px solid rgba(255,255,255,0.3)', cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'1.6rem', boxShadow:'0 0 0 6px rgba(255,255,255,0.15)'
            }}>📸</button>
            {/* Manual toggle */}
            <button onClick={() => {
              const next = !isManualMode;
              setIsManualMode(next);
              perfectCount.current = 0;
              if (next) { clearCountdown(); setStatusKey('manual'); setStatusCls('good'); }
              else { setStatusKey('searching'); setStatusCls('warn'); }
            }} style={{
              background: isManualMode ? 'rgba(59,130,246,0.85)' : 'rgba(0,0,0,0.5)',
              border:`1px solid ${isManualMode ? 'rgba(96,165,250,0.8)' : 'rgba(255,255,255,0.2)'}`,
              borderRadius:999, padding:'8px 16px', color:'white',
              fontSize:'0.85rem', fontWeight:600, cursor:'pointer',
              display:'flex', alignItems:'center', gap:8, backdropFilter:'blur(4px)'
            }}>
              <span style={{ fontSize:'1.1rem' }}>{isManualMode ? '🤖' : '🎯'}</span>
              {isManualMode ? 'Auto' : 'Manual'}
            </button>
          </div>
        </div>
      )}

      {/* ═══ CAPTURE PREVIEW MODAL ═══ */}
      {capturePreview && (
        <div style={{
          position:'fixed', inset:0, zIndex:10000,
          background:'rgba(0,0,0,0.96)', display:'flex',
          flexDirection:'column', alignItems:'center', justifyContent:'center'
        }}>
          <div style={{ width:'100%', maxWidth:480, display:'flex', flexDirection:'column', alignItems:'center', padding:'0 12px' }}>
            <div style={{ width:'100%', padding:'18px 20px 14px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ color:'#fff', fontSize:'1.1rem', fontWeight:700 }}>Preview Capture</span>
              <button onClick={retakePhoto} style={{ background:'rgba(255,255,255,0.12)', border:'none', borderRadius:'50%', width:36, height:36, color:'#fff', fontSize:'1rem', cursor:'pointer' }}>✕</button>
            </div>
            <div style={{ position:'relative', width:'100%', background:'#000' }}>
              <img src={capturePreview} alt="capture preview" style={{ width:'100%', display:'block', maxHeight:'60vh', objectFit:'contain', borderRadius:8 }} />
            </div>
            <div style={{ width:'100%', padding:20, display:'flex', gap:12 }}>
              <button onClick={retakePhoto} style={{
                flex:1, padding:12, borderRadius:14,
                background:'rgba(255,255,255,0.1)', border:'1.5px solid rgba(255,255,255,0.2)',
                color:'#fff', fontSize:'0.9rem', fontWeight:600, cursor:'pointer',
                fontFamily:'inherit'
              }}>🔄 Retake</button>
              <button onClick={useCapture} style={{
                flex:2, padding:12, borderRadius:14,
                background:'linear-gradient(135deg,#22c55e,#16a34a)', border:'none',
                color:'#fff', fontSize:'0.9rem', fontWeight:700, cursor:'pointer',
                boxShadow:'0 4px 20px rgba(34,197,94,0.4)', fontFamily:'inherit'
              }}>✅ Use Photo</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
