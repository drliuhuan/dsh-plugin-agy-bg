/* ------------------------------------------------------------------
   DSH Web UI glue.

   The particle engine above is the same one shipped in `antigravity-bg/`.
   This half integrates it with the Harness shell:

     * a fixed canvas behind the app window (z-index -1);
     * the shell's fully-opaque page surfaces are tagged so the canvas can
       show through them, while the sidebar, composer, cards and dialogs keep
       their own backgrounds;
     * a Settings → General switch that turns the whole thing on/off
       (persisted in localStorage, default on);
     * light/dark palettes follow the shell's `body[data-ds-dark-theme]`.
   ------------------------------------------------------------------ */

  var PLUGIN_ID = 'dsh-plugin-antigravity-bg';
  var STORAGE_KEY = 'dsh-plugin-antigravity-bg:v1';
  var LOCALE_NS = 'antigravity-bg';
  var SURFACE_ATTR = 'data-dsh-antigravity-surface';
  var FADE_ATTR = 'data-dsh-antigravity-fade';
  var CANVAS_ID = 'dsh-antigravity-canvas';
  var STYLE_ID = 'dsh-antigravity-style';

  /** React runtime handed to the factory by the harness module loader. */
  var React = null;
  /** Locale face captured on apply, used to re-render the switch copy. */
  var localeFace = null;
  /** The live background manager (one per plugin load). */
  var background = null;

  var EN = {
    title: 'Antigravity particle background',
    description: 'A mouse-following WebGL particle field behind the interface, recreated from antigravity.google. The ring follows your cursor; turn it off here for a plain background.',
    on: 'Particle background on',
    off: 'Particle background off',
    switchOn: 'Turn particle background off',
    switchOff: 'Turn particle background on'
  };

  var ZH = {
    title: 'Antigravity 粒子背景',
    description: '在界面背后铺一层跟随鼠标的 WebGL 粒子场，复刻自 antigravity.google。粒子环会跟着光标走；不想要时在这里关掉，恢复纯色背景。',
    on: '粒子背景已开启',
    off: '粒子背景已关闭',
    switchOn: '关闭粒子背景',
    switchOff: '开启粒子背景'
  };

  /* ---------------- preference state ---------------- */

  function readPreference() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { enabled: true };
      var parsed = JSON.parse(raw);
      return { enabled: parsed.enabled !== false };
    } catch (err) {
      return { enabled: true };
    }
  }

  function writePreference(preference) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
    } catch (err) {
      // A private-mode browser without storage still gets a working toggle.
    }
  }

  var preference = readPreference();
  var preferenceListeners = new Set();

  function getPreferenceEnabled() {
    return preference.enabled;
  }

  function setPreferenceEnabled(value) {
    var next = value !== false;
    if (preference.enabled === next) return;
    preference = { enabled: next };
    writePreference(preference);
    preferenceListeners.forEach(function (listener) {
      try { listener(); } catch (err) { /* keep other subscribers alive */ }
    });
    if (background) background.setEnabled(next);
  }

  function subscribePreference(listener) {
    preferenceListeners.add(listener);
    return function () { preferenceListeners.delete(listener); };
  }

  /* ---------------- color / theme helpers ---------------- */

  function parseRgb(value) {
    if (typeof value !== 'string') return null;
    var match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function sameRgb(a, b) {
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2 && Math.abs(a[2] - b[2]) < 2;
  }

  function themeName() {
    return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
  }

  /** Resolve the shell's current `--dsw-alias-bg-base` to an rgb() string. */
  function readBaseColor() {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;background:var(--dsw-alias-bg-base)';
    document.body.appendChild(probe);
    var color = window.getComputedStyle(probe).backgroundColor;
    probe.remove();
    if (!parseRgb(color)) color = window.getComputedStyle(document.body).backgroundColor;
    return color;
  }

  /** The shell frame (the full-window grid that owns the sidebar and center). */
  function findShellFrame() {
    var candidates = document.querySelectorAll('[class*="_frame"]');
    var width = window.innerWidth;
    var height = window.innerHeight;
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < candidates.length; i++) {
      var element = candidates[i];
      var rect = element.getBoundingClientRect();
      if (rect.width < width * 0.98 || rect.height < height * 0.9) continue;
      var area = rect.width * rect.height;
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    return best;
  }

  /* ---------------- background manager ---------------- */

  var CANVAS_CSS = [
    '#dsh-antigravity-canvas{position:fixed;inset:0;display:block;width:100%;height:100%;',
    'z-index:-1;pointer-events:none;opacity:0;transition:opacity .5s ease}',
    '#dsh-antigravity-canvas[data-visible="true"]{opacity:.94}',
    // Tagged by the manager: only full-page surfaces lose their fill, so the
    // particle field shows through the workspace while every control keeps its
    // own background.
    '[data-dsh-antigravity-surface="transparent"]{background-color:transparent !important;',
    'background-image:none !important}',
    // The shell paints a 36px gradient above the composer so scrolled content
    // fades into the page background. With a particle field behind the page that
    // gradient reads as a solid band, so the tag removes it.
    '[data-dsh-antigravity-fade="off"]{background-image:none !important}',
    '[data-dsh-antigravity-fade="off"]::before,[data-dsh-antigravity-fade="off"]::after{',
    'background-image:none !important}'
  ].join('');

  var ROW_CSS = [
    '.abg_row{display:flex;align-items:center;gap:8px;padding:16px 0;',
    'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
    '.abg_text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
    '.abg_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
    '.abg_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
    '.abg_switch{position:relative;flex:0 0 auto;width:40px;height:22px;padding:0;border:none;',
    'border-radius:999px;background:var(--dsw-alias-bg-layer-3);',
    'box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);cursor:pointer;',
    'transition:background .18s ease}',
    '.abg_switch[data-on="true"]{background:var(--dsw-alias-state-business-primary);',
    'box-shadow:none}',
    '.abg_switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,',
    'var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.abg_knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;',
    'background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .18s ease}',
    '.abg_switch[data-on="true"] .abg_knob{transform:translateX(18px)}'
  ].join('');

  function createBackground() {
    var canvas = null;
    var field = null;
    var marked = [];
    var faded = [];
    var styleElement = null;
    var frameId = 0;
    var lastTime = 0;
    var scanTimer = 0;
    var scanDebounce = 0;
    var themeObserver = null;
    var active = false;

    function loop(now) {
      if (!active) return;
      frameId = window.requestAnimationFrame(loop);
      if (!field || !field.ready || document.hidden) return;
      var dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.1);
      lastTime = now;
      field.frame(dt);
    }

    function mark(element) {
      if (!element || element.hasAttribute(SURFACE_ATTR)) return;
      element.setAttribute(SURFACE_ATTR, 'transparent');
      marked.push(element);
    }

    function markFade(element) {
      if (!element || element.hasAttribute(FADE_ATTR)) return;
      element.setAttribute(FADE_ATTR, 'off');
      faded.push(element);
    }

    /**
     * The composer sits on a `.composerSeat` layer that fades scrolled content
     * into the page background with a short linear gradient. Tag that layer (and
     * any gradient ancestor of the composer input) so the canvas stays visible
     * right up to the input box.
     */
    function syncComposerFade() {
      if (!active) return;
      var center = document.querySelector('[class*="_centerCol"]');
      if (!center) return;

      var seats = center.querySelectorAll('[class*="_composerSeat"]');
      for (var i = 0; i < seats.length; i++) markFade(seats[i]);

      var input = center.querySelector('textarea, [contenteditable="true"], input[type="text"]');
      var node = input;
      var guard = 0;
      while (node && node !== center && guard < 12) {
        var self = window.getComputedStyle(node).backgroundImage;
        var before = window.getComputedStyle(node, '::before').backgroundImage;
        var after = window.getComputedStyle(node, '::after').backgroundImage;
        if ((self && self !== 'none') || (before && before !== 'none') || (after && after !== 'none')) {
          markFade(node);
        }
        node = node.parentElement;
        guard++;
      }
    }

    /**
     * Tag the shell frame plus every large page surface in the center column
     * whose fill is exactly the theme base color. The size thresholds leave the
     * composer, cards, and side panels opaque.
     */
    function syncSurfaces() {
      if (!active || !field || !field.ready) return;
      var base = parseRgb(readBaseColor());
      mark(findShellFrame());

      var center = document.querySelector('[class*="_centerCol"]');
      if (!center || !base) return;
      var centerRect = center.getBoundingClientRect();
      if (centerRect.width <= 0 || centerRect.height <= 0) return;

      syncComposerFade();

      var nodes = center.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var element = nodes[i];
        if (element.hasAttribute(SURFACE_ATTR)) continue;
        var style = window.getComputedStyle(element);
        if (!sameRgb(parseRgb(style.backgroundColor), base)) continue;
        var rect = element.getBoundingClientRect();
        if (rect.width < centerRect.width * 0.85) continue;
        if (rect.height < centerRect.height * 0.5) continue;
        mark(element);
      }
    }

    function scheduleScan() {
      if (!active || scanDebounce) return;
      scanDebounce = window.setTimeout(function () {
        scanDebounce = 0;
        syncSurfaces();
      }, 320);
    }

    function syncPalette() {
      if (!field) return;
      var next = THEMES[themeName()];
      if (field.palette !== next) field.palette = next;
    }

    function onResize() {
      if (!field) return;
      field.resize();
      scheduleScan();
    }

    function onVisibilityChange() {
      lastTime = performance.now();
    }

    function onThemeMutation() {
      if (!active) return;
      syncPalette();
      scheduleScan();
    }

    function start() {
      if (active) return;

      styleElement = document.createElement('style');
      styleElement.id = STYLE_ID;
      styleElement.textContent = CANVAS_CSS;
      document.head.appendChild(styleElement);

      canvas = document.createElement('canvas');
      canvas.id = CANVAS_ID;
      canvas.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(canvas, document.body.firstChild);

      field = new ParticleField(canvas, {
        theme: themeName(),
        // Same configuration as antigravity.google's hero section.
        density: 230,
        particlesScale: 0.59,
        ringWidth: 0.006,
        ringWidth2: 0.107,
        ringDisplacement: 0.62
      });

      if (!field.ready) {
        stop();
        return;
      }

      active = true;
      syncSurfaces();
      syncPalette();

      window.addEventListener('resize', onResize);
      window.addEventListener('click', scheduleScan, { passive: true });
      document.addEventListener('visibilitychange', onVisibilityChange);

      if (typeof MutationObserver === 'function') {
        themeObserver = new MutationObserver(onThemeMutation);
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['data-ds-dark-theme']
        });
      }

      // Page surfaces can be replaced by client-side navigation; a cheap scan
      // every couple of seconds keeps the transparency tags on the right
      // elements without observing every DOM mutation.
      scanTimer = window.setInterval(syncSurfaces, 2000);

      lastTime = performance.now();
      frameId = window.requestAnimationFrame(loop);
      window.requestAnimationFrame(function () {
        if (canvas) canvas.setAttribute('data-visible', 'true');
      });
    }

    function stop() {
      active = false;
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      if (scanTimer) {
        window.clearInterval(scanTimer);
        scanTimer = 0;
      }
      if (scanDebounce) {
        window.clearTimeout(scanDebounce);
        scanDebounce = 0;
      }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('click', scheduleScan);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (themeObserver) {
        themeObserver.disconnect();
        themeObserver = null;
      }
      for (var i = 0; i < marked.length; i++) {
        try { marked[i].removeAttribute(SURFACE_ATTR); } catch (err) { /* detached */ }
      }
      marked = [];
      for (var j = 0; j < faded.length; j++) {
        try { faded[j].removeAttribute(FADE_ATTR); } catch (err) { /* detached */ }
      }
      faded = [];
      if (field && typeof field.dispose === 'function') field.dispose();
      field = null;
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      if (styleElement && styleElement.parentNode) styleElement.parentNode.removeChild(styleElement);
      styleElement = null;
    }

    var api = {
      setEnabled: function (value) {
        if (value) start();
        else stop();
      },
      dispose: function () {
        stop();
        if (window.__DSH_ANTIGRAVITY_BG__ === api) delete window.__DSH_ANTIGRAVITY_BG__;
      },
      get active() { return active; }
    };
    return api;
  }

  /* ---------------- Settings row ---------------- */

  function fallbackTranslate(key) {
    return EN[key] || key;
  }

  function usePreference() {
    var state = React.useState(getPreferenceEnabled());
    var setValue = state[1];
    React.useEffect(function () {
      return subscribePreference(function () { setValue(getPreferenceEnabled()); });
    }, []);
    return state[0];
  }

  function useLocaleTick() {
    var bump = React.useState(0)[1];
    React.useEffect(function () {
      if (!localeFace || typeof localeFace.subscribe !== 'function') return undefined;
      return localeFace.subscribe(function () { bump(function (value) { return value + 1; }); });
    }, []);
  }

  function AntigravityRow(props) {
    var translate = typeof props.t === 'function' ? props.t : fallbackTranslate;
    var enabled = usePreference();
    useLocaleTick();

    return React.createElement(
      React.Fragment,
      null,
      React.createElement('style', {
        key: 'style',
        dangerouslySetInnerHTML: { __html: ROW_CSS }
      }),
      React.createElement(
        'div',
        { key: 'row', className: 'abg_row' },
        React.createElement(
          'div',
          { className: 'abg_text' },
          React.createElement('div', {
            className: 'abg_title',
            children: translate('title')
          }),
          React.createElement('div', {
            className: 'abg_desc',
            children: translate('description')
          })
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'abg_switch',
            'data-on': enabled ? 'true' : 'false',
            'aria-checked': enabled ? 'true' : 'false',
            'aria-label': translate(enabled ? 'switchOn' : 'switchOff'),
            title: translate(enabled ? 'switchOn' : 'switchOff'),
            onClick: function () { setPreferenceEnabled(!enabled); }
          },
          React.createElement('span', { className: 'abg_knob' })
        )
      )
    );
  }

  /* ---------------- module loading ---------------- */

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        React = require('react');
        return {
          inject: ['slots', 'locale'],
          apply: function (ctx) {
            // HMR can reload this bundle without running the previous copy's
            // teardown; drop the old manager before replacing it.
            var previous = window.__DSH_ANTIGRAVITY_BG__;
            if (previous && typeof previous.dispose === 'function') {
              try { previous.dispose(); } catch (err) { /* already gone */ }
            }

            background = createBackground();
            window.__DSH_ANTIGRAVITY_BG__ = background;
            if (getPreferenceEnabled()) background.setEnabled(true);

            localeFace = ctx.locale;

            ctx.effect(function () {
              return function () {
                if (background) {
                  background.dispose();
                  background = null;
                }
              };
            }, PLUGIN_ID + ': background');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'en', EN);
            }, PLUGIN_ID + ': en dictionary');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'zh', ZH);
            }, PLUGIN_ID + ': zh dictionary');

            ctx.slots.inject('settings.general.item', function () {
              return ctx.slots.register({
                name: 'settings.general.item',
                id: 'antigravity-bg',
                order: 14,
                locale: LOCALE_NS
              }, AntigravityRow);
            });
          }
        };
      }
    });
  }
