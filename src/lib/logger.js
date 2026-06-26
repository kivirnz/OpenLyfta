'use strict';

function createLogger(store) {
  const wrapper = {};

  for (const fn of ['log', 'warn', 'error', 'info']) {
    wrapper[fn] = (...args) => {
      const msg = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
      const level = fn === 'log' ? 'info' : fn;
      try { store.addLog(level, msg); } catch {}
      console[fn === 'log' ? 'log' : fn](...args);
    };
  }

  return wrapper;
}

module.exports = { createLogger };