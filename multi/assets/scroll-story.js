/* ============================================================
   2026 中国睡眠健康研究白皮书 · 滚动叙事引擎
   ------------------------------------------------------------
   这一层只做「滚动 → 视觉」的翻译，不改动任何数据结论：
   1. warp   首屏星空沿镜头推进，滚动越快拉得越长
   2. covers 整屏章节封面，粘性吸附，进度由滚动位置决定
   3. reveal 数据卡、数字、方格随滚动逐层点亮
   4. charts 每张图都按滚动进度生成"长到一半"的形态
   所有图表选项都由 build 函数按进度现算，不缓存半个状态，
   因此往回滚时图形会自然收回，而不是停在已完成的样子。
   ============================================================ */
(function () {
  'use strict';

  var SLP = {
    bg: '#0B0F26',
    fg: '#E8ECF4',
    card: '#141A36',
    muted: '#1E2555',
    mutedFg: '#9DA6CB',
    border: '#252D5A',
    primary: '#4F7DF7',
    secondary: '#7C5CFC',
    success: '#34D399',
    danger: '#F0475C',
    dangerLight: '#FF7A5C',
    pink: '#E48BC0'
  };

  var REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var NUM_FONT = '"DIN Alternate","Bahnschrift",-apple-system,"Helvetica Neue",system-ui,sans-serif';
  var SANS_FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,system-ui,sans-serif';
  var vh = window.innerHeight || 800;
  var vw = window.innerWidth || 1200;
  var lowPower = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || vw < 768;

  var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  var ease = function (t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  /* 把 [a,b] 上的位置映射成 0~1 的进度，超出区间就夹住 */
  var span = function (p, a, b) { return clamp((p - a) / (b - a || 1), 0, 1); };

  function hasECharts() { return typeof window.echarts !== 'undefined'; }

  /* 统一的 ECharts 入口：滚动驱动的重绘一律 0 时长，
     否则每次 setOption 都会自带一段动画，滚动会变得又黏又糊 */
  function safeSet(chart, option, fadeIn) {
    try {
      chart.setOption(option, { notMerge: true, lazyUpdate: false, silent: true });
    } catch (err) {
      chart.setOption(option, true);
    }
  }
  function initChart(dom, opts) {
    if (!hasECharts()) throw new Error('ECharts 未加载');
    var inst = window.echarts.init(dom, null, opts || { renderer: 'canvas' });
    inst.setOption({ animation: !REDUCE, animationDuration: 0, animationDurationUpdate: 0, animationEasingUpdate: 'linear' });
    return inst;
  }
  function chartBase() {
    return { backgroundColor: 'transparent', animation: false, textStyle: { fontFamily: SANS_FONT, color: SLP.mutedFg } };
  }
  function axisLine() { return { lineStyle: { color: SLP.border } }; }
  function splitLine(op) { return { lineStyle: { color: 'rgba(37,45,90,' + (op || .5) + ')' } }; }
  function tooltipBase(extra) {
    var t = { backgroundColor: 'rgba(26,32,64,.95)', borderColor: SLP.border, textStyle: { color: SLP.fg, fontFamily: SANS_FONT } };
    if (extra) for (var k in extra) t[k] = extra[k];
    return t;
  }
  function merged(parts) {
    var out = chartBase();
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p) for (var k in p) out[k] = p[k];
    }
    return out;
  }
  function gradientH(from, to) {
    return new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: from }, { offset: 1, color: to }]);
  }
  function gradientV(from, to) {
    return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: from }, { offset: 1, color: to }]);
  }

  /* 按延迟阈值把数据点逐个放出：
     给每个点算一个 0~1 的入场时刻，进度越过它才显示。
     散点、折线这类"逐点长出"的图都靠它。 */
  function revealByThreshold(items, p, delayFn) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (p + .001 >= delayFn(items[i], i)) out.push(items[i]);
    }
    return out;
  }

  /* 元素是否靠近视口：滚动循环里靠它跳过远端元素，
     避免每帧给几十个卡片取 getBoundingClientRect（那会强制重排）。 */
  function isNear(el, factor) {
    var rect = el.getBoundingClientRect();
    var f = factor || 1.2;
    return rect.bottom > -vh * .35 && rect.top < vh * (1 + f * .35);
  }

  /* ============================================================
     1. 曲速星空
     星星从纵深 z 处向观察者推进；滚动速度直接换算成推力，
     停住时只留轻微漂移，一滚动就拉成星轨 —— 这是首屏的主交互。
     ============================================================ */
  function initWarp() {
    var canvas = document.getElementById('warp-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var host = canvas.parentElement;
    var W = 1, H = 1, cx = 0, cy = 0, dpr = 1;
    var stars = [];
    /* 粒子数量按设备能力伸缩：低配机减半，视觉上几乎看不出差别 */
    var COUNT = lowPower ? 150 : 260;
    var thrust = 0;
    var lastPaint = 0;
    var visible = true;

    function makeStar(seedZ) {
      return {
        x: (Math.random() - .5) * 2,
        y: (Math.random() - .5) * 2,
        z: seedZ != null ? seedZ : Math.random(),
        size: Math.random() * .8 + .3,
        hue: Math.random()
      };
    }
    function resetStar(s) {
      s.x = (Math.random() - .5) * 2;
      s.y = (Math.random() - .5) * 2;
      s.z = 1;
      s.size = Math.random() * .8 + .3;
      s.hue = Math.random();
    }
    function resize() {
      /* 星空按 0.9 倍设备像素渲染，再由 CSS 拉回显示尺寸。
         星轨和光点都是软边图形，低分辨率下几乎看不出差别，
         但每帧的像素填充量只有原来的三分之一 —— 这是首屏最重的一笔开销。 */
      dpr = Math.min((window.devicePixelRatio || 1) * .9, 1.4);
      var rect = host.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W * .56;
      cy = H * .46;
    }

    function seed() {
      stars = [];
      for (var i = 0; i < COUNT; i++) stars.push(makeStar(0.04 + Math.random() * 0.96));
    }

    function draw(baseSpeed, now) {
      /* 帧率闸门：静止时 30fps 足够顺滑，滚动时放开到 60fps。
         首屏在最顶上，往下滚的过程中它本来就是"被推走"的，
         没必要为它持续满帧重绘。 */
      var minInterval = Math.abs(thrust) > .004 ? 12 : 26;
      if (now - lastPaint < minInterval) return;
      lastPaint = now;
      if (!visible) return;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      var focal = Math.min(W, H) * .62;
      var hardStop = baseSpeed > .006;
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var prevZ = s.z;
        s.z -= baseSpeed;
        if (s.z <= .02) { resetStar(s); continue; }
        var k = focal / s.z;
        var px = cx + s.x * k;
        var py = cy + s.y * k;
        if (px < -60 || px > W + 60 || py < -60 || py > H + 60) { resetStar(s); continue; }
        var prevK = focal / prevZ;
        var qx = cx + s.x * prevK;
        var qy = cy + s.y * prevK;
        var depth = 1 - s.z;
        var alpha = clamp(depth * depth * .95, 0, 1);
        var width = s.size * (0.6 + depth * 2.4);
        var color = s.hue > .82 ? '228,139,192' : (s.hue > .5 ? '196,206,255' : '255,255,255');
        /* 用 globalAlpha 代替逐粒子拼 rgba 字符串：字符串拼接在每帧几百次
           的循环里是很实在的开销，交给合成器做透明度更便宜。 */
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = 'rgb(' + color + ')';
        /* 星轨只在真正推进时画长线；缓漂时退化成圆点，省掉大量线段的描边 */
        if (hardStop) {
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(qx, qy);
          ctx.lineTo(px, py);
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgb(' + color + ')';
          ctx.fillRect(px - width * .5, py - width * .5, width, width);
        }
        if (depth > .62 && hardStop) {
          ctx.globalAlpha = alpha * .45;
          ctx.beginPath();
          ctx.arc(px, py, width * .8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgb(' + color + ')';
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    resize();
    seed();
    if (REDUCE) {
      draw(0.0009, 1e9);
      window.addEventListener('resize', function () { resize(); draw(0.0009, 1e9); }, { passive: true });
      return;
    }
    window.addEventListener('resize', function () { resize(); }, { passive: true });
    window.__warpState = {
      draw: draw,
      setVisible: function (v) { visible = v; },
      get thrust() { return thrust; },
      set thrust(v) { thrust = v; }
    };
  }

  /* ============================================================
     1.5 序章：视频开场
     ------------------------------------------------------------
     播放：静音自动播一次，播完停在最后一帧（首帧是街道、末帧是
     人已入睡，循环回去会是一次很明显的跳变）。
     文案：三拍切换由播放进度决定，不由滚动决定 —— 画面自己在推进，
     文字若跟着滚动走会和画面错位。
     滚动：进度写进 --pro-p，画面下沉放淡，露出背后的全局星空层。
     兜底：自动播放被拦（低电量模式、策略限制）或解码失败时，
     没有画面推进就没有等待的理由，直接交出结尾那拍，并给一个可点的按钮。
     ============================================================ */
  var PRO_CUE2 = 3.0;   /* 第二拍：镜头推到居民楼的窗户 */
  var PRO_CUE3 = 5.5;   /* 第三拍：镜头进到卧室，人已经睡了 */

  function proSetStage(n) {
    if (!proSection || n === proStage) return;
    proStage = n;
    var nodes = proSection.querySelectorAll('[data-stage]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('is-on', +nodes[i].getAttribute('data-stage') === n);
    }
  }

  function proTryPlay(force) {
    if (!proVideo || (REDUCE && !force)) return null;
    var p = proVideo.play();
    /* 被浏览器拦下就安静留在海报上，不报错也不硬试 */
    if (p && p.catch) p.catch(function () { });
    return p;
  }

  /* 单文件版把视频的 base64 放在 <script type="text/plain"> 数据块里，
     这里先转成 Blob URL 再交给 <video>：iOS Safari 与部分微信内核不播
     data: 视频，而且几 MB 长的 data URL 在部分手机浏览器上会直接失效。
     滚动版没有这个数据块，于是继续用旁边的 assets/prologue.mp4。 */
  function adoptEmbeddedVideo() {
    var holder = document.getElementById('prologue-video-data');
    if (!holder) return;
    var b64 = (holder.textContent || '').replace(/\s+/g, '');
    if (!b64 || !window.Blob || !window.URL || !window.URL.createObjectURL) return;
    try {
      var bin = window.atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var srcEl = proVideo.querySelector('source');
      if (srcEl && srcEl.parentNode) srcEl.parentNode.removeChild(srcEl);
      proVideo.src = window.URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      proVideo.load();
      /* 数据块已经变成 Blob，留着这几 MB 的字符串只是白占内存 */
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    } catch (err) {
      /* 转换失败就维持原样，由后面的兜底文案收场 */
    }
  }

  function initPrologue() {
    proSection = document.getElementById('prologue');
    if (!proSection) return;
    proVideo = document.getElementById('prologue-video');
    proBar = document.getElementById('prologue-bar');
    if (!proVideo) return;

    adoptEmbeddedVideo();

    var playBtn = document.getElementById('prologue-play');
    var guard = null;

    function fallback() {
      if (guard) { clearTimeout(guard); guard = null; }
      proSection.classList.add('is-static');
      proSetStage(3);
    }

    proVideo.addEventListener('playing', function () {
      proLive = true;
      if (guard) { clearTimeout(guard); guard = null; }
      proSection.classList.remove('is-static');
      proSection.classList.add('is-playing');
    });
    proVideo.addEventListener('ended', function () {
      proEnded = true;
      proSection.classList.add('is-ended');
      proSetStage(3);
    });
    /* <source> 加载失败不会冒泡到 <video>，两边都得挂 */
    proVideo.addEventListener('error', fallback);
    var srcEl = proVideo.querySelector('source');
    if (srcEl) srcEl.addEventListener('error', fallback);

    if (REDUCE) {
      /* 不动画面，文案就没有等的必要 */
      proSetStage(3);
    } else {
      var attempt = proTryPlay(false);
      if (attempt && attempt.catch) {
        /* 明确被"自动播放策略"拦下（低电量模式、策略限制）时，画面根本不会动，
           没必要让用户盯着静帧等 —— 立刻把结尾那拍和播放按钮交出来 */
        attempt.catch(function (err) {
          if (err && err.name === 'NotAllowedError') fallback();
        });
        guard = setTimeout(fallback, 4000);
      } else {
        guard = setTimeout(fallback, 4000);
      }
    }

    if (playBtn) {
      playBtn.addEventListener('click', function () {
        proEnded = false;
        proStage = 0;
        proSection.classList.remove('is-static');
        proSetStage(1);
        proTryPlay(true);
      });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { if (!proEnded) proTryPlay(false); }
          else if (!proVideo.paused) proVideo.pause();
        });
      }, { threshold: .2 }).observe(proSection);
    }

    /* 切走标签页时主循环会停、视频却会继续跑，回来文案就跳拍了，索性一起停 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (!proVideo.paused) proVideo.pause();
      } else if (!proEnded && proSection.getBoundingClientRect().bottom > vh * .2) {
        proTryPlay(false);
      }
    });
  }

  /* 每帧调用：滚动位置 → --pro-p，播放进度 → 文案拍点与底部细线 */
  function updatePrologue(y) {
    if (!proSection) return;
    var rect = proSection.getBoundingClientRect();
    if (rect.bottom < -40 || rect.top > vh * 1.6) return;

    var p = clamp(-rect.top / (vh * .92), 0, 1);
    if (Math.abs(p - proP) > .002) {
      proP = p;
      proSection.style.setProperty('--pro-p', p.toFixed(4));
    }

    var t = proVideo.currentTime || 0;
    if (proBar) {
      var d = proVideo.duration || 0;
      proBar.style.transform = 'scaleX(' + (d > 0 ? clamp(t / d, 0, 1) : 0).toFixed(4) + ')';
    }
    if (proEnded || t >= PRO_CUE3) proSetStage(3);
    else if (t >= PRO_CUE2) proSetStage(2);
    else proSetStage(1);
  }

  /* 首屏的逐字标题等它真正进入视口再播：序章在前面占掉 8 秒，
     若照旧在加载时就播，用户滚下来只会看到一行静止的字 */
  function initHeroArm() {
    var el = document.getElementById('hero');
    if (!el) return;
    var armed = false;
    function arm() {
      if (armed) return;
      armed = true;
      el.classList.add('is-armed');
    }
    if (!('IntersectionObserver' in window)) { arm(); return; }
    /* 刷新后浏览器恢复了滚动位置、首屏本来就在眼前时，立刻武装 */
    if (el.getBoundingClientRect().top < vh * .9) { arm(); return; }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        arm();
        obs.disconnect();
      });
    }, { threshold: .22 });
    obs.observe(el);
  }

  /* ============================================================
     2. 主循环
     一个 rAF 里统一处理：曲速推力、星空视差、封面进度、
     卡片入场、图表生长。所有写入都在 rAF 内完成，避免布局抖动。
     ============================================================ */
  var revealers = [];
  var lastScrollY = 0;
  var scrollVelocity = 0;
  var heroPhoto = null;
  var ambientLayers = [];
  var coverTracks = [];
  var hero = null;
  var proSection = null;
  var proVideo = null;
  var proBar = null;
  var proP = -1;
  var proStage = 0;
  var proEnded = false;
  var proLive = false;
  var lastFrameTime = 0;
  var needsUpdate = true;
  /* 视口内有多少个"区块"正在被观察。为 0 时可以整体降频。 */
  var activeSections = 0;
  var sectionObserver = null;

  function requestUpdate() { needsUpdate = true; }

  function initFrame() {
    hero = document.getElementById('hero');
    heroPhoto = document.getElementById('hero-photo');
    ambientLayers = Array.prototype.slice.call(document.querySelectorAll('[data-ambient]'));
    coverTracks = Array.prototype.slice.call(document.querySelectorAll('[data-cover-track]'));
    lastScrollY = window.scrollY || window.pageYOffset || 0;
    if ('IntersectionObserver' in window) {
      /* 只有进入视口（上下各留一段余量）的区块才需要逐帧计算，
         其余区块直接跳过 —— 这是长页面滚动手感的关键。 */
      sectionObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var on = entry.isIntersecting;
          var was = entry.target.__on === true;
          if (on === was) return;
          entry.target.__on = on;
          activeSections += on ? 1 : -1;
          if (activeSections < 0) activeSections = 0;
          if (on) requestUpdate();
        });
      }, { rootMargin: '40% 0px 40% 0px', threshold: 0 });
      document.querySelectorAll('section').forEach(function (s) {
        /* 观察器要下一帧才回调，先自己量一次，避免首屏图表被当成"不可见"跳过 */
        s.__on = isNear(s, 1.6);
        if (s.__on) activeSections++;
        sectionObserver.observe(s);
      });
    }
    requestAnimationFrame(loop);
  }

  function updateAmbient(y) {
    var scrollRange = document.documentElement.scrollHeight - vh;
    var docProgress = scrollRange > 0 ? clamp(y / scrollRange, 0, 1) : 0;
    if (heroPhoto && hero) {
      /* 首屏完全离开视口后就不再改动它，省掉一次 getBoundingClientRect */
      if (y < vh * 1.02) {
        var heroProgress = clamp(y / Math.max(1, vh), 0, 1);
        /* 只做位移，不做缩放：对一张全屏大图来说，逐帧改缩放会让浏览器
           每帧重新栅格化整张位图，是首屏滚动里最贵的一笔；
           缩放固定在 CSS 里，滚动只推动它上下平移，合成器直接搬图层就行。 */
        heroPhoto.style.transform = 'scale(1.82) translate3d(0,' + (heroProgress * 34).toFixed(2) + 'px,0)';
        heroPhoto.style.opacity = (0.9 * (1 - heroProgress * .72)).toFixed(3);
      }
    }
    for (var i = 0; i < ambientLayers.length; i++) {
      var el = ambientLayers[i];
      var amp = parseFloat(el.getAttribute('data-ambient')) || .06;
      el.style.transform = 'translate3d(0,' + (-y * amp).toFixed(1) + 'px,0)';
      if (el.classList.contains('ambient-layer--near')) {
        el.style.opacity = clamp((y - vh * .85) / (vh * 1.2), 0, .42).toFixed(3);
      }
    }
    return docProgress;
  }

  function updateCovers(velocity) {
    for (var i = 0; i < coverTracks.length; i++) {
      var track = coverTracks[i];
      var section = track.parentElement;
      /* 封面一共只有 6 个，量一次的代价远比"漏算导致空白"小，
         所以这里不做可见性剔除，只按矩形距离快速筛掉远处的。 */
      var rect = track.getBoundingClientRect();
      var total = Math.max(1, rect.height - vh);
      if (rect.bottom < -vh * .2 || rect.top > vh * 1.2) continue;
      var p = clamp(-rect.top / total, 0, 1);
      section.style.setProperty('--cover-p', p.toFixed(4));
      section.style.setProperty('--cover-x', (velocity * -14).toFixed(1) + 'px');
      var readout = track.querySelector('[data-cover-readout]');
      if (readout) readout.textContent = Math.round(p * 100) + '%';
    }
  }

  function paintCharts() {
    for (var i = 0; i < revealers.length; i++) revealers[i](lastScrollY);
  }

  function onResize() {
    vh = window.innerHeight || vh;
    vw = window.innerWidth || vw;
    needsUpdate = true;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return;

    var idle = activeSections === 0;
    /* 没有任何区块在视口内时（极少见，例如停在长草稿中间），
       把整条循环降到 8fps，避免后台空转。 */
    var minInterval = idle ? 120 : (Math.abs(scrollVelocity) > .6 ? 13 : 20);
    if (now - lastFrameTime < minInterval) return;
    lastFrameTime = now;

    var y = window.scrollY || window.pageYOffset || 0;
    var delta = y - lastScrollY;
    var moved = Math.abs(delta) > .1;
    if (moved) {
      lastScrollY = y;
      scrollVelocity = lerp(scrollVelocity, delta, .26);
      needsUpdate = true;
    } else {
      scrollVelocity = lerp(scrollVelocity, 0, .18);
    }

    var warp = window.__warpState;
    if (warp) {
      var heroVisible = y < vh * 1.15;
      warp.setVisible(heroVisible);
      if (heroVisible) {
        var boost = Math.abs(scrollVelocity);
        warp.thrust = lerp(warp.thrust, 0.0006 + clamp(boost / 140, 0, 1) * 0.015, .2);
        warp.draw(warp.thrust, now);
      }
    }

    /* 序章的画面在自己在走，所以每帧都要看一眼，不能只在滚动时算；
       离开视口后 updatePrologue 会立刻返回，不会拖慢后面的章节 */
    if (proSection) {
      updatePrologue(y);
      /* 滚过序章再让章节导航浮回来 */
      document.documentElement.classList.toggle('prologue-lock', y < vh * .82);
    }

    /* 图表与封面只在"确实动了"或"刚从视口外进来"时重算 */
    if (needsUpdate) {
      needsUpdate = false;
      updateAmbient(y);
      updateCovers(scrollVelocity);
      paintCharts();
    }
  }

  /* ============================================================
     3. 通用「按滚动进度重绘」注册表
     ============================================================ */
  function registerReveal(domId, build) {
    var dom = document.getElementById(domId);
    if (!dom) return;
    var lastP = -1;
    revealers.push(function () {
      /* 视口外的图表完全不参与计算：这既省掉一次重排，
         也避免把它从"已完成"状态回退成"未开始"。 */
      if (dom.__on === false) return;
      var rect = dom.getBoundingClientRect();
      if (rect.bottom < -vh * 1.2 || rect.top > vh * 2.2) return;
      // 元素从下方 85% 处进入，升到视口的 38% 处时完成
      var p = clamp((vh * .85 - rect.top) / (vh * .47), 0, 1);
      p = ease(p);
      if (Math.abs(p - lastP) < .004) return;
      var prev = lastP;
      lastP = p;
      dom.__p = p;
      build(dom, p, prev);
    });
  }

  /* 给所有会滚动的元素挂上可见性标记：滚动循环只看标记，不看布局 */
  function tagVisibility() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-chart], .rise, .people-grid'));
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (el) { el.__vis = true; });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        e.target.__vis = e.isIntersecting;
        if (e.isIntersecting) requestUpdate();
      });
    }, { rootMargin: '60% 0px 60% 0px', threshold: 0 });
    nodes.forEach(function (el) {
      if (el.__vis === undefined) el.__vis = isNear(el, 1.5);
      obs.observe(el);
    });
  }

  /* ============================================================
     4. 章节封面：轨道进入视野就预热，进度完全由滚动位置决定
     ============================================================ */
  function initCoverReadouts() {
    /* 进度在 updateCovers 内直接写 CSS 变量，这里只负责首帧初始化 */
    updateCovers(0);
  }

  /* ============================================================
     5. 卡片 / 数字 / 方格的入场
     ============================================================ */
  function initRiseElements() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.rise'));
    nodes.forEach(function (el) {
      revealers.push(function () {
        if (el.__vis === false) return;
        var rect = el.getBoundingClientRect();
        if (rect.bottom < -vh || rect.top > vh * 2) return;
        var p = clamp((vh * .96 - rect.top) / (vh * .46), 0, 1);
        if (Math.abs(p - (el.__p == null ? -1 : el.__p)) < .006) return;
        el.__p = p;
        /* 只在 0<p<1 的推进区间里开启合成层，入场结束后立刻摘掉 */
        el.classList.toggle('is-moving', p > .002 && p < .998);
        el.style.setProperty('--p', p.toFixed(4));
      });
    });
  }

  /* 章节标题与风险影响数字沿用 .is-visible 这套类名做入场，
     原先挂在旧的 IntersectionObserver 上，这里补回来。 */
  function initVisibleToggles() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.section-header, .impact-card'));
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      nodes.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      });
    }, { threshold: .18, rootMargin: '0px 0px -8% 0px' });
    nodes.forEach(function (el) { observer.observe(el); });
  }

  function initCountUps() {
    var n = document.getElementById('hero-count');
    if (!n) return;
    var target = 6.97;
    var last = null;
    revealers.push(function () {
      var host = document.getElementById('hero');
      if (!host) return;
      var rect = host.getBoundingClientRect();
      var play = rect.bottom > 160;
      if (play === last) return;
      last = play;
      if (!play) { n.textContent = target.toFixed(2); return; }
      if (REDUCE) { n.textContent = target.toFixed(2); return; }
      var t0 = performance.now();
      (function tick(now) {
        var t = clamp((now - t0) / 1500, 0, 1);
        var e = 1 - Math.pow(2, -10 * t);
        n.textContent = (target * e).toFixed(2);
        if (t < 1) requestAnimationFrame(tick);
      })(performance.now());
    });
  }

  function initPeopleGrid() {
    var grid = document.getElementById('people-grid');
    if (!grid) return;
    var cells = [];
    var total = 65;
    for (var i = 0; i < 100; i++) {
      var cell = document.createElement('div');
      cell.className = 'people-cell' + (i < total ? ' pending' : '');
      grid.appendChild(cell);
      cells.push(cell);
    }
    var lastLit = -1;
    revealers.push(function () {
      if (!isNear(grid, 1.1)) return;
      var rect = grid.getBoundingClientRect();
      if (rect.bottom < -vh || rect.top > vh * 2) return;
      var p = clamp((vh * .82 - rect.top) / (vh * .42), 0, 1);
      // 65 个亮点按随机顺序依次亮起，读起来像在"统计"
      var lit = Math.round(p * total);
      if (lit === lastLit) return;
      lastLit = lit;
      for (var i = 0; i < total; i++) {
        cells[i].classList.toggle('pending', i >= lit);
      }
    });
  }

  /* ============================================================
     6. 图表：每张图都有自己的"生长方式"
     ============================================================ */
  var charts = {};
  function createChart(id, opts) {
    var dom = document.getElementById(id);
    if (!dom) return null;
    if (charts[id]) return charts[id];
    var c = initChart(dom, opts);
    charts[id] = c;
    return c;
  }
  function add(id, build) {
    var chart = createChart(id);
    if (!chart) return;
    registerReveal(id, function (dom, p) { build(chart, dom, p); });
  }

  /* --- 6.1 夜间平均睡眠时长：环形仪表从 0 转到 6.97 --- */
  function buildRingCard() {
    var card = document.getElementById('ring-card');
    if (!card) return;
    var dom = document.getElementById('ring-gauge-chart');
    if (!dom) return;
    var chart = createChart('ring-gauge-chart', { renderer: 'canvas' });
    var mode = 'gauge';
    var currentP = 0;

    function gaugeOption(p) {
      var v = lerp(.12, 6.97, p);
      return merged([{
        series: [{
          type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 7, radius: '90%', center: ['50%', '50%'],
          progress: { show: true, width: 14, roundCap: true, itemStyle: { color: gradientH(SLP.primary, SLP.secondary) } },
          axisLine: { lineStyle: { width: 14, color: [[1, SLP.muted]] } },
          axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false }, title: { show: false },
          detail: {
            offsetCenter: [0, '5%'],
            formatter: function () {
              return '{value|' + v.toFixed(2) + 'h}\n{label|夜间平均睡眠时长}\n' +
                (p > .985 ? '{growth|↑ 较上年 +7min}' : '{hint|滚动查看完整数值}');
            },
            rich: {
              value: { fontSize: 54, fontWeight: 600, color: SLP.fg, fontFamily: NUM_FONT, lineHeight: 64 },
              label: { fontSize: 15, color: SLP.mutedFg, lineHeight: 26, padding: [4, 0, 0, 0] },
              growth: { fontSize: 13, color: SLP.success, lineHeight: 24, padding: [2, 0, 0, 0] },
              hint: { fontSize: 12, color: 'rgba(157,166,203,.65)', lineHeight: 22, padding: [2, 0, 0, 0] }
            }
          },
          data: [{ value: +v.toFixed(2) }]
        }]
      }]);
    }

    function lineOption(p) {
      var years = ['2023', '2024', '2025', '2026'];
      var vals = [6.82, 6.88, 6.93, 6.97];
      return merged([{
        tooltip: tooltipBase({ trigger: 'axis' }),
        grid: { top: 40, bottom: 30, left: 46, right: 24 },
        xAxis: { type: 'category', data: years, axisLine: axisLine(), axisLabel: { color: SLP.mutedFg } },
        yAxis: { type: 'value', min: 6.7, max: 7.1, splitLine: splitLine(), axisLabel: { color: SLP.mutedFg } },
        series: [{
          type: 'line',
          data: vals.map(function (v, i) { return (i / (vals.length - 1)) <= p + .0001 ? v : null; }),
          smooth: true, symbol: 'circle', symbolSize: 8, connectNulls: false,
          lineStyle: { width: 3, color: gradientH(SLP.primary, SLP.secondary) },
          itemStyle: { color: SLP.secondary },
          areaStyle: { color: gradientV('rgba(79,125,247,.25)', 'rgba(79,125,247,0)') }
        }]
      }]);
    }

    if (chart) safeSet(chart, gaugeOption(0));

    registerReveal('ring-card', function (domEl, p) {
      if (mode !== 'gauge') { currentP = p; return; }
      currentP = p;
      safeSet(chart, gaugeOption(p));
    });

    function activate() {
      var domEl = chart.getDom();
      if (mode === 'line') {
        mode = 'gauge';
        domEl.dataset.mode = 'gauge';
        safeSet(chart, gaugeOption(currentP));
      } else {
        mode = 'line';
        domEl.dataset.mode = 'line';
        safeSet(chart, lineOption(currentP));
      }
    }
    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  }

  /* --- 6.2 平均入睡时间：表盘指针从 0 点走到 00:10 --- */
  function buildClock() {
    var dom = document.getElementById('clock-gauge-chart');
    if (!dom) return;
    dom.innerHTML = [
      '<div style="position:relative;width:210px;height:210px;">',
      '  <svg viewBox="0 0 180 180" style="position:absolute;inset:0;width:100%;height:100%;z-index:1;">',
      '    <circle cx="90" cy="90" r="85" fill="#111640" stroke="' + SLP.muted + '" stroke-width="2"/>',
      '    <g id="clock-ticks"></g>',
      '    <line id="hour-hand" x1="90" y1="90" x2="90" y2="55" stroke="' + SLP.fg + '" stroke-width="4" stroke-linecap="round"/>',
      '    <line id="minute-hand" x1="90" y1="90" x2="90" y2="32" stroke="' + SLP.primary + '" stroke-width="2" stroke-linecap="round"/>',
      '    <circle cx="90" cy="90" r="5" fill="' + SLP.secondary + '"/>',
      '    <text x="90" y="118" text-anchor="middle" fill="' + SLP.fg + '" font-size="14" font-weight="600">00:10 平均入睡时间</text>',
      '    <text x="90" y="136" text-anchor="middle" fill="' + SLP.success + '" font-size="11" font-weight="500">↑ 较上年提前 8min</text>',
      '  </svg>',
      '  <div id="clock-arc-chart" style="position:absolute;inset:0;z-index:2;pointer-events:none;"></div>',
      '</div>'
    ].join('');

    var tickGroup = dom.querySelector('#clock-ticks');
    for (var i = 0; i < 12; i++) {
      var a = -90 + i * 30;
      var r = a * Math.PI / 180;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', (90 + 82 * Math.cos(r)).toFixed(2));
      line.setAttribute('y1', (90 + 82 * Math.sin(r)).toFixed(2));
      line.setAttribute('x2', (90 + 76 * Math.cos(r)).toFixed(2));
      line.setAttribute('y2', (90 + 76 * Math.sin(r)).toFixed(2));
      line.setAttribute('stroke', '#3A4178');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-linecap', 'round');
      tickGroup.appendChild(line);
    }

    var hourHand = dom.querySelector('#hour-hand');
    var minuteHand = dom.querySelector('#minute-hand');
    /* 目标 00:10 —— 分针 60°，时针被分针带着走 5° */
    function setHands(p) {
      var minutes = 10 * p;
      hourHand.setAttribute('transform', 'rotate(' + (minutes * .5).toFixed(2) + ' 90 90)');
      minuteHand.setAttribute('transform', 'rotate(' + (minutes * 6).toFixed(2) + ' 90 90)');
    }
    setHands(REDUCE ? 1 : 0);

    var arcChart = initChart(dom.querySelector('#clock-arc-chart'), { renderer: 'svg' });
    charts['clock-arc-chart'] = arcChart;
    registerReveal('clock-gauge-chart', function (domEl, p) {
      setHands(p);
      var startAngle = 90 - 18 * 6;
      var endAngle = 90 - 10 * 6;
      safeSet(arcChart, merged([{
        series: [{
          type: 'gauge', startAngle: endAngle, endAngle: startAngle, min: 0, max: 100, radius: '80%', center: ['50%', '50%'],
          axisLine: { lineStyle: { width: 4, color: [[1, 'transparent']] } },
          progress: { show: true, width: 4, roundCap: true, itemStyle: { color: SLP.success, shadowColor: SLP.success, shadowBlur: 8 } },
          pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, detail: { show: false },
          data: [{ value: 100 * p }]
        }]
      }]));
    });
  }

  /* --- 6.3 睡眠焦虑：液位随滚动慢慢上涨 --- */
  function buildLiquid() {
    var dom = document.getElementById('liquid-fill-chart');
    if (!dom || !window.echarts || !window.echarts.graphic) return;
    if (typeof window.echarts.prototype === 'undefined') { /* 占位，保持分支清晰 */ }
    if (!hasLiquidFill()) {
      dom.innerHTML = '<div class="chart-fallback">液位图需要 echarts-liquidfill 插件，当前插件未加载。</div>';
      return;
    }
    var chart = createChart('liquid-fill-chart');
    if (!chart) return;
    registerReveal('liquid-fill-chart', function (domEl, p) {
      var level = lerp(.012, .485, p);
      var quiet = p < .02;
      /* 波光是持续重绘：只有卡片在视口里、且液面已经开始上涨时才开启，
         否则一张不在屏幕上的图会一直占用绘制线程。 */
      var waveOn = !quiet && !REDUCE && domEl.__vis !== false && p < .999;
      safeSet(chart, merged([{
        series: [{
          type: 'liquidFill', data: [level, level, level], radius: '70%',
          color: ['rgba(124,92,252,.8)', 'rgba(124,92,252,.5)', 'rgba(124,92,252,.3)'],
          amplitude: quiet ? 2 : [20, 12, 6],
          waveAnimation: waveOn,
          outline: { show: true, borderDistance: 0, itemStyle: { borderColor: SLP.muted, borderWidth: 3, color: '#111640' } },
          backgroundStyle: { color: '#111640', borderWidth: 0 },
          label: {
            show: true, position: ['50%', '50%'],
            formatter: function () {
              return '{value|' + (level * 100).toFixed(1) + '%}\n{desc|存在睡眠焦虑}';
            },
            rich: {
              value: { fontFamily: NUM_FONT, fontSize: 38, fontWeight: 'bold', color: SLP.fg, padding: [0, 0, 6, 0] },
              desc: { fontSize: 13, color: SLP.mutedFg, padding: [6, 0, 0, 0] }
            }
          }
        }]
      }]));
    });
  }
  function hasLiquidFill() {
    return !!(window.echarts && window.echarts.graphic);
  }

  /* --- 6.4 人群画像：柱、玫瑰、散点各自的生长 --- */
  var personaData = {
    student: {
      categories: ['入睡时长', '睡眠深度', '夜醒次数', '睡眠时长', '规律性', '打鼾频率'],
      values: [65, 72, 45, 80, 55, 30], highlight: 3,
      rose: [{ name: '熬夜型', value: 140 }, { name: '规律型', value: 85 }, { name: '失眠型', value: 50 }, { name: '碎片化', value: 65 }, { name: '嗜睡型', value: 40 }]
    },
    middle: {
      categories: ['入睡时长', '睡眠深度', '夜醒次数', '睡眠时长', '规律性', '打鼾频率'],
      values: [78, 55, 82, 50, 88, 75], highlight: 2,
      rose: [{ name: '熬夜型', value: 90 }, { name: '规律型', value: 120 }, { name: '失眠型', value: 95 }, { name: '碎片化', value: 110 }, { name: '嗜睡型', value: 35 }]
    },
    elder: {
      categories: ['入睡时长', '睡眠深度', '夜醒次数', '睡眠时长', '规律性', '打鼾频率'],
      values: [85, 40, 90, 45, 92, 60], highlight: 2,
      rose: [{ name: '熬夜型', value: 30 }, { name: '规律型', value: 150 }, { name: '失眠型', value: 110 }, { name: '碎片化', value: 130 }, { name: '嗜睡型', value: 70 }]
    }
  };
  var personaProgress = { student: 0, middle: 0, elder: 0 };
  var personaCharts = {};

  function barOption(data, p) {
    var seriesData = data.values.map(function (v, i) {
      return {
        value: +(v * p).toFixed(1),
        itemStyle: {
          color: i === data.highlight ? gradientH(SLP.primary, SLP.secondary) : gradientH('#3A4178', '#4A5072'),
          borderRadius: [0, 6, 6, 0]
        }
      };
    });
    return merged([{
      tooltip: tooltipBase({ trigger: 'axis' }),
      grid: { left: '3%', right: '8%', top: '5%', bottom: '5%', containLabel: true },
      xAxis: { type: 'value', max: 100, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: SLP.mutedFg, fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(37,45,90,.5)', type: 'dashed' } } },
      yAxis: { type: 'category', data: data.categories, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: SLP.fg, fontSize: 12, fontWeight: 500 } },
      series: [{
        type: 'bar', data: seriesData, barWidth: 14,
        label: { show: true, position: 'right', color: SLP.mutedFg, fontSize: 11, fontWeight: 600, formatter: function (o) { return Math.round(o.value); } }
      }]
    }]);
  }
  function roseOption(data, p) {
    var palette = ['#4F7DF7', '#36CFC9', '#F7B500', '#FF6B6B', '#9B8CFF'];
    return merged([{
      tooltip: tooltipBase({ trigger: 'item', formatter: function (o) { return o.name + '<br/>' + o.value + ' (' + o.percent + '%)'; } }),
      series: [{
        type: 'pie', radius: ['30%', '70%'], center: ['50%', '50%'], roseType: 'area',
        data: data.rose.map(function (d, i) {
          return { name: d.name, value: +(d.value * (.08 + .92 * p)).toFixed(1), itemStyle: { color: palette[i % palette.length], borderRadius: 4 } };
        }),
        label: { show: true, color: SLP.fg, fontSize: 12, formatter: '{b}\n{d}%' },
        labelLine: { lineStyle: { color: SLP.mutedFg } }
      }]
    }]);
  }
  function scatterOption(p) {
    var sleepData = personaCharts.__sleepData;
    var wakeData = personaCharts.__wakeData;
    var sleepShown = revealByThreshold(sleepData, p, function (d) { return clamp((d[0] - 20) / 12, 0, 1) * .92 + .02; });
    var wakeShown = revealByThreshold(wakeData, p, function (d) { return clamp((d[0] - 5) / 9, 0, 1) * .92 + .02; });
    return merged([{
      tooltip: tooltipBase({
        trigger: 'item',
        formatter: function (o) {
          var h = Math.floor(o.value[0]);
          var m = Math.round((o.value[0] - h) * 60);
          var isSleep = o.seriesName === '入睡时间';
          var src = isSleep ? sleepData : wakeData;
          var from = Math.max(0, o.value[0] - .5);
          var to = Math.min(24, o.value[0] + .5);
          var count = 0;
          for (var i = 0; i < src.length; i++) if (src[i][0] >= from && src[i][0] < to) count++;
          var pct = +(count / src.length * 100).toFixed(1);
          var color = isSleep ? SLP.primary : SLP.success;
          return '<div style="font-weight:600;margin-bottom:6px;">' + o.seriesName + '</div>' +
            '<div style="color:' + SLP.mutedFg + ';font-size:11px;">时间点</div>' +
            '<div style="font-size:15px;font-weight:700;margin-bottom:6px;">' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + '</div>' +
            '<div style="color:' + SLP.mutedFg + ';font-size:11px;">该时段人数占比</div>' +
            '<div style="font-size:15px;font-weight:700;color:' + color + ';">' + pct + '%</div>';
        }
      }),
      grid: { left: 20, right: 20, top: 40, bottom: 50, containLabel: false },
      xAxis: {
        type: 'value', min: 0, max: 24, interval: 1, axisLine: axisLine(),
        axisTick: { show: true, lineStyle: { color: SLP.border }, length: 4 },
        axisLabel: { color: SLP.mutedFg, fontSize: 11, formatter: function (v) { return v % 2 === 0 ? String(v).padStart(2, '0') + ':00' : ''; }, margin: 12 },
        splitLine: { show: true, lineStyle: { color: 'rgba(37,45,90,.4)', type: 'dashed' } },
        markArea: {
          silent: true, itemStyle: { color: 'rgba(240,71,92,.08)' },
          data: [
            [{ xAxis: 2, label: { show: true, position: 'insideTop', formatter: '21% 在 2 点后入睡', color: SLP.danger, fontSize: 11, fontWeight: 500, backgroundColor: 'rgba(240,71,92,.12)', padding: [4, 8], borderRadius: 4 } }, { xAxis: 7 }],
            [{ xAxis: 9, label: { show: true, position: 'insideTop', formatter: '32% 在 9 点后起床', color: SLP.success, fontSize: 11, fontWeight: 500, backgroundColor: 'rgba(52,211,153,.12)', padding: [4, 8], borderRadius: 4 } }, { xAxis: 13 }]
          ]
        }
      },
      yAxis: { type: 'value', min: 0, max: 1, show: false },
      series: [
        { name: '入睡时间', type: 'scatter', large: false, data: sleepShown, symbolSize: 7, itemStyle: { color: SLP.primary, opacity: .62 }, emphasis: { itemStyle: { opacity: 1, shadowBlur: 10, shadowColor: 'rgba(79,125,247,.6)' } }, blendMode: 'lighter' },
        { name: '起床时间', type: 'scatter', large: false, data: wakeShown, symbolSize: 7, itemStyle: { color: SLP.success, opacity: .62 }, emphasis: { itemStyle: { opacity: 1, shadowBlur: 10, shadowColor: 'rgba(52,211,153,.6)' } }, blendMode: 'lighter' }
      ]
    }]);
  }
  function gaussianRandom() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function normalRandom(mean, std) { return mean + gaussianRandom() * std; }
  function generateBimodal(p1, p2, count, min, max) {
    var data = [];
    var tw = p1.weight + p2.weight;
    for (var i = 0; i < count; i++) {
      var use1 = Math.random() < (p1.weight / tw);
      var pr = use1 ? p1 : p2;
      var x = normalRandom(pr.mean, pr.std);
      if (x < min) x = min + Math.random() * .5;
      if (x > max) x = max - Math.random() * .5;
      var d1 = Math.abs(x - p1.mean) / p1.std;
      var d2 = Math.abs(x - p2.mean) / p2.std;
      var dens = (Math.exp(-.5 * d1 * d1) * p1.weight + Math.exp(-.5 * d2 * d2) * p2.weight) / tw;
      var y = Math.max(.02, dens * .7 + gaussianRandom() * .15 + .1);
      data.push([+x.toFixed(3), +y.toFixed(4)]);
    }
    return data;
  }

  function buildPersonas() {
    /* 散点只生成一次：每次重绘都重新随机，点会跳 */
    personaCharts.__sleepData = generateBimodal({ mean: 24.5, std: 1.6, weight: 3 }, { mean: 23, std: .8, weight: 1 }, 420, 19, 31)
      .map(function (d) { return [d[0] > 24 ? +(d[0] - 24).toFixed(3) : d[0], d[1]]; });
    personaCharts.__wakeData = generateBimodal({ mean: 8.5, std: 1.4, weight: 2.5 }, { mean: 7, std: .6, weight: 1 }, 420, 5, 13);

    ['student', 'middle', 'elder'].forEach(function (key) {
      var data = personaData[key];
      var bar = createChart(key + '-bar-chart');
      var rose = createChart(key + '-rose-chart');
      personaCharts[key] = { bar: bar, rose: rose, p: 0 };
      if (bar) safeSet(bar, barOption(data, 0));
      if (rose) safeSet(rose, roseOption(data, 0));
      registerReveal(key + '-bar-chart', function (domEl, p) { personaCharts[key].p = p; safeSet(bar, barOption(data, p)); });
      registerReveal(key + '-rose-chart', function (domEl, p) { personaCharts[key].p = Math.max(personaCharts[key].p, p); safeSet(rose, roseOption(data, p)); });
    });

    var scatter = createChart('student-scatter-chart');
    if (scatter) {
      safeSet(scatter, scatterOption(0));
      registerReveal('student-scatter-chart', function (domEl, p) { safeSet(scatter, scatterOption(p)); });
    }
  }

  function initPersonaTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.persona-tab'));
    if (!tabs.length) return;
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      document.querySelectorAll('.persona-panel').forEach(function (p) { p.classList.remove('active'); });
      var panel = document.getElementById('panel-' + tab.dataset.key);
      if (panel) panel.classList.add('active');
      if (focus) tab.focus();
      requestAnimationFrame(function () {
        var entry = personaCharts[tab.dataset.key];
        if (!entry) return;
        if (entry.bar) { entry.bar.resize(); safeSet(entry.bar, barOption(personaData[tab.dataset.key], entry.p)); }
        if (entry.rose) { entry.rose.resize(); safeSet(entry.rose, roseOption(personaData[tab.dataset.key], entry.p)); }
      });
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
        var next = null;
        if (e.key in keys) next = tabs[(i + keys[e.key] + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
  }

  /* --- 6.5 午睡：漏斗逐层张开，城乡柱状对比随后长出 --- */
  function buildNap() {
    var funnelBase = [
      { name: '<30min', value: 25, bedTime: '00:47' },
      { name: '30-60min', value: 42, bedTime: '00:28' },
      { name: '60-120min', value: 20, bedTime: '00:55' },
      { name: '≥120min', value: 13, bedTime: '01:32' }
    ];
    var COLORS = [SLP.primary, SLP.secondary, SLP.mutedFg, SLP.danger];
    var funnel = createChart('nap-funnel-chart');
    if (funnel) {
      function funnelOption(p) {
        var layerP = function (i) { return span(p, i * .16, i * .16 + .5); };
        var shaped = funnelBase.map(function (d, i) {
          var lp = layerP(i);
          return { name: d.name, value: +(d.value * (.12 + .88 * lp)).toFixed(1), bedTime: d.bedTime, itemStyle: { color: COLORS[i], opacity: .85 } };
        });
        var labels = funnelBase.map(function (d, i) {
          return {
            name: d.name, value: +(d.value * (.12 + .88 * layerP(i))).toFixed(1),
            label: i === 1
              ? { fontSize: 22, fontWeight: 700, color: COLORS[i], textShadowColor: 'rgba(124,92,252,.65)', textShadowBlur: 14, fontFamily: NUM_FONT }
              : { fontSize: 14, fontWeight: 500, color: SLP.fg, fontFamily: NUM_FONT },
            itemStyle: { color: 'transparent', borderColor: 'transparent' }
          };
        });
        return merged([{
          tooltip: tooltipBase({
            trigger: 'item',
            formatter: function (o) {
              var c = COLORS[o.dataIndex] || SLP.secondary;
              var raw = o.data && o.data.bedTime ? o.data.bedTime : (funnelBase[o.dataIndex] || {}).bedTime;
              var real = (funnelBase[o.dataIndex] || {}).value;
              return '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">' + o.name + '</div>' +
                '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:12px;"><span style="font-size:26px;font-weight:700;color:' + c + ';font-family:' + NUM_FONT + ';">' + real + '%</span><span style="font-size:12px;color:' + SLP.mutedFg + ';">人群占比</span></div>' +
                '<div style="border-top:1px solid ' + SLP.border + ';padding-top:10px;"><div style="font-size:11px;color:' + SLP.mutedFg + ';margin-bottom:4px;">该时段人群夜间平均入睡时间</div><div style="font-size:18px;font-weight:600;">' + raw + '</div></div>';
            }
          }),
          series: [
            {
              type: 'funnel', name: 'rightLabel', left: '5%', top: 10, bottom: 10, width: '78%', min: 0, max: 50,
              minSize: '25%', maxSize: '100%', sort: 'none', gap: 4, funnelAlign: 'center', silent: true,
              label: { show: true, position: 'right', formatter: function (o) { return o.value + '%'; }, fontSize: 14, fontWeight: 500, color: SLP.fg, fontFamily: NUM_FONT },
              labelLine: { show: true, length: 12, lineStyle: { color: SLP.border, width: 1 } },
              itemStyle: { color: 'transparent', borderColor: 'transparent', borderRadius: 6 },
              data: labels
            },
            {
              type: 'funnel', name: 'napFunnel', left: '5%', top: 10, bottom: 10, width: '78%', min: 0, max: 50,
              minSize: '25%', maxSize: '100%', sort: 'none', gap: 4, funnelAlign: 'center',
              label: { show: true, position: 'left', formatter: '{b}', fontSize: 13, color: SLP.mutedFg, align: 'right' },
              labelLine: { show: true, length: 12, lineStyle: { color: SLP.border, width: 1 } },
              itemStyle: { borderRadius: 6, borderColor: 'transparent', borderWidth: 0 },
              emphasis: { label: { fontWeight: 600, color: SLP.fg }, itemStyle: { opacity: 1, shadowBlur: 24 } },
              data: shaped
            }
          ]
        }]);
      }
      safeSet(funnel, funnelOption(0));
      registerReveal('nap-funnel-chart', function (domEl, p) { safeSet(funnel, funnelOption(p)); });
    }

    var compare = createChart('nap-compare-chart');
    if (compare) {
      function compareOption(p) {
        return merged([{
          tooltip: tooltipBase({ trigger: 'axis' }),
          grid: { top: 40, bottom: 40, left: 50, right: 20 },
          xAxis: { type: 'category', data: ['城市', '农村'], axisLine: axisLine(), axisLabel: { color: SLP.fg, fontSize: 13 } },
          yAxis: { type: 'value', max: 60, axisLabel: { color: SLP.mutedFg, formatter: '{value}%' }, splitLine: splitLine() },
          series: [{
            type: 'bar', data: [38, 52].map(function (v) { return +(v * p).toFixed(1); }), barWidth: 40,
            itemStyle: { color: gradientV(SLP.primary, SLP.secondary), borderRadius: [6, 6, 0, 0] },
            label: { show: true, position: 'top', color: SLP.fg, formatter: function (o) { return Math.round(o.value) + '%'; } }
          }]
        }]);
      }
      safeSet(compare, compareOption(0));
      registerReveal('nap-compare-chart', function (domEl, p) { safeSet(compare, compareOption(p)); });
    }
  }

  /* --- 6.6 风险：热力图按风险高低依次浮出，柱状随年龄一层层堆起来 --- */
  function buildRisk() {
    var hours = ['<5h', '5-6h', '6-7h', '7-8h', '≥8h'];
    var ages = ['青年', '中年', '老年'];
    var cells = [
      [0, 0, 12], [0, 1, 46.2], [0, 2, 28],
      [1, 0, 18], [1, 1, 35], [1, 2, 22],
      [2, 0, 25], [2, 1, 20], [2, 2, 30],
      [3, 0, 30], [3, 1, 15], [3, 2, 25],
      [4, 0, 15], [4, 1, 8], [4, 2, 18]
    ];
    var heat = createChart('risk-heatmap-chart');
    if (heat) {
      /* 睡眠时间越短的行越先亮：滚动像是在"逐格体检" */
      var order = cells.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      function heatOption(p) {
        var shown = revealByThreshold(order, p, function (d, i) { return clamp(i / (order.length - 1) * .86 + .02, 0, 1); });
        return merged([{
          tooltip: tooltipBase({
            position: 'top',
            formatter: function (o) { return ages[o.value[1]] + ' · ' + hours[o.value[0]] + '<br/>风险指数: <span style="color:' + SLP.danger + ';font-weight:700;">' + o.value[2] + '%</span>'; }
          }),
          grid: { top: 10, bottom: 30, left: 60, right: 20 },
          xAxis: { type: 'category', data: hours, splitArea: { show: true, areaStyle: { color: ['rgba(37,45,90,.1)', 'rgba(37,45,90,.2)'] } }, axisLabel: { color: SLP.mutedFg } },
          yAxis: { type: 'category', data: ages, splitArea: { show: true }, axisLabel: { color: SLP.fg } },
          visualMap: { min: 0, max: 50, calculable: false, show: false, inRange: { color: ['#3A4178', '#F0475C'] }, seriesIndex: 0 },
          series: [{
            name: '风险指数', type: 'heatmap',
            data: shown.map(function (d) { return [d[0], d[1], d[2]]; }),
            label: { show: true, color: '#fff', formatter: function (o) { return o.value[2] + '%'; } },
            emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,.5)' } },
            itemStyle: { borderRadius: 4, borderColor: SLP.card, borderWidth: 2 }
          }]
        }]);
      }
      safeSet(heat, heatOption(0));
      registerReveal('risk-heatmap-chart', function (domEl, p) { safeSet(heat, heatOption(p)); });
    }

    var stack = createChart('risk-stack-chart');
    if (stack) {
      var men = [4, 8, 15, 22, 26];
      var women = [2, 4, 7, 10, 12];
      function stackOption(p) {
        return merged([{
          tooltip: tooltipBase({ trigger: 'axis' }),
          legend: { data: ['男性', '女性'], textStyle: { color: SLP.mutedFg }, bottom: 0 },
          grid: { top: 20, bottom: 40, left: 40, right: 20 },
          xAxis: { type: 'category', data: ['18-30', '31-45', '46-60', '61-65', '66+'], axisLine: axisLine(), axisLabel: { color: SLP.mutedFg } },
          yAxis: { type: 'value', max: 40, axisLabel: { color: SLP.mutedFg, formatter: '{value}%' }, splitLine: splitLine() },
          series: [
            { name: '男性', type: 'bar', stack: 'total', barWidth: 30, data: men.map(function (v, i) { return +(v * span(p, i * .1, i * .1 + .55)).toFixed(1); }), itemStyle: { color: SLP.danger, borderRadius: [4, 4, 0, 0] } },
            { name: '女性', type: 'bar', stack: 'total', data: women.map(function (v, i) { return +(v * span(p, i * .1 + .14, i * .1 + .7)).toFixed(1); }), itemStyle: { color: SLP.dangerLight } }
          ]
        }]);
      }
      safeSet(stack, stackOption(0));
      registerReveal('risk-stack-chart', function (domEl, p) { safeSet(stack, stackOption(p)); });
    }

    var sankey = createChart('risk-sankey-chart');
    if (sankey) {
      var nodeData = [
        { name: '睡眠不足 / 睡眠 < 5h', itemStyle: { color: SLP.danger } },
        { name: '肥胖', itemStyle: { color: SLP.secondary } },
        { name: '呼吸暂停', itemStyle: { color: SLP.secondary } },
        { name: '疲劳驾驶', itemStyle: { color: SLP.secondary } },
        { name: '工作效率下降', itemStyle: { color: SLP.secondary } },
        { name: '职业伤害 +29-34%', itemStyle: { color: SLP.dangerLight } },
        { name: '交通事故 +62%', itemStyle: { color: SLP.dangerLight } },
        { name: '年经济损失 > 2.4 亿', itemStyle: { color: SLP.dangerLight } }
      ];
      function hexToRgba(hex, a) {
        var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
      function colourOf(name) {
        for (var i = 0; i < nodeData.length; i++) if (nodeData[i].name === name) return nodeData[i].itemStyle.color;
        return '#fff';
      }
      var rawLinks = [
        { source: '睡眠不足 / 睡眠 < 5h', target: '肥胖', value: 30, at: .06 },
        { source: '睡眠不足 / 睡眠 < 5h', target: '呼吸暂停', value: 25, at: .16 },
        { source: '睡眠不足 / 睡眠 < 5h', target: '疲劳驾驶', value: 22, at: .26 },
        { source: '睡眠不足 / 睡眠 < 5h', target: '工作效率下降', value: 28, at: .36 },
        { source: '肥胖', target: '职业伤害 +29-34%', value: 14, at: .50 },
        { source: '肥胖', target: '年经济损失 > 2.4 亿', value: 16, at: .58 },
        { source: '呼吸暂停', target: '职业伤害 +29-34%', value: 12, at: .64 },
        { source: '呼吸暂停', target: '交通事故 +62%', value: 13, at: .70 },
        { source: '疲劳驾驶', target: '交通事故 +62%', value: 18, at: .78 },
        { source: '疲劳驾驶', target: '职业伤害 +29-34%', value: 6, at: .84 },
        { source: '工作效率下降', target: '年经济损失 > 2.4 亿', value: 22, at: .90 },
        { source: '工作效率下降', target: '职业伤害 +29-34%', value: 8, at: .96 }
      ];
      function sankeyOption(p) {
        var links = rawLinks.filter(function (l) { return p + .001 >= l.at; }).map(function (l) {
          var grow = clamp((p - l.at) / .18, .05, 1);
          return {
            source: l.source, target: l.target, value: +(l.value * grow).toFixed(1),
            lineStyle: {
              color: {
                type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                colorStops: [{ offset: 0, color: hexToRgba(colourOf(l.source), .45) }, { offset: 1, color: hexToRgba(colourOf(l.target), .45) }]
              },
              opacity: .7, curveness: .5
            }
          };
        });
        return merged([{
          tooltip: tooltipBase({
            trigger: 'item',
            formatter: function (o) {
              return o.dataType === 'edge'
                ? o.data.source + ' → ' + o.data.target + '<br/>影响权重: ' + o.data.value
                : o.name + '<br/>总流量: ' + o.value;
            }
          }),
          series: [{
            type: 'sankey', left: '8%', right: '12%', top: '10%', bottom: '10%',
            nodeWidth: 14, nodeGap: 18, nodeAlign: 'justify', layoutIterations: 32, draggable: true,
            itemStyle: { borderWidth: 0, borderRadius: 4 },
            label: { color: '#fff', fontSize: 13, fontWeight: 500 },
            lineStyle: { curveness: .5, opacity: .7 },
            emphasis: { focus: 'adjacency', lineStyle: { opacity: 1 } },
            blur: { itemStyle: { opacity: .35 }, lineStyle: { opacity: .15 } },
            data: nodeData,
            links: links
          }]
        }]);
      }
      safeSet(sankey, sankeyOption(0));
      registerReveal('risk-sankey-chart', function (domEl, p) { safeSet(sankey, sankeyOption(p)); });
    }
  }

  /* --- 6.7 中国地图：省份按纬度从西向东依次点亮 --- */
  var sleepProvinces = [
    { name: '北京市', value: 6.7, sleepTime: '00:48' }, { name: '天津市', value: 6.9, sleepTime: '00:32' },
    { name: '河北省', value: 7.1, sleepTime: '00:18' }, { name: '山西省', value: 7.2, sleepTime: '00:12' },
    { name: '内蒙古自治区', value: 7.4, sleepTime: '23:58' }, { name: '辽宁省', value: 7.1, sleepTime: '00:15' },
    { name: '吉林省', value: 7.2, sleepTime: '00:08' }, { name: '黑龙江省', value: 7.2, sleepTime: '00:05' },
    { name: '上海市', value: 6.6, sleepTime: '00:52' }, { name: '江苏省', value: 6.8, sleepTime: '00:42' },
    { name: '浙江省', value: 6.7, sleepTime: '00:48' }, { name: '安徽省', value: 7.0, sleepTime: '00:25' },
    { name: '福建省', value: 6.9, sleepTime: '00:35' }, { name: '江西省', value: 7.1, sleepTime: '00:20' },
    { name: '山东省', value: 7.0, sleepTime: '00:28' }, { name: '河南省', value: 7.1, sleepTime: '00:22' },
    { name: '湖北省', value: 7.0, sleepTime: '00:30' }, { name: '湖南省', value: 7.1, sleepTime: '00:25' },
    { name: '广东省', value: 6.8, sleepTime: '00:45' }, { name: '广西壮族自治区', value: 7.2, sleepTime: '00:15' },
    { name: '海南省', value: 7.0, sleepTime: '00:30' }, { name: '重庆市', value: 6.9, sleepTime: '00:38' },
    { name: '四川省', value: 7.1, sleepTime: '00:22' }, { name: '贵州省', value: 7.2, sleepTime: '00:12' },
    { name: '云南省', value: 7.3, sleepTime: '00:08' }, { name: '西藏自治区', value: 7.5, sleepTime: '23:52' },
    { name: '陕西省', value: 7.1, sleepTime: '00:20' }, { name: '甘肃省', value: 7.3, sleepTime: '00:05' },
    { name: '青海省', value: 7.4, sleepTime: '23:58' }, { name: '宁夏回族自治区', value: 7.3, sleepTime: '00:02' },
    { name: '新疆维吾尔自治区', value: 7.6, sleepTime: '23:45' }, { name: '台湾省', value: 6.9, sleepTime: '00:35' },
    { name: '香港特别行政区', value: 6.5, sleepTime: '01:00' }, { name: '澳门特别行政区', value: 6.6, sleepTime: '00:55' }
  ];

  function buildMap() {
    var dom = document.getElementById('china-map-chart');
    if (!dom) return;
    var loading = document.getElementById('map-loading');
    var fallback = document.getElementById('map-fallback');
    if (!hasECharts() || !window.__CHINA_GEOJSON__) {
      if (fallback) fallback.hidden = false;
      if (loading) loading.classList.remove('is-active');
      return;
    }
    var chart = createChart('china-map-chart', { renderer: 'canvas' });
    if (!chart) return;

    /* 按经度排序：滚动点亮时西部先亮，正好对应"睡得越沉"的结论 */
    var ordered = sleepProvinces.slice().sort(function (a, b) {
      var ca = window.__CHINA_GEOJSON__.features.filter(function (f) { return f.properties.name === a.name; })[0];
      var cb = window.__CHINA_GEOJSON__.features.filter(function (f) { return f.properties.name === b.name; })[0];
      var ax = ca ? ca.properties.center[0] : 110;
      var bx = cb ? cb.properties.center[0] : 110;
      return ax - bx;
    });

    function mapOption(p) {
      var shown = revealByThreshold(ordered, p, function (d, i) { return clamp(i / (ordered.length - 1) * .9 + .02, 0, 1); });
      var lo = lerp(6.9, 6.5, p);
      return merged([{
        tooltip: tooltipBase({
          trigger: 'item',
          formatter: function (o) {
            if (!o.data) return o.name;
            return '<div style="font-weight:600;font-size:14px;margin-bottom:6px;">' + o.name + '</div>' +
              '<div style="font-size:12px;color:' + SLP.mutedFg + ';">平均睡眠 <span style="color:' + SLP.fg + ';font-family:' + NUM_FONT + ';font-weight:600;">' + o.data.value.toFixed(2) + 'h</span></div>' +
              '<div style="font-size:12px;color:' + SLP.mutedFg + ';margin-top:4px;">入睡时间 <span style="color:' + SLP.fg + ';font-family:' + NUM_FONT + ';">' + o.data.sleepTime + '</span></div>';
          }
        }),
        visualMap: { show: false, type: 'continuous', min: lo, max: 7.6, inRange: { color: ['#F0475C', '#4F7DF7', '#34D399'] }, seriesIndex: 0 },
        geo: {
          map: 'china', roam: false, zoom: 1.36, center: [104, 37], aspectScale: .75,
          itemStyle: { areaColor: '#111640', borderColor: '#0A0E27', borderWidth: 1 },
          emphasis: { itemStyle: { areaColor: null, borderColor: SLP.fg, borderWidth: 1.5, shadowColor: 'rgba(79,125,247,.4)', shadowBlur: 10 }, label: { show: false } },
          select: { itemStyle: { areaColor: null, borderColor: SLP.fg, borderWidth: 2 }, label: { show: false } }
        },
        series: [
          { name: '平均睡眠时长', type: 'map', map: 'china', geoIndex: 0, data: shown, label: { show: false } },
          {
            type: 'lines', coordinateSystem: 'geo', zlevel: 2,
            effect: { show: p > .5, period: 4, trailLength: .5, color: 'rgba(124,92,252,.6)', symbol: 'arrow', symbolSize: 6 },
            lineStyle: { color: 'rgba(124,92,252,.4)', width: 1, curveness: .3 },
            data: p > .5 ? [
              { coords: [[116.4, 39.9], [121.5, 31.2]] },
              { coords: [[116.4, 39.9], [113.3, 23.1]] },
              { coords: [[104.1, 36.1], [104.1, 30.7]] }
            ] : []
          }
        ]
      }]);
    }
    if (loading) loading.classList.remove('is-active');
    safeSet(chart, mapOption(0));
    registerReveal('china-map-chart', function (domEl, p) { safeSet(chart, mapOption(p)); });

    var radar = createChart('city-radar-chart');
    if (radar) {
      var cities = [
        { name: '北京', value: [6.7, 3.2, 5.5, 6.0, 7.8], color: SLP.danger, area: 'rgba(240,71,92,.2)' },
        { name: '上海', value: [6.6, 2.8, 5.2, 5.8, 8.0], color: SLP.primary, area: 'rgba(79,125,247,.2)' },
        { name: '广州', value: [6.8, 3.5, 5.8, 6.2, 7.2], color: SLP.success, area: 'rgba(52,211,153,.2)' },
        { name: '成都', value: [7.1, 4.2, 6.5, 6.8, 5.5], color: SLP.secondary, area: 'rgba(124,92,252,.2)' }
      ];
      function radarOption(p) {
        return merged([{
          tooltip: tooltipBase({}),
          legend: { data: ['北京', '上海', '广州', '成都'], textStyle: { color: SLP.mutedFg }, bottom: 0 },
          radar: {
            indicator: [
              { name: '睡眠时长', max: 10 }, { name: '入睡时间', max: 10 }, { name: '规律性', max: 10 },
              { name: '深睡占比', max: 10 }, { name: '焦虑程度', max: 10 }
            ],
            radius: '62%', center: ['50%', '45%'], shape: 'polygon', splitNumber: 4,
            axisName: { color: SLP.mutedFg, fontSize: 12 },
            splitLine: { lineStyle: { color: 'rgba(37,45,90,.5)' } },
            splitArea: { areaStyle: { color: ['rgba(37,45,90,.1)', 'rgba(37,45,90,.2)', 'rgba(37,45,90,.3)', 'rgba(37,45,90,.4)'] } },
            axisLine: { lineStyle: { color: 'rgba(37,45,90,.5)' } }
          },
          series: [{
            type: 'radar',
            data: cities.map(function (c) {
              return { name: c.name, value: c.value.map(function (v) { return +(v * (.1 + .9 * p)).toFixed(2); }), itemStyle: { color: c.color }, areaStyle: { color: c.area } };
            })
          }]
        }]);
      }
      safeSet(radar, radarOption(0));
      registerReveal('city-radar-chart', function (domEl, p) { safeSet(radar, radarOption(p)); });
    }
  }

  /* --- 6.8 趋势线：左到右逐段画出来 --- */
  function buildTrend() {
    var chart = createChart('trend-line-chart');
    if (!chart) return;
    var years = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'];
    var vals = [6.62, 6.58, 6.55, 6.67, 6.74, 6.82, 6.97];
    function trendOption(p) {
      var shown = vals.map(function (v, i) {
        return (i / (vals.length - 1)) <= p + .0001 ? v : null;
      });
      var lastIdx = Math.max(0, Math.ceil(p * (vals.length - 1)));
      return merged([{
        tooltip: tooltipBase({ trigger: 'axis' }),
        grid: { top: 40, bottom: 30, left: 52, right: 24 },
        xAxis: { type: 'category', data: years, axisLine: axisLine(), axisLabel: { color: SLP.mutedFg } },
        yAxis: { type: 'value', min: 6.5, max: 7.2, axisLabel: { color: SLP.mutedFg, formatter: '{value}h' }, splitLine: splitLine() },
        series: [{
          type: 'line', data: shown, smooth: true, symbol: 'circle', symbolSize: 8, connectNulls: false,
          lineStyle: { width: 3, color: gradientH(SLP.primary, SLP.secondary) },
          itemStyle: { color: SLP.secondary },
          areaStyle: { color: gradientV('rgba(79,125,247,.25)', 'rgba(79,125,247,0)') },
          markPoint: p > .97 ? { data: [{ type: 'max', name: '最高' }], itemStyle: { color: SLP.success } } : { data: [] }
        }]
      }]);
    }
    safeSet(chart, trendOption(0));
    registerReveal('trend-line-chart', function (domEl, p) { safeSet(chart, trendOption(p)); });
  }

  /* ============================================================
     7. 自测问卷（保持原有逻辑，仅补上滚动入场）
     ============================================================ */
  function initQuiz() {
    var quizContainer = document.getElementById('quiz-container');
    var result = document.getElementById('quiz-result');
    var resetBtn = document.getElementById('quiz-reset');
    if (!quizContainer) return;
    var questions = [
      { q: '1. 过去一周，你的平均入睡时间通常在？', options: ['22:00 前', '22:00-23:00', '23:00-00:00', '00:00 后'] },
      { q: '2. 你是否经常因焦虑或压力难以入睡？', options: ['从不', '偶尔', '经常', '几乎每天'] },
      { q: '3. 你每天的午睡习惯是？', options: ['不午睡', '<30min', '30-60min', '>60min'] }
    ];
    var answers = [];
    function build() {
      answers = [];
      quizContainer.innerHTML = '';
      if (result) { result.hidden = true; result.textContent = ''; }
      questions.forEach(function (item, idx) {
        var wrap = document.createElement('div');
        wrap.className = 'quiz-step';
        var q = document.createElement('p');
        q.className = 'quiz-question';
        q.id = 'quiz-q-' + idx;
        q.textContent = item.q;
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-labelledby', q.id);
        var opts = document.createElement('div');
        opts.className = 'quiz-options';
        item.options.forEach(function (opt, i) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'quiz-option';
          btn.textContent = opt;
          btn.setAttribute('aria-pressed', 'false');
          btn.addEventListener('click', function () {
            Array.prototype.forEach.call(opts.querySelectorAll('.quiz-option'), function (b) {
              b.classList.remove('selected');
              b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('selected');
            btn.setAttribute('aria-pressed', 'true');
            answers[idx] = i;
            if (answers.filter(function (x) { return x !== undefined; }).length === questions.length) showResult();
          });
          opts.appendChild(btn);
        });
        wrap.appendChild(q);
        wrap.appendChild(opts);
        quizContainer.appendChild(wrap);
      });
    }
    function showResult() {
      var score = answers.reduce(function (a, b) { return a + b; }, 0);
      var text;
      if (score <= 2) text = '睡眠习惯良好，继续保持规律作息。';
      else if (score <= 5) text = '睡眠质量中等，建议减少睡前屏幕使用并固定就寝时间。';
      else if (score <= 8) text = '存在明显睡眠困扰，建议关注睡眠卫生，必要时咨询专业医生。';
      else text = '睡眠健康风险较高，建议尽早进行专业睡眠评估。';
      if (!result) return;
      result.innerHTML = '<strong>自测结果：</strong>' + text;
      result.hidden = false;
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        build();
        var first = quizContainer.querySelector('.quiz-option');
        if (first) first.focus();
      });
    }
    build();
  }

  /* ============================================================
     8. 页面框架：导航、进度、分享
     ============================================================ */
  function initSectionNav() {
    var rail = document.querySelector('.section-rail');
    if (!rail || !('IntersectionObserver' in window)) return;
    var links = Array.prototype.slice.call(rail.querySelectorAll('a'));
    var sections = links.map(function (a) { return document.querySelector(a.getAttribute('href')); }).filter(Boolean);
    if (!sections.length) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = '#' + entry.target.id;
        links.forEach(function (a) {
          if (a.getAttribute('href') === id) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    sections.forEach(function (s) { observer.observe(s); });
  }

  function initReadProgress() {
    var bar = document.getElementById('read-progress-bar');
    if (!bar) return;
    var supportsScrollTimeline = window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()');
    if (supportsScrollTimeline && !REDUCE) {
      bar.style.animation = 'readProgress linear both';
      bar.style.animationTimeline = 'scroll(root block)';
      var keyframes = '@keyframes readProgress{from{width:0}to{width:100%}}';
      var style = document.createElement('style');
      style.textContent = keyframes;
      document.head.appendChild(style);
      return;
    }
    var queued = false;
    function update() {
      queued = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
      bar.style.width = (ratio * 100).toFixed(2) + '%';
    }
    window.addEventListener('scroll', function () {
      if (!queued) { queued = true; requestAnimationFrame(update); }
    }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  function initScrollButtons() {
    document.querySelectorAll('.scroll-indicator').forEach(function (el) {
      el.addEventListener('click', function () {
        var t = document.querySelector(el.dataset.scrollTo);
        if (t) t.scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth' });
      });
    });
  }

  window.sharePage = function (type) {
    var url = location.href;
    var title = '2026中国睡眠健康研究白皮书';
    if (type === 'weibo') window.open('https://service.weibo.com/share/share.php?url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title), '_blank');
    else if (type === 'copy') { if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { alert('链接已复制'); }); }
  };

  function warmVisibleCharts() {
    /* 首帧就把可见区域内的图表算一遍，避免打开页面看到空白卡片 */
    requestUpdate();
    for (var i = 0; i < revealers.length; i++) revealers[i](window.scrollY);
  }

  function initAll() {
    initPrologue();
    initHeroArm();
    initCoverReadouts();
    initRiseElements();
    initVisibleToggles();
    initCountUps();
    initPeopleGrid();
    initWarp();
    /* 先把可见性标记挂好，后面所有滚动计算都靠它做快速剔除 */
    tagVisibility();

    var steps = [buildRingCard, buildClock, buildLiquid, buildPersonas, initPersonaTabs, buildNap, buildRisk, buildMap, buildTrend, initQuiz];
    steps.forEach(function (fn) {
      try { fn(); } catch (err) { console.warn('[sleep-scroll] 初始化失败：' + (fn.name || 'anonymous'), err); }
    });

    initSectionNav();
    initReadProgress();
    initScrollButtons();
    initFrame();
    requestAnimationFrame(warmVisibleCharts);

    window.__SLEEP_READY__ = true;

    var resizeFrame = null;
    window.addEventListener('resize', function () {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(function () {
        onResize();
        Object.keys(charts).forEach(function (k) {
          try { if (charts[k]) charts[k].resize(); } catch (e) { }
        });
        warmVisibleCharts();
      });
    }, { passive: true });

    window.addEventListener('orientationchange', function () {
      setTimeout(onResize, 260);
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
