import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const engine = readFileSync(new URL('../src/engine.part.js', import.meta.url), 'utf8');
const plugin = readFileSync(new URL('../src/plugin.part.js', import.meta.url), 'utf8');
function environment(stored = null) {
  const callbacks = new Map();
  let id = 0;
  const context = vm.createContext({
    console, performance: { now: () => 0 },
    window: {
      matchMedia: () => ({ matches: false }),
      localStorage: { getItem: () => stored, setItem: (key, value) => { stored = value; } },
      requestAnimationFrame: fn => { callbacks.set(++id, fn); return id; },
      cancelAnimationFrame: id => callbacks.delete(id),
      removeEventListener: () => {},
    }, document: { hidden: false },
  });
  vm.runInContext(engine + '\n' + plugin, context);
  return { context, callbacks, stored: () => stored };
}

test('old preferences default to 60 FPS and frame-rate changes preserve enabled state', () => {
  const env = environment('{"enabled":false}');
  assert.equal(vm.runInContext('preference.fps', env.context), 60);
  vm.runInContext('setFps(30)', env.context);
  assert.deepEqual(JSON.parse(env.stored()), { enabled: false, fps: 30 });
  vm.runInContext('setFps(120)', env.context);
  assert.equal(vm.runInContext('targetFps()', env.context), 60);
  vm.runInContext('highRefresh = true', env.context);
  assert.equal(vm.runInContext('targetFps()', env.context), 120);
});

// Run the actual manager loop with synthetic browser presentation timestamps.
function runLoop(hz, fps) {
  const env = environment();
  const start = plugin.indexOf('    function loop(now)');
  const end = plugin.indexOf('\n    function mark(', start);
  vm.runInContext(`
    var active = true, frameId = 0, lastTime = 0, lastRenderTime = 0;
    var frameBudget = 0, refreshTime = 0, refreshSamples = [];
    var draws = 0, seconds = 0;
    var field = { ready: true, frame: dt => { draws++; seconds += dt; return true; } };
    preference.fps = ${fps}; highRefresh = true;
    ${plugin.slice(start, end)}
  `, env.context);
  for (let i = 1; i <= hz * 2; i++) vm.runInContext(`loop(${i * 1000 / hz})`, env.context);
  return vm.runInContext('({draws, seconds, highRefresh})', env.context);
}

test('30/60/120 FPS budgets on 60/120/144/165 Hz keep real elapsed time', () => {
  for (const hz of [60, 120, 144, 165]) {
    for (const fps of [30, 60, 120]) {
      const result = runLoop(hz, fps);
      const expected = Math.min(hz, fps === 120 && hz === 60 ? 60 : fps) * 2;
      assert.ok(Math.abs(result.draws - expected) <= 1, `${hz}Hz / ${fps}FPS: ${result.draws}`);
      assert.ok(Math.abs(result.seconds - 2) < 0.04);
      assert.equal(result.highRefresh, hz >= 120);
    }
  }
});

test('simulation limits work to occupied rows and cleanup is idempotent', () => {
  const env = environment();
  vm.runInContext(`
    var calls = [];
    var gl = new Proxy({}, { get: (_, key) => {
      if (key === 'getExtension') return () => null;
      if (/^[A-Z_0-9]+$/.test(key)) return key;
      return (...args) => calls.push([key, ...args]);
    }});
    var field = Object.create(ParticleField.prototype);
    Object.assign(field, { gl, ready:true, count:3800, simUniforms:{},
      opts:{}, targets:[{texture:'a',framebuffer:'fa'}, {texture:'b',framebuffer:'fb'}],
      posTex:'ref', uvBuffer:'uv', vao:'vao', simProgram:'sim', renderProgram:'render' });
    field.simulate(1/60, 0.2);
    field.dispose(); field.dispose();
  `, env.context);
  const calls = JSON.parse(vm.runInContext('JSON.stringify(calls)', env.context));
  assert.deepEqual(calls.find(call => call[0] === 'scissor'), ['scissor', 0, 0, 256, 15]);
  assert.equal(calls.filter(call => call[0] === 'deleteTexture').length, 3);
  assert.equal(calls.filter(call => call[0] === 'deleteFramebuffer').length, 2);
  assert.equal(calls.filter(call => call[0] === 'deleteProgram').length, 2);
});

test('settings detects high refresh even with the background disabled and cancels probing on unmount', () => {
  for (const hz of [60, 120, 144]) {
    const env = environment('{"enabled":false}');
    vm.runInContext(`
      var effects = [];
      React = { useState: value => [value, () => {}], useEffect: fn => effects.push(fn),
        createElement: () => ({}), Fragment: 'fragment' };
      AntigravityRow({});
      var cleanups = effects.map(fn => fn());
    `, env.context);
    for (let i = 1; i <= 91; i++) {
      const pending = [...env.callbacks.values()];
      env.callbacks.clear();
      pending.forEach(fn => fn(i * 1000 / hz));
    }
    assert.equal(vm.runInContext('highRefresh', env.context), hz >= 120);
    vm.runInContext('cleanups.forEach(fn => { if (fn) fn(); })', env.context);
    assert.equal(env.callbacks.size, 0);
  }
});

test('unchanged surfaces skip the full DOM scan', () => {
  const env = environment();
  const start = plugin.indexOf('    function syncSurfaces()');
  const end = plugin.indexOf('    function scheduleScan()', start);
  vm.runInContext(`
    var active=true, field={ready:true}, surfaceDirty=false;
    var marked=[{isConnected:false},{isConnected:true}];
    document.querySelector=()=>{throw new Error('unnecessary scan');};
    ${plugin.slice(start,end)}
    syncSurfaces();
  `, env.context);
  assert.equal(vm.runInContext('marked.length', env.context), 1);
});

test('plugin leaves the native composer and its scroll tree untouched', () => {
  assert.doesNotMatch(plugin, /seat\.appendChild|seat\.style|veil\.style|markFade|syncComposerFade/);
  assert.doesNotMatch(plugin, /dsh-antigravity-veil|background-image:none !important}.*::before/);
  assert.match(plugin, /element\.closest\('\[data-composer-seat\]'\)/);
});
