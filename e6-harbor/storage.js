(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.HarborStorage = factory(root.HarborCore);
})(typeof globalThis === 'object' ? globalThis : this, function (Core) {
  'use strict';
  const KEY = 'e6-harbor.rota.v1';
  function open(getStorage) {
    let storage;
    let raw = null;
    let state;
    let warning = '';
    let locked = false;
    try { storage = getStorage(); raw = storage.getItem(KEY); }
    catch { warning = 'Browser storage is unavailable. Changes will last only in this tab; keep it open.'; }
    if (raw !== null) {
      try { state = Core.validateState(JSON.parse(raw)); }
      catch {
        locked = true;
        warning = 'Saved data could not be read safely. It has NOT been overwritten. A temporary demo is shown; reload after repairing the saved data. Changes here will not be saved.';
      }
    }
    state ||= Core.demo();
    return {
      state, warning,
      save(next) {
        Core.validateState(next);
        if (locked) return 'Saved data is protected. This change is temporary and will not survive a reload.';
        if (!storage) return 'Browser storage is unavailable. This change is temporary; keep this tab open.';
        try {
          if (storage.getItem(KEY) !== raw) {
            locked = true;
            return 'Another tab changed the saved rota. This tab will not overwrite it. Your current changes are temporary; reload to use the saved version.';
          }
          const encoded = JSON.stringify(next);
          storage.setItem(KEY, encoded);
          raw = encoded;
          return '';
        } catch { return 'Could not save in this browser (storage may be full or blocked). This change is temporary; keep this tab open.'; }
      }
    };
  }
  return Object.freeze({ KEY, open });
});
