/**
 * OBSCURA — CINEMATIC FRAME ENGINE v4
 * ═══════════════════════════════════════════════════════════════
 *
 * THE DEFINITIVE SOLUTION TO VIDEO SCRUB LAG
 * ───────────────────────────────────────────
 * video.currentTime seeking is ALWAYS slow. The browser must:
 *  1) Find the nearest I-frame (keyframe)
 *  2) Decode all delta frames up to the target time
 *  3) Upload the decoded frame to GPU memory
 * This pipeline takes 50–200ms. No amount of JS optimization
 * can eliminate this — it's inside the browser's C++ video decoder.
 *
 * THE FIX (what Apple actually does):
 * ───────────────────────────────────────────
 * During the loading phase, play the video through ONCE and
 * extract every frame as an ImageBitmap (a pre-decoded GPU texture).
 * After that, scroll interaction is:
 *
 *   scrollProgress → frameIndex → ctx.drawImage(frames[i])
 *
 * ctx.drawImage(ImageBitmap) is a GPU blit — takes ~0.1ms.
 * Zero seeking. Zero decode. Zero lag.
 *
 * CAPTURE STRATEGY
 * ───────────────────────────────────────────
 * Primary:  requestVideoFrameCallback + video playing at 4× speed
 *           → captures entire video in (duration / 4) seconds
 * Fallback: sequential seek + 'seeked' events (slower but universal)
 *
 * FRAME RATE: 24fps (cinema standard)
 * CAPTURE RES: 854×480 (480p — sharp enough, memory-efficient)
 * MEMORY: ~10s × 24fps = 240 frames × 854×480×4B ≈ 118MB GPU
 *         GPU memory handles this comfortably on modern hardware.
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ═══════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════ */
const CFG = {
  CAPTURE_FPS: 24,      // frames to extract per second of video
  CAPTURE_W: 854,     // extraction width (480p widescreen)
  CAPTURE_H: 480,     // extraction height
  CAPTURE_SPEED: 4,       // playback rate during extraction phase
  SCROLL_VH: 3.5,     // scroll zone height multiplier
  DISPLAY_LERP: 0.45,    // frame-index lerp (0=instant, 1=frozen)
  MAX_DPR: 2,       // device pixel ratio cap
};

/* ═══════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════ */
let frames = [];   // Array<ImageBitmap> — pre-decoded GPU textures
let framesReady = false;
let rawScrollY = 0;    // Updated by native scroll listener
let displayIdx = 0;    // Lerped frame index (for smooth transitions)
let ctx, cssW, cssH;      // Canvas context + CSS dimensions

/* ═══════════════════════════════════════════════════════
   DOM ELEMENTS
   ═══════════════════════════════════════════════════════ */
const $video = document.getElementById('heroVideo');
const $canvas = document.getElementById('heroCanvas');
const $loader = document.getElementById('preloader');
const $fill = document.getElementById('preloaderFill');
const $label = document.getElementById('preloaderLabel');
const $nav = document.getElementById('nav');
const $hero = document.getElementById('heroContent');
const $cue = document.getElementById('scrollCue');

/* iOS detection — canvas.drawImage(video) is blocked on iOS */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

/* ═══════════════════════════════════════════════════════
   CANVAS — setup, resize, draw
   ═══════════════════════════════════════════════════════ */
function setupCanvas() {
  ctx = $canvas.getContext('2d', {
    alpha: false,  // No alpha compositing cost
    desynchronized: true,   // Async GPU upload — reduces frame latency
    willReadFrequently: false,
  });
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas, { passive: true });
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, CFG.MAX_DPR);
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  $canvas.width = Math.round(cssW * dpr);
  $canvas.height = Math.round(cssH * dpr);
  $canvas.style.width = cssW + 'px';
  $canvas.style.height = cssH + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  /* Redraw current frame at new size using cover-fit */
  if (framesReady && frames.length > 0) {
    coverDraw(frames[Math.max(0, Math.min(frames.length - 1, Math.round(displayIdx)))]);
  }
}

/* ──────────────────────────────────────────────────────
   Draw a frame with cover-fit — equivalent to CSS object-fit: cover.
   The bitmap is scaled to fill the canvas on BOTH axes, centered,
   with edges cropped as needed. Preserves aspect ratio on every
   screen size (portrait mobile, landscape tablet, ultrawide desktop).
   ────────────────────────────────────────────────────── */
function coverDraw(bmp) {
  /* Bitmap dimensions (physical px from capture canvas) */
  const bW = bmp.width;
  const bH = bmp.height;

  /* Canvas drawing area in CSS pixels (ctx is already DPR-scaled) */
  const cW = cssW;
  const cH = cssH;

  /* Scale factor: use whichever axis needs to grow MORE to cover canvas */
  const scale = Math.max(cW / bW, cH / bH);
  const drawW = bW * scale;
  const drawH = bH * scale;

  /* Center — negative offset crops the overflow edges */
  const drawX = (cW - drawW) / 2;
  const drawY = (cH - drawH) / 2;

  ctx.drawImage(bmp, drawX, drawY, drawW, drawH);
}

/* Draw a specific frame index with cover-fit */
function drawFrameAt(idx) {
  if (!framesReady || !frames.length) return;
  const i = Math.max(0, Math.min(frames.length - 1, Math.round(idx)));
  coverDraw(frames[i]);
}

/* ═══════════════════════════════════════════════════════
   FRAME CAPTURE — primary method (fast, using rVFC)
   Plays video at 4× speed and captures a frame every
   (1/CAPTURE_FPS) seconds into an ImageBitmap GPU texture.
   Uses the 'ended' event as the definitive stop signal so
   the video ALWAYS plays to its natural end — no frames missed.
   ═══════════════════════════════════════════════════════ */
function captureViaRVFC(capCanvas, capCtx) {
  return new Promise(async (resolve, reject) => {
    const interval = 1 / CFG.CAPTURE_FPS;
    const bitmapJobs = [];  // Promises<ImageBitmap>
    let lastCapturedT = -interval;
    let done = false;

    /* Single finish handler — called by 'ended' event */
    const finish = () => {
      if (done) return;
      done = true;

      /* Always capture the very last frame before resolving */
      capCtx.drawImage($video, 0, 0, CFG.CAPTURE_W, CFG.CAPTURE_H);
      bitmapJobs.push(createImageBitmap(capCanvas));

      $video.pause();
      $video.currentTime = 0;
      $video.playbackRate = 1;

      setProgress(85);
      setLabel('Preparing frames…');

      Promise.all(bitmapJobs).then(resolve).catch(reject);
    };

    /* 'ended' is the definitive signal — fires when video hits its end */
    $video.addEventListener('ended', finish, { once: true });

    $video.currentTime = 0;
    $video.playbackRate = CFG.CAPTURE_SPEED;

    try {
      await $video.play();
    } catch (_) {
      /* Autoplay blocked — fall back to seek-based capture */
      $video.removeEventListener('ended', finish);
      return captureViaSeek(capCanvas, capCtx).then(resolve).catch(reject);
    }

    function onFrame() {
      if (done) return;

      const t = $video.currentTime;
      const dur = $video.duration;

      /* Capture a frame every (interval) seconds of video time */
      if (t - lastCapturedT >= interval) {
        lastCapturedT = t;
        capCtx.drawImage($video, 0, 0, CFG.CAPTURE_W, CFG.CAPTURE_H);
        bitmapJobs.push(createImageBitmap(capCanvas));
        setProgress(Math.round((t / dur) * 78));
      }

      /* Keep registering until 'ended' fires naturally */
      if (!done) {
        $video.requestVideoFrameCallback(onFrame);
      }
    }

    $video.requestVideoFrameCallback(onFrame);
  });
}

/* ═══════════════════════════════════════════════════════
   FRAME CAPTURE — fallback (seek-based, works everywhere)
   Seeks to each frame time and waits for 'seeked'.
   Uses <= total + clamp so the final frame at video.duration
   is always captured.
   ═══════════════════════════════════════════════════════ */
async function captureViaSeek(capCanvas, capCtx) {
  const dur = $video.duration;
  const total = Math.ceil(dur * CFG.CAPTURE_FPS);
  const bitmaps = [];

  for (let i = 0; i <= total; i++) {
    /* Clamp the final seek to exactly video.duration */
    const t = Math.min(i / CFG.CAPTURE_FPS, dur);

    $video.currentTime = t;
    await new Promise((res) => {
      $video.addEventListener('seeked', res, { once: true });
    });

    capCtx.drawImage($video, 0, 0, CFG.CAPTURE_W, CFG.CAPTURE_H);
    bitmaps.push(await createImageBitmap(capCanvas));

    setProgress(Math.round((i / total) * 82));

    /* Stop after we've captured the true last frame */
    if (t >= dur) break;
  }

  return bitmaps;
}

/* ═══════════════════════════════════════════════════════
   MAIN CAPTURE ORCHESTRATOR
   ═══════════════════════════════════════════════════════ */
async function extractFrames() {
  // Determine capture canvas height preserving video's aspect ratio
  const aspectH = $video.videoHeight && $video.videoWidth
    ? Math.round(CFG.CAPTURE_W * ($video.videoHeight / $video.videoWidth))
    : CFG.CAPTURE_H;

  const capCanvas = document.createElement('canvas');
  capCanvas.width = CFG.CAPTURE_W;
  capCanvas.height = aspectH;
  const capCtx = capCanvas.getContext('2d');

  const hasRVFC = typeof $video.requestVideoFrameCallback === 'function';

  setLabel('Rendering cinematic frames…');

  let extracted;
  if (hasRVFC) {
    extracted = await captureViaRVFC(capCanvas, capCtx);
  } else {
    extracted = await captureViaSeek(capCanvas, capCtx);
  }

  // Reset video state (it was playing during capture)
  $video.pause();
  $video.currentTime = 0;
  $video.playbackRate = 1;

  return extracted;
}

/* ═══════════════════════════════════════════════════════
   MAIN rAF LOOP — zero seeking, pure array lookup
   ═══════════════════════════════════════════════════════ */
function startRenderLoop() {
  const maxIdx = frames.length - 1;

  function loop() {
    requestAnimationFrame(loop);
    if (!framesReady || !frames.length) return;

    // Scroll → target frame index (direct, no lerp on target)
    const scrubDist = window.innerHeight * CFG.SCROLL_VH;
    const progress = Math.max(0, Math.min(1, rawScrollY / scrubDist));
    const targetIdx = progress * maxIdx;

    // Lerp display index for buttery smooth transitions between frames
    const diff = targetIdx - displayIdx;
    if (Math.abs(diff) > 0.01) {
      displayIdx += diff * CFG.DISPLAY_LERP;
    } else {
      displayIdx = targetIdx; // Snap when very close
    }

    // Draw — this is a GPU blit, ~0.1ms. Zero lag.
    drawFrameAt(displayIdx);
  }

  requestAnimationFrame(loop);
}

/* ═══════════════════════════════════════════════════════
   NATIVE SCROLL — passive listener, zero main-thread cost
   ═══════════════════════════════════════════════════════ */
function initScroll() {
  window.addEventListener('scroll', () => {
    rawScrollY = window.scrollY;
    updateNav();
    updateCue();
    updateHeroFade();
  }, { passive: true });
}

/* ═══════════════════════════════════════════════════════
   UI STATE — instant updates, no lerp
   ═══════════════════════════════════════════════════════ */
function updateNav() {
  if (!$nav) return;
  $nav.classList.toggle('nav--scrolled', rawScrollY > 50);
}

function updateCue() {
  if (!$cue) return;
  $cue.classList.toggle('is-gone', rawScrollY > 70);
}

function updateHeroFade() {
  if (!$hero) return;
  const fadeEnd = window.innerHeight * 0.38;
  const p = Math.min(1, rawScrollY / fadeEnd);
  $hero.style.opacity = (1 - p).toFixed(3);
  $hero.style.transform = `translateY(${(-p * 36).toFixed(1)}px)`;
}

/* ═══════════════════════════════════════════════════════
   iOS FALLBACK — canvas-from-video is blocked on iOS.
   Show video element directly with currentTime control.
   ═══════════════════════════════════════════════════════ */
function initIOSMode() {
  // Canvas can't receive video frames on iOS — show video instead
  $canvas.style.display = 'none';

  // Remove the off-screen hiding class (top:-9999px; left:-9999px; contain:strict)
  // so there is no CSS conflict when we position the video on screen.
  $video.classList.remove('hero__video-source');

  Object.assign($video.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center center',
    opacity: '1',
    zIndex: '1',
  });

  // Direct currentTime control (no canvas pipeline)
  let curT = 0, tgtT = 0;

  function iosLoop() {
    requestAnimationFrame(iosLoop);
    if (!framesReady) return;
    const prog = Math.max(0, Math.min(1, rawScrollY / (window.innerHeight * CFG.SCROLL_VH)));
    tgtT = prog * $video.duration;
    const d = tgtT - curT;
    if (Math.abs(d) > 0.016) {
      curT += d * 0.12;
      try { $video.currentTime = curT; } catch (_) { }
    }
  }
  iosLoop();
}

/* ═══════════════════════════════════════════════════════
   ANIMATED CANVAS FALLBACK (no video file)
   ═══════════════════════════════════════════════════════ */
function startAtmosphereFallback() {
  let t = 0;
  function draw() {
    requestAnimationFrame(draw);
    t += 0.012;
    const w = cssW, h = cssH;

    ctx.fillStyle = '#040302';
    ctx.fillRect(0, 0, w, h);

    const p = 0.5 + 0.5 * Math.sin(t * 0.38);
    const g1 = ctx.createRadialGradient(w * .5, h * .55, 0, w * .5, h * .55, w * .52);
    g1.addColorStop(0, `rgba(200,134,10,${(.07 + p * .04).toFixed(3)})`);
    g1.addColorStop(.5, `rgba(43,31,20,${(.18 + p * .05).toFixed(3)})`);
    g1.addColorStop(1, 'rgba(4,3,2,0)');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h);

    const g2 = ctx.createRadialGradient(w * .5, h * .5, 0, w * .5, h * .5, w * .2);
    g2.addColorStop(0, `rgba(212,168,67,${(.04 + p * .03).toFixed(3)})`);
    g2.addColorStop(1, 'rgba(4,3,2,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < 3; i++) {
      const sx = w * (.41 + i * .09), ph = t + i * 1.6;
      ctx.beginPath();
      ctx.moveTo(sx, h * .52);
      ctx.bezierCurveTo(sx + 9 * Math.sin(ph), h * .43, sx - 7 * Math.sin(ph + 1), h * .35, sx + 6 * Math.sin(ph + 2), h * .26);
      ctx.strokeStyle = `rgba(212,168,67,${(.05 + p * .04).toFixed(3)})`;
      ctx.lineWidth = .9; ctx.stroke();
    }
    for (let i = 0; i < 14; i++) {
      const px = w * (.15 + .7 * ((i * .139 + t * .009) % 1));
      const py = h * (.25 + .5 * Math.abs(Math.sin(t * .28 + i)));
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,134,10,${(.055 * Math.abs(Math.sin(t * .45 + i * .9))).toFixed(3)})`;
      ctx.fill();
    }
  }
  draw();
}

/* ═══════════════════════════════════════════════════════
   PRELOADER UI
   ═══════════════════════════════════════════════════════ */
function setProgress(pct) {
  if ($fill) $fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
}
function setLabel(txt) {
  if ($label) $label.textContent = txt;
}
function hideLoader() {
  return new Promise((res) => {
    setProgress(100);
    setLabel('Ready');
    setTimeout(() => {
      if ($loader) $loader.classList.add('is-done');
      setTimeout(res, 920);
    }, 250);
  });
}

/* ═══════════════════════════════════════════════════════
   SCROLL REVEALS (GSAP)
   ═══════════════════════════════════════════════════════ */
function initReveals() {
  const tryGSAP = () => {
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
      return setTimeout(tryGSAP, 60);
    }
    gsap.registerPlugin(ScrollTrigger);

    document.querySelectorAll('.reveal').forEach((el) => {
      ScrollTrigger.create({
        trigger: el, start: 'top 88%',
        onEnter: () => el.classList.add('is-in'),
      });
    });

    const story = document.querySelector('.story');
    if (story) {
      gsap.to('.story__ambient-l', { yPercent: -16, ease: 'none', scrollTrigger: { trigger: story, start: 'top bottom', end: 'bottom top', scrub: 1.5 } });
      gsap.to('.story__ambient-r', { yPercent: 12, ease: 'none', scrollTrigger: { trigger: story, start: 'top bottom', end: 'bottom top', scrub: 1.5 } });
    }

    ScrollTrigger.refresh();
  };
  tryGSAP();

  // IO fallback (fires immediately, GSAP overrides when ready)
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
  }, { threshold: 0.12, rootMargin: '0px 0px -48px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

/* ═══════════════════════════════════════════════════════
   CURSOR GLOW
   ═══════════════════════════════════════════════════════ */
function initCursorGlow() {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:300px;border-radius:50%;pointer-events:none;z-index:18;background:radial-gradient(circle,rgba(200,134,10,.055) 0%,transparent 70%);will-change:transform;transform:translate(-50%,-50%)';
  document.body.appendChild(el);
  let cx = -999, cy = -999, tx = -999, ty = -999;
  window.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
  (function tick() {
    cx += (tx - cx) * 0.07; cy += (ty - cy) * 0.07;
    el.style.transform = `translate(${(cx - 150).toFixed(1)}px,${(cy - 150).toFixed(1)}px)`;
    requestAnimationFrame(tick);
  })();
}

/* ═══════════════════════════════════════════════════════
   MAGNETIC BUTTON
   ═══════════════════════════════════════════════════════ */
function initMagneticBtn() {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  document.querySelectorAll('.btn--primary').forEach((btn) => {
    btn.addEventListener('mousemove', (e) => {
      const r = btn.getBoundingClientRect();
      btn.style.transform = `translate(${((e.clientX - (r.left + r.width / 2)) * .2).toFixed(1)}px,${((e.clientY - (r.top + r.height / 2)) * .2).toFixed(1)}px)`;
    });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
  });
}

/* ═══════════════════════════════════════════════════════
   COUNT-UP STATS
   ═══════════════════════════════════════════════════════ */
function initCountUp() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      const el = entry.target, end = parseInt(el.dataset.target, 10), t0 = performance.now();
      (function tick(now) {
        const p = Math.min((now - t0) / 1500, 1);
        el.textContent = Math.round((1 - Math.pow(1 - p, 3)) * end).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = end.toLocaleString();
      })(t0);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('.story__stat-n[data-target]').forEach((el) => io.observe(el));
}

/* ═══════════════════════════════════════════════════════
   HERO INTRO
   ═══════════════════════════════════════════════════════ */
function playIntro() {
  setTimeout(() => $nav?.classList.add('is-in'), 200);
  setTimeout(() => $hero?.classList.add('is-in'), 580);
  setTimeout(() => $cue?.classList.add('is-in'), 1700);
}

/* ═══════════════════════════════════════════════════════
   BOOTSTRAP — main entry
   ═══════════════════════════════════════════════════════ */
async function bootstrap() {
  // Init canvas immediately
  if (!IS_IOS) setupCanvas();

  // Init native scroll listener
  initScroll();

  // Init non-blocking effects
  initCursorGlow();
  initMagneticBtn();
  initCountUp();

  // Show preloader activity
  setProgress(3);
  setLabel('Loading video…');

  try {
    // ── Step 1: Wait for video metadata ──────────────────
    await new Promise((resolve, reject) => {
      if ($video.readyState >= 1) { resolve(); return; }
      $video.addEventListener('loadedmetadata', resolve, { once: true });
      $video.addEventListener('error', reject, { once: true });
      $video.load();
    });

    setProgress(12);

    // ── Step 2: Extract frames ────────────────────────────
    if (IS_IOS) {
      // iOS: can't capture canvas from video — wait for playback-ready
      await new Promise((res) => {
        if ($video.readyState >= 3) { res(); return; }
        $video.addEventListener('canplay', res, { once: true });
      });
      framesReady = true; // Signal iOS loop it can use video.duration
      initIOSMode();

    } else {
      // Desktop/Android: pre-render all frames to ImageBitmap array
      frames = await extractFrames();
      framesReady = true;

      // Draw first frame immediately (before preloader hides)
      drawFrameAt(0);

      // Start the render loop
      startRenderLoop();
    }

  } catch (err) {
    console.warn('[Obscura] Video unavailable — canvas atmosphere fallback.', err);
    $video.removeAttribute('src');
    if (!IS_IOS) startAtmosphereFallback();
  }

  // ── Step 3: Hide preloader ──────────────────────────────
  setProgress(98);
  setLabel('Ready');
  await hideLoader();

  // ── Step 4: Reveals + intro ─────────────────────────────
  initReveals();
  playIntro();
}

/* Entry point */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
