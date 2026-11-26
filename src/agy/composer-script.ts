/**
 * Self-contained browser script injected into Antigravity's main page via CDP.
 * Mounts a compact "Task" selector pill next to the composer model selector.
 */
export function buildComposerInjectionScript(): string {
  return `(function () {
  if (window.__taskmdComposerMounted) {
    if (typeof window.__taskmdRefresh === 'function') window.__taskmdRefresh();
    return;
  }
  window.__taskmdComposerMounted = true;

  var PENDING_KEY = 'taskmd:pendingTaskId';
  var seq = 0;
  var pendingCalls = new Map();
  var cachedState = { tasks: [], bindings: [] };
  var openMenu = null;
  var bindingInFlight = false;

  function currentConversationId() {
    var m = location.pathname.match(/^\\/c\\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function callBridge(action, payload) {
    return new Promise(function (resolve, reject) {
      if (typeof window.__taskmdBridge !== 'function') {
        reject(new Error('Taskmd bridge unavailable'));
        return;
      }
      var id = ++seq;
      var timer = setTimeout(function () {
        pendingCalls.delete(id);
        reject(new Error('Taskmd bridge timeout'));
      }, 6000);
      pendingCalls.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        window.__taskmdBridge(JSON.stringify({ id: id, action: action, payload: payload || {} }));
      } catch (err) {
        clearTimeout(timer);
        pendingCalls.delete(id);
        reject(err);
      }
    });
  }

  window.__taskmdResolve = function (id, ok, result) {
    var entry = pendingCalls.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingCalls.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error((result && result.error) || 'Taskmd bridge error'));
  };

  function getPendingTaskId() {
    try { return sessionStorage.getItem(PENDING_KEY) || ''; } catch (_) { return ''; }
  }
  function setPendingTaskId(taskId) {
    try {
      if (taskId) sessionStorage.setItem(PENDING_KEY, taskId);
      else sessionStorage.removeItem(PENDING_KEY);
    } catch (_) {}
  }

  function activeTaskForCurrentView(cid) {
    if (cid) {
      var binding = (cachedState.bindings || []).find(function (b) { return b.sessionId === cid; });
      if (!binding) return null;
      return (cachedState.tasks || []).find(function (t) { return t.id === binding.taskId; }) || { id: binding.taskId, title: binding.taskId.slice(0, 8) };
    }
    var pendingId = getPendingTaskId();
    if (!pendingId) return null;
    return (cachedState.tasks || []).find(function (t) { return t.id === pendingId; }) || null;
  }

  async function maybeAutoBindDraft() {
    var cid = currentConversationId();
    var pendingId = getPendingTaskId();
    if (!cid || !pendingId || bindingInFlight) return;
    bindingInFlight = true;
    try {
      await callBridge('bind', { taskId: pendingId, sessionId: cid });
      setPendingTaskId('');
      await refreshState();
    } catch (_) {
    } finally {
      bindingInFlight = false;
    }
  }

  async function refreshState() {
    try {
      var next = await callBridge('getState', {});
      if (next && Array.isArray(next.tasks)) {
        cachedState = next;
        updateAllPills();
      }
    } catch (_) {}
  }

  window.__taskmdNotify = function () {
    void refreshState();
  };

  function ensureStyles() {
    if (document.getElementById('taskmd-composer-style')) return;
    var style = document.createElement('style');
    style.id = 'taskmd-composer-style';
    style.textContent = [
      '.taskmd-cp-wrap{position:relative;display:inline-flex;align-items:center;margin-inline-start:4px;font-family:inherit}',
      '.taskmd-cp-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--border,rgba(128,128,128,.28));background:transparent;color:var(--muted-foreground,inherit);font-size:12px;line-height:1;cursor:pointer;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.taskmd-cp-btn:hover{background:var(--accent,rgba(128,128,128,.12));color:var(--foreground,inherit)}',
      '.taskmd-cp-btn.is-active{border-color:var(--primary,#557ee8);color:var(--foreground,inherit);background:color-mix(in srgb,var(--primary,#557ee8) 12%,transparent)}',
      '.taskmd-cp-label{overflow:hidden;text-overflow:ellipsis}',
      '.taskmd-cp-menu{position:fixed;z-index:99999;min-width:240px;max-width:300px;max-height:300px;display:flex;flex-direction:column;border-radius:10px;border:1px solid var(--border,rgba(128,128,128,.3));background:var(--popover,var(--background,#1e1e1e));color:var(--popover-foreground,var(--foreground,#eee));box-shadow:0 10px 28px rgba(0,0,0,.28);padding:6px;gap:4px}',
      '.taskmd-cp-search{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--border,rgba(128,128,128,.28));background:transparent;color:inherit;font-size:12px;outline:none}',
      '.taskmd-cp-list{overflow:auto;max-height:210px;display:flex;flex-direction:column;gap:2px}',
      '.taskmd-cp-item{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;text-align:left;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer}',
      '.taskmd-cp-item:hover{background:var(--accent,rgba(128,128,128,.15))}',
      '.taskmd-cp-item.is-selected{background:color-mix(in srgb,var(--primary,#557ee8) 18%,transparent);font-weight:600}',
      '.taskmd-cp-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.taskmd-cp-empty{padding:8px;font-size:12px;opacity:.65;text-align:center}',
      '.taskmd-cp-clear{border-top:1px solid var(--border,rgba(128,128,128,.2));margin-top:2px;padding-top:4px}'
    ].join('');
    document.head.appendChild(style);
  }

  function closeMenu() {
    if (openMenu && openMenu.parentNode) openMenu.parentNode.removeChild(openMenu);
    openMenu = null;
  }

  function renderMenu(anchor) {
    closeMenu();
    var cid = currentConversationId();
    var active = activeTaskForCurrentView(cid);
    var rect = anchor.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.className = 'taskmd-cp-menu';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 260)) + 'px';
    menu.style.bottom = Math.max(12, window.innerHeight - rect.top + 6) + 'px';

    var search = document.createElement('input');
    search.className = 'taskmd-cp-search';
    search.type = 'search';
    search.placeholder = cid ? '关联当前会话到任务…' : '选择发送后自动绑定的任务…';
    menu.appendChild(search);

    var list = document.createElement('div');
    list.className = 'taskmd-cp-list';
    menu.appendChild(list);

    function drawList(filter) {
      list.innerHTML = '';
      var q = (filter || '').trim().toLowerCase();
      var tasks = (cachedState.tasks || []).filter(function (t) {
        return !q || t.title.toLowerCase().indexOf(q) !== -1;
      });
      if (!tasks.length) {
        var empty = document.createElement('div');
        empty.className = 'taskmd-cp-empty';
        empty.textContent = (cachedState.tasks || []).length ? '无匹配任务' : '尚未配置 Home 或暂无任务';
        list.appendChild(empty);
        return;
      }
      tasks.forEach(function (task) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'taskmd-cp-item' + (active && active.id === task.id ? ' is-selected' : '');
        var span = document.createElement('span');
        span.className = 'taskmd-cp-item-title';
        span.textContent = task.title;
        btn.appendChild(span);
        btn.addEventListener('click', async function (e) {
          e.stopPropagation();
          closeMenu();
          if (cid) {
            await callBridge('bind', { taskId: task.id, sessionId: cid }).catch(function () {});
            await refreshState();
          } else {
            setPendingTaskId(task.id);
            updateAllPills();
          }
        });
        list.appendChild(btn);
      });
    }

    search.addEventListener('input', function () { drawList(search.value); });
    drawList('');

    if (active) {
      var clearWrap = document.createElement('div');
      clearWrap.className = 'taskmd-cp-clear';
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'taskmd-cp-item';
      clearBtn.textContent = cid ? '解除当前任务关联' : '取消待绑定任务';
      clearBtn.addEventListener('click', async function (e) {
        e.stopPropagation();
        closeMenu();
        if (cid) {
          await callBridge('unbind', { taskId: active.id, sessionId: cid }).catch(function () {});
          await refreshState();
        } else {
          setPendingTaskId('');
          updateAllPills();
        }
      });
      clearWrap.appendChild(clearBtn);
      menu.appendChild(clearWrap);
    }

    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(menu);
    openMenu = menu;
    setTimeout(function () { search.focus(); }, 0);
  }

  function updatePillElement(wrap) {
    var btn = wrap.querySelector('.taskmd-cp-btn');
    var label = wrap.querySelector('.taskmd-cp-label');
    if (!btn || !label) return;
    var cid = currentConversationId();
    var active = activeTaskForCurrentView(cid);
    if (active) {
      btn.classList.add('is-active');
      label.textContent = cid ? active.title : (active.title + ' (待绑定)');
      btn.title = cid ? ('当前已关联任务：' + active.title) : ('发送消息后自动绑定到：' + active.title);
    } else {
      btn.classList.remove('is-active');
      label.textContent = '关联任务';
      btn.title = cid ? '将当前会话关联到 Taskmd 任务' : '选择任务（发送消息后自动绑定）';
    }
  }

  function updateAllPills() {
    document.querySelectorAll('[data-taskmd-composer-mount="1"]').forEach(updatePillElement);
  }

  function mountPills() {
    ensureStyles();
    var triggers = document.querySelectorAll('[data-testid="model-selector-trigger"]');
    triggers.forEach(function (model) {
      var card = model.closest('.surface-composer-card');
      if (!card) return;
      var anchor = model;
      while (anchor.parentElement && getComputedStyle(anchor.parentElement).display !== 'flex') {
        anchor = anchor.parentElement;
      }
      var parent = anchor.parentElement;
      if (!parent) return;
      if (parent.querySelector('[data-taskmd-composer-mount="1"]')) return;

      var wrap = document.createElement('span');
      wrap.setAttribute('data-taskmd-composer-mount', '1');
      wrap.className = 'taskmd-cp-wrap';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'taskmd-cp-btn';
      var icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '📌';
      var label = document.createElement('span');
      label.className = 'taskmd-cp-label';
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (openMenu) closeMenu();
        else {
          void refreshState();
          renderMenu(btn);
        }
      });
      wrap.appendChild(btn);
      parent.insertBefore(wrap, anchor.nextSibling);
      updatePillElement(wrap);
    });
  }

  document.addEventListener('click', function () { closeMenu(); });

  var lastPath = location.pathname;
  function tickRoute() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      closeMenu();
      void maybeAutoBindDraft();
      updateAllPills();
    }
    mountPills();
  }

  var observer = new MutationObserver(function () { mountPills(); });
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(tickRoute, 500);
  window.addEventListener('popstate', tickRoute);

  mountPills();
  void maybeAutoBindDraft();
  void refreshState();
})();`;
}
