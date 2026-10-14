/* ============================================================
   2026 中国睡眠白皮书 · 互动房间
   ------------------------------------------------------------
   状态机
     isDay      : true 白天 / false 黑夜
     isLightOn  : true 开灯 / false 关灯
   背景映射
     isDay=true                    → bg-day.jpg
     isDay=false, isLightOn=true   → bg-night-on.jpg
     isDay=false, isLightOn=false  → bg-night-off.jpg
   切换背景只用 opacity 过渡 0.6s（见 style.css）

   字幕
     夜晚点台灯 → 舞台底部弹出"蓝光 / 暖光"科普字幕（30s 自动淡出）
     切白天 / 按 Esc / 点字幕上的 × → 收起
   卡片
     所有建议卡片统一使用 assets/paper-card（羊皮纸）做底
   ============================================================ */
(function () {
  'use strict';

  /* =========================================================
     1. 状态
     ========================================================= */
  var state = {
    isDay: true,
    isLightOn: false
  };

  /* 动画互斥锁：一次只播一个物品的完整动画链 */
  var busy = false;
  /* 保险解锁：任何异常都不该让页面卡死 */
  var safetyTimer = null;

  /* =========================================================
     2. 元素引用
     ========================================================= */
  var stage       = document.getElementById('stage');
  var layerBg     = document.getElementById('layerBg');
  var layerItems  = document.getElementById('layerItems');
  var layerFx     = document.getElementById('layerFx');

  var bgDay       = document.getElementById('bgDay');
  var bgNightOn   = document.getElementById('bgNightOn');
  var bgNightOff  = document.getElementById('bgNightOff');

  var mask        = document.getElementById('mask');
  var modalHost   = document.getElementById('modalHost');
  var cardNormal  = document.getElementById('cardNormal');
  var cardCream   = document.getElementById('cardCream');
  var closeNormal = document.getElementById('closeNormal');
  var closeCream  = document.getElementById('closeCream');
  var normalIcon  = document.getElementById('normalIcon');
  var normalTitle = document.getElementById('normalTitle');
  var normalBody  = document.getElementById('normalBody');
  var creamIcon   = document.getElementById('creamIcon');
  var creamTitle  = document.getElementById('creamTitle');
  var creamBody   = document.getElementById('creamBody');

  var fxBook      = document.getElementById('fxBook');
  var toastEl     = document.getElementById('toast');
  var captionEl   = document.getElementById('caption');
  var captionText = document.getElementById('captionText');
  var captionClose= document.getElementById('captionClose');
  var hintEl      = document.querySelector('.hint');

  /* 所有物品 wrapper（含窗户），用于统一挂事件与统一降亮度 */
  var ITEMS = Array.prototype.slice.call(document.querySelectorAll('.item'));

  /* =========================================================
     3. 文案（2026 中国睡眠白皮书 · 可视化数据与建议）
     ========================================================= */
  var CONTENT = {
    /* ---- 普通卡片：书本、眼罩 ---- */
    book: {
      icon: '📖',
      title: '睡前阅读 · 白皮书数据',
      body:
        '<p>《2026 中国睡眠白皮书》显示，睡前有阅读习惯的人群，平均入睡时间比刷手机人群提前 <span class="num">23 分钟</span>。</p>' +
        '<p>但阅读的<strong>介质</strong>很关键：用纸质书阅读的人，深度睡眠时长比用电子屏幕阅读的人多 <span class="num">18 分钟</span>。</p>' +
        '<p>原因是屏幕蓝光会抑制褪黑素分泌，让身体误判"还是白天"。</p>' +
        '<span class="tip">💡 建议：睡前 30 分钟读纸质书，把手机留在客厅。灯光调至暖黄、亮度低于一半。</span>'
    },

    eyemask: {
      icon: '😴',
      title: '遮光眼罩 · 白皮书数据',
      body:
        '<p>白皮书调研发现，卧室光线强度超过 <span class="num">5 勒克斯</span>（约等于一盏小夜灯）时，受试者的入睡潜伏期平均延长 <span class="num">14 分钟</span>。</p>' +
        '<p>使用遮光眼罩的人群中，有 <span class="num">67%</span> 表示入睡更快，<span class="num">41%</span> 表示夜间醒来次数减少。</p>' +
        '<p>全黑环境能促使松果体稳定分泌褪黑素，让睡眠周期更完整。</p>' +
        '<span class="tip">💡 建议：选贴合面部、不压眼球的眼罩；配合遮光窗帘，把卧室亮度降到"伸手不见五指"。</span>'
    },

    /* ---- 米黄卡片：褪黑素、枕头 ---- */
    melatonin: {
      icon: '🍯',
      title: '褪黑素 · 服用建议',
      body:
        '<p>褪黑素是"报时信号"，不是"安眠药"。它帮你<strong>调整入睡时间</strong>，不负责让你睡得更深。</p>' +
        '<p>推荐剂量为 <span class="num">0.5–3 毫克</span>，在目标入睡时间前 <span class="num">30–60 分钟</span>服用。剂量越大效果并不越好，反而可能加重次日困倦。</p>' +
        '<p>连续使用不建议超过 <span class="num">4 周</span>；倒时差、轮班、入睡节律紊乱的人群更适合短期使用。</p>' +
        '<span class="tip">💡 建议：先试 1 毫克，配合固定作息。孕妇、儿童及自身免疫疾病人群请先咨询医生。</span>'
    },

    pillow: {
      icon: '🛏️',
      title: '枕头 · 睡眠姿势建议',
      body:
        '<p>白皮书指出，<span class="num">38%</span> 的受访者晨起颈肩酸痛，其中过半与枕头高度不合适有关。</p>' +
        '<p>仰睡时枕头高度以 <span class="num">8–12 厘米</span>为宜，侧睡则应与一侧肩宽相当（约 <span class="num">12–15 厘米</span>），才能让颈椎保持水平。</p>' +
        '<p>枕头建议每 <span class="num">1–2 年</span>更换一次；出现塌陷、结块、异味就该淘汰了。</p>' +
        '<span class="tip">💡 建议：仰睡选低一点、侧睡选高一点；仰卧时在膝下垫个小枕，能减轻腰部压力。</span>'
    }
  };

  /* =========================================================
     4. 背景切换：只改 data-on，靠 CSS opacity 过渡
     ========================================================= */
  function syncBackground() {
    var showDay   = state.isDay;
    var showNight = !state.isDay;

    /* 环境光标记：写在 stage 上，物品的亮度滤镜由 CSS 按它走
       day / night-on / night-off 三档，见 style.css「物品跟随环境光变暗」 */
    stage.dataset.env = showDay ? 'day'
                      : (state.isLightOn ? 'night-on' : 'night-off');

    bgDay.dataset.on = showDay ? 'true' : 'false';

    if (showNight) {
      if (state.isLightOn) {
        bgNightOn.dataset.on  = 'true';
        bgNightOff.dataset.on = 'false';
      } else {
        bgNightOn.dataset.on  = 'false';
        bgNightOff.dataset.on = 'true';
      }
    } else {
      /* 白天时两张夜景都关闭，避免残留 */
      bgNightOn.dataset.on  = 'false';
      bgNightOff.dataset.on = 'false';
    }
  }

  /* =========================================================
     5. 通用轻微点击反馈 .tap-feedback
        所有物品（含台灯、窗户）点击瞬间都先播这一下
     ========================================================= */
  function playTapFeedback(el) {
    return new Promise(function (resolve) {
      el.classList.remove('tap-feedback');
      /* 强制回流，保证连点也能重新触发动画 */
      void el.offsetWidth;
      el.classList.add('tap-feedback');

      var done = function () {
        el.classList.remove('tap-feedback');
        el.removeEventListener('animationend', done);
        resolve();
      };
      el.addEventListener('animationend', done);
      /* 兜底：动画事件丢失时也能继续 */
      setTimeout(function () {
        if (el.classList.contains('tap-feedback')) {
          el.classList.remove('tap-feedback');
          resolve();
        }
      }, 260);
    });
  }

  /* =========================================================
     6. 物品放大到屏幕中央
        dx/dy/zoom 由 getBoundingClientRect 实时算出，不改 left/top
     ========================================================= */
  var zoomedEl = null;

  function zoomToCenter(el) {
    var r = el.getBoundingClientRect();
    var stageRect = stage.getBoundingClientRect();

    /* 舞台中心（用舞台而非视口，保证移动端留边时也对齐房间中心） */
    var cx = stageRect.left + stageRect.width / 2;
    var cy = stageRect.top + stageRect.height / 2;

    /* 物品当前中心 */
    var ex = r.left + r.width / 2;
    var ey = r.top + r.height / 2;

    var dx = cx - ex;
    var dy = cy - ey;

    /* 放大倍率：让物品高度约占舞台高度的 52%，并限制在合理区间 */
    var targetH = stageRect.height * 0.52;
    var zoom = targetH / r.height;
    zoom = Math.max(1.6, Math.min(zoom, 4.2));

    el.style.setProperty('--dx', dx + 'px');
    el.style.setProperty('--dy', dy + 'px');
    el.style.setProperty('--zoom', zoom);

    el.classList.add('is-zoomed');
    layerItems.classList.add('has-zoom');
    zoomedEl = el;
  }

  function unzoom() {
    if (!zoomedEl) return;
    zoomedEl.classList.remove('is-zoomed');
    layerItems.classList.remove('has-zoom');
    zoomedEl = null;
  }

  /* =========================================================
     7. 弹层：普通卡片 / 米黄卡片
     ========================================================= */
  var isModalOpen = false;

  function openCard(cfg) {
    var isCream = cfg.cream === true;
    var card    = isCream ? cardCream : cardNormal;
    var other   = isCream ? cardNormal : cardCream;

    other.classList.remove('is-open');

    (isCream ? creamIcon  : normalIcon).textContent  = cfg.icon || '';
    (isCream ? creamTitle : normalTitle).textContent = cfg.title || '';
    (isCream ? creamBody  : normalBody).innerHTML    = cfg.body || '';

    card.classList.add('is-open');
    mask.classList.add('is-open');
    modalHost.classList.add('is-open');
    isModalOpen = true;
  }

  function closeCard() {
    cardNormal.classList.remove('is-open');
    cardCream.classList.remove('is-open');
    mask.classList.remove('is-open');
    modalHost.classList.remove('is-open');
    isModalOpen = false;
  }

  /* 关闭时统一做收尾：物品飞回原位、书本弹回、其他物品恢复亮度 */
  function closeAll() {
    closeCard();
    unzoom();
    fxBook.classList.remove('is-on');
    layerItems.classList.remove('has-book-open');
  }

  mask.addEventListener('click', closeAll);
  closeNormal.addEventListener('click', closeAll);
  closeCream.addEventListener('click', closeAll);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (isModalOpen) closeAll();
    else hideCaption();
  });

  /* =========================================================
    8. 提示条
     ========================================================= */
  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, 1800);
  }

  /* =========================================================
     8b. 字幕条（夜晚点灯时出现的科普字幕）
         文案来源：《失眠症诊断和治疗指南（2025版）》睡眠卫生与光照机制研究
         文字全部由 JS 注入，HTML 里只留一个空壳，改文案只改这一处
     ========================================================= */
  var CAPTION_HTML =
    '<p>根据《失眠症诊断和治疗指南（2025版）》睡眠卫生与光照机制研究，' +
      '人体生物钟由眼部特殊感光细胞调控，对电子屏幕、冷白光中的<strong>短波蓝光</strong>极其敏感。' +
      '睡前接触蓝光会抑制人体核心助眠激素<strong>褪黑素</strong>分泌，打乱生物钟，' +
      '导致入睡困难、睡眠变浅、夜间易醒。</p>' +
    '<p>而<strong>2700–3000K</strong> 暖光含蓝光很少，对生物钟干扰小，不会明显抑制褪黑素；' +
      '柔和光线也能<strong>舒缓情绪</strong>，模拟日落，帮身体慢慢切换到准备入睡的状态。</p>' +
    '<p class="caption__tip">💡 暖光也别开太亮！睡前一小时尽量远离电子屏幕</p>';

  var captionTimer = null;

  function showCaption() {
    captionText.innerHTML = CAPTION_HTML;
    captionEl.classList.add('is-on');
    /* 字幕出现时把开场提示条收掉，底部不会两条文字打架 */
    if (hintEl) hintEl.classList.add('is-off');

    /* 停留 30 秒后自动淡出；期间点 × / 按 Esc / 再点台灯都会重算时间 */
    clearTimeout(captionTimer);
    captionTimer = setTimeout(hideCaption, 30000);
  }

  function hideCaption() {
    clearTimeout(captionTimer);
    captionEl.classList.remove('is-on');
  }

  captionClose.addEventListener('click', hideCaption);

  /* =========================================================
     9. 小工具
     ========================================================= */
  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* =========================================================
     10. 各物品的完整行为
     ========================================================= */
  var ACTIONS = {

    /* ---- 台灯：只切 isLightOn，仅黑夜有效，并带出科普字幕 ----
       灯的"开 / 关"就是 bg-night-on.jpg 与 bg-night-off.jpg 这两张背景图，
       所以这里不做任何光效叠加，只把状态翻一下交给 syncBackground() 交叉淡入。
       夜里点灯 = 亮起画面里的暖光 + 弹出"蓝光 / 暖光"字幕（字幕自己会淡出，
       不需要用户手动关）；白天点它没意义，给一句提示即可。 */
    lamp: function () {
      if (state.isDay) {
        toast('白天不需要开灯');
        return Promise.resolve();
      }
      state.isLightOn = !state.isLightOn;
      syncBackground();
      showCaption();
      /* 等 0.6s 背景过渡走完再解锁，避免连点打断淡入 */
      return wait(620);
    },

    /* ---- 窗户：切换 isDay，切到黑夜默认关灯 ---- */
    window: function () {
      state.isDay = !state.isDay;
      if (!state.isDay) {
        /* 切到黑夜：默认关灯 */
        state.isLightOn = false;
      }
      syncBackground();
      /* 换环境时字幕已经不对应当前场景，直接收掉 */
      hideCaption();
      toast(state.isDay ? '天亮了，阳光抑制褪黑素' : '天黑了，身体开始分泌褪黑素');
      return wait(620);
    },

    /* ---- 书本：弹出"书本弹出.png" + 放大到中央 + 普通卡片 ---- */
    book: function (el) {
      zoomToCenter(el);
      layerItems.classList.add('has-book-open');
      layerFx.classList.add('has-book-open');
      return wait(420).then(function () {
        fxBook.classList.add('is-on');
      }).then(function () {
        return wait(520);
      }).then(function () {
        openCard({
          cream: false,
          icon:  CONTENT.book.icon,
          title: CONTENT.book.title,
          body:  CONTENT.book.body
        });
      });
    },

    /* ---- 褪黑素：放大到屏幕中央 + 米黄卡片 ---- */
    melatonin: function (el) {
      zoomToCenter(el);
      return wait(560).then(function () {
        openCard({
          cream: true,
          icon:  CONTENT.melatonin.icon,
          title: CONTENT.melatonin.title,
          body:  CONTENT.melatonin.body
        });
      });
    },

    /* ---- 眼罩：放大到屏幕中央 + 下方普通卡片 ---- */
    eyemask: function (el) {
      zoomToCenter(el);
      return wait(560).then(function () {
        openCard({
          cream: false,
          icon:  CONTENT.eyemask.icon,
          title: CONTENT.eyemask.title,
          body:  CONTENT.eyemask.body
        });
      });
    },

    /* ---- 枕头：原地左右摇晃两下 + 米黄卡片（不放大） ---- */
    pillow: function (el) {
      return new Promise(function (resolve) {
        el.classList.remove('pillow-shake');
        void el.offsetWidth;
        el.classList.add('pillow-shake');

        var done = function () {
          el.classList.remove('pillow-shake');
          el.removeEventListener('animationend', done);
          resolve();
        };
        el.addEventListener('animationend', done);
        setTimeout(function () {
          if (el.classList.contains('pillow-shake')) {
            el.classList.remove('pillow-shake');
            resolve();
          }
        }, 900);
      }).then(function () {
        openCard({
          cream: true,
          icon:  CONTENT.pillow.icon,
          title: CONTENT.pillow.title,
          body:  CONTENT.pillow.body
        });
      });
    }
  };

  /* =========================================================
     11. 事件绑定：点击事件直接绑在物品 wrapper 上
         热区就是图片本身的区域，没有单独的 .hotspot 层
     ========================================================= */
  function bindItem(el) {
    var key = el.dataset.item;
    var action = ACTIONS[key];
    if (!action) return;

    var run = function () {
      if (busy) return;
      if (isModalOpen) return;      /* 弹层开着时不响应下层点击 */
      busy = true;

      /* 先播统一轻微反馈，再进各自的后续动画 */
      playTapFeedback(el)
        .then(function () { return action(el); })
        .catch(function (err) {
          if (window.console) console.error('[sleep-room]', key, err);
        })
        .then(function () {
          busy = false;
          clearTimeout(safetyTimer);
        });

      /* 保险解锁：即使动画事件丢失也不会卡住 */
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(function () { busy = false; }, 6000);
    };

    el.addEventListener('click', run);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        run();
      }
    });
    /* 阻止拖拽图片产生的原生行为 */
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  ITEMS.forEach(bindItem);

  /* =========================================================
     12. 初始化
     ========================================================= */
  function init() {
    syncBackground();
    /* 舞台尺寸变化时，如果正有物品放大，重新算一次位移，保持居中 */
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (zoomedEl) {
          var el = zoomedEl;
          el.classList.remove('is-zoomed');
          zoomToCenter(el);
        }
      }).observe(stage);
    } else {
      window.addEventListener('resize', function () {
        if (zoomedEl) {
          var el = zoomedEl;
          el.classList.remove('is-zoomed');
          zoomToCenter(el);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
