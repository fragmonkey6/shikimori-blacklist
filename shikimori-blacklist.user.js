// ==UserScript==
// @name         Shikimori — Чёрный список
// @namespace    shikimori-local-blacklist
// @version      1.4.0
// @description  Автоматические метки «Вы в ЧС» возле авторов комментариев. Локально, с кэшем, без отправки сообщений.
// @match        https://shikimori.io/*
// @match        https://shikimori.one/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = 1, CAP = 10000;
  const CACHE_MS = 2 * 60 * 1000, ERROR_CACHE_MS = 15 * 60 * 1000;
  const HOSTS = new Set(['shikimori.io', 'shikimori.one']);
  const norm = s => String(s || '').replace(/\s+/gu, ' ').trim();
  const keyOf = s => s.toLocaleLowerCase('ru');
  const segment = s => encodeURIComponent(s.replace(/ /g, '+')).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const stamp = () => new Date().toISOString();
  function profile(raw) {
    try {
      if (typeof raw !== "string" || !raw) return null;
      const u = new URL(raw, location.origin);
      if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.port || u.username || u.password) return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const nick = decodeURIComponent(parts[0]).replace(/\+/g, ' ');
      if (!nick || nick.length > 100 || /[\x00-\x1f\x7f/\\]/u.test(nick)) return null;
      return { nick, path: '/' + segment(nick) };
    } catch { return null; }
  }
  function identity(doc) {
    try {
      const data = JSON.parse(doc.body.getAttribute('data-user'));
      const p = profile(data.url);
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || !p) return null;
      return { ...p, id: data.id };
    } catch { return null; }
  }
  // Only server-owned editor markup is evidence; message bodies are never inspected.
  function classify(doc, me, target) {
    const user = identity(doc);
    if (!user || user.id !== me.id) throw new Error('Сессия изменилась или требуется вход');
    if (doc.body.id !== 'dialogs_show') return { status: 'unknown', reason: 'Не распознана страница диалога' };
    const full = doc.querySelector('[data-dynamic="full_dialog"]');
    const editor = full && Array.from(full.children).find(n => n.classList.contains('editor-container'));
    if (!editor) return { status: 'unknown', reason: 'Нет системного блока редактора' };
    const peer = Array.from(doc.querySelectorAll('.subheadline .b-user16 a[href]')).map(a => profile(a.getAttribute('href'))).find(p => p && keyOf(p.nick) === keyOf(target.nick));
    if (!peer) return { status: 'unknown', reason: 'Не подтверждён адресат диалога' };
    const headings = Array.from(editor.children).filter(n => n.classList.contains('subheadline'));
    const blocked = headings.some(h => /добавил(?:\(а\)|а)? тебя в игнор/iu.test(norm(h.textContent)));
    const forms = Array.from(editor.querySelectorAll('form')).filter(f => {
      const action = new URL(f.getAttribute('action') || '', location.origin);
      return action.origin === location.origin && action.pathname === '/api/messages' &&
        f.querySelector('textarea[name="message[body]"]:not([disabled])') &&
        f.querySelector('input[name="message[from_id]"]')?.value === String(me.id) &&
        /^[1-9]\d*$/.test(f.querySelector('input[name="message[to_id]"]')?.value || '');
    });
    if (blocked && forms.length) return { status: 'unknown', reason: 'Противоречивая разметка' };
    if (blocked) return { status: 'blocked', reason: 'Системное уведомление: добавил(а) тебя в игнор' };
    if (forms.length === 1) return { status: 'not_blocked', reason: 'Доступна обычная форма диалога' };
    return { status: 'unknown', reason: 'Нет подтверждённого уведомления или формы' };
  }
  function collect(doc) {
    const result = new Map();
    for (const a of doc.querySelectorAll('.b-user16 a[href], a.b-user[href], .b-user a[href], .b-dialog .name-date a.name[href], .b-comment header a.name[href]')) {
      const p = profile(a.getAttribute('href'));
      if (p) result.set(keyOf(p.nick), p);
    }
    return [...result.values()];
  }
  function csvCell(value) {
    let s = String(value ?? '');
    if (/^[\s]*[=+@\-]/u.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function fresh(me) {
    return { version: VERSION, account: { id: me.id, nick: me.nick }, rows: [], dialogsNext: 1, errors: [], cooldown: 0, nextRequestAt: 0 };
  }
  function cached(row, now = Date.now()) {
    if (!row?.checkedAt || row.status === 'pending') return false;
    const age = now - Date.parse(row.checkedAt);
    return age >= 0 && (row.status === 'blocked' || age < (['error', 'unknown'].includes(row.status) ? ERROR_CACHE_MS : CACHE_MS));
  }
  function nextCandidate(candidates, rows, ownNick, entered = new Set()) {
    return candidates.filter(p => keyOf(p.nick) !== keyOf(ownNick) && (!cached(rows.get(keyOf(p.nick))) || entered.has(keyOf(p.nick))))
      .sort((a, b) => (Number(entered.has(keyOf(b.nick))) - Number(entered.has(keyOf(a.nick)))) || (Date.parse(rows.get(keyOf(a.nick))?.checkedAt) || 0) - (Date.parse(rows.get(keyOf(b.nick))?.checkedAt) || 0))[0];
  }
  function queueAgain(row) {
    if (row.status === 'blocked') row.recheck = true;
    else Object.assign(row, { status: 'pending', checkedAt: null, reason: '' });
  }
  function acceptResult(row, result, at = stamp()) {
    row.recheck = false;
    if (row.status === 'blocked' && result.status === 'unknown') {
      row.lastCheckError = result.reason; row.lastAttemptAt = at;
    } else { Object.assign(row, result, { checkedAt: at }); delete row.lastCheckError; }
  }
  function evictionIndex(rows) {
    let chosen = -1, oldest = Infinity;
    rows.forEach((r, i) => {
      if (r.status === 'blocked' || r.status === 'pending') return;
      const age = Date.parse(r.lastSeenAt || r.checkedAt) || 0;
      if (age < oldest) { oldest = age; chosen = i; }
    });
    return chosen;
  }
  // Observe author links only, never arbitrary links or quoted message text.
  function watchAuthors(doc, rowFor, changed, clock = () => Date.now(), entered = () => {}) {
    const win = doc.defaultView;
    const selector = '.b-comment header .name-date a.name[href], .b-topic header .name-date a.name[href], .b-topic .author .b-user16 a[href], .b-dialog .name-date a.name[href]';
    const tracked = new Map(), visible = new Set();
    let timer, closed = false;
    const dirty = new Set();
    const badges = new Map();
    function paint() {
      for (const [a, p] of tracked) {
        if (!a.isConnected || !a.matches(selector) || a.closest('.body, blockquote, .b-quote')) {
          observer.unobserve(a); visible.delete(a); tracked.delete(a); badges.get(a)?.remove(); badges.delete(a); continue;
        }
        const current = profile(a.getAttribute('href'));
        if (!current || keyOf(current.nick) !== keyOf(p.nick)) {
          tracked.delete(a); visible.delete(a); observer.unobserve(a); badges.get(a)?.remove(); badges.delete(a); continue;
        }
        const row = rowFor(p);
        if (row?.status !== 'blocked' || !cached(row, clock())) { badges.get(a)?.remove(); badges.delete(a); continue; }
        let badge = badges.get(a);
        if (!badge?.isConnected) {
          badge = doc.createElement('span'); badge.className = 'shiki-blacklist-badge';
          badge.style.setProperty('display', 'inline-block', 'important');
          badge.style.setProperty('margin-left', '6px', 'important');
          badge.style.setProperty('vertical-align', 'middle', 'important');
          const shadow = badge.attachShadow({ mode: 'closed' });
          const style = doc.createElement('style');
          style.textContent = ':host{all:initial}span{display:inline-block;background:#8f2030;color:#fff;border:1px solid #bc4b5b;border-radius:4px;padding:1px 5px;font:600 11px/1.5 system-ui,sans-serif;white-space:nowrap}';
          const label = doc.createElement('span'); label.textContent = 'Вы в ЧС'; shadow.append(style, label);
          badge.setAttribute('aria-label', 'Вы в чёрном списке этого пользователя');
          a.after(badge); badges.set(a, badge);
        }
        badge.title = 'Подтверждено ' + new Date(row.checkedAt).toLocaleString() + '. Последнее подтверждение сохраняется до проверки снятия блокировки. Повторная проверка — при появлении автора на экране. Отсутствие метки не означает отсутствие ЧС.';
      }
    }
    const observer = new win.IntersectionObserver(entries => {
      const before = new Set([...visible].map(a => keyOf(tracked.get(a)?.nick || '')));
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target);
      }
      const after = new Map([...visible].filter(a => tracked.has(a)).map(a => [keyOf(tracked.get(a).nick), tracked.get(a)]));
      for (const [key, p] of after) if (!before.has(key)) entered(p);
      changed();
    }, { threshold: 0.01 });
    function discover(scope) {
      if (closed || !scope.isConnected) return;
      const links = scope.matches?.(selector) ? [scope, ...scope.querySelectorAll(selector)] : scope.querySelectorAll(selector);
      for (const a of links) {
        if (tracked.has(a) || a.closest('.body, blockquote, .b-quote')) continue;
        const p = profile(a.getAttribute('href'));
        if (!p || !norm(a.textContent)) continue;
        tracked.set(a, p); observer.observe(a);
      }
    }
    const mutations = new win.MutationObserver(records => {
      let relevant = false;
      for (const r of records) {
        if (r.type === 'attributes') { dirty.add(r.target); relevant = true; }
        else for (const n of [...r.addedNodes, ...r.removedNodes]) {
          if (n.nodeType !== 1 || n.classList.contains('shiki-blacklist-badge') || n.id === 'shiki-local-blacklist') continue;
          if (n.isConnected) dirty.add(n);
          relevant = true;
        }
      }
      if (!relevant) return;
      win.clearTimeout(timer); timer = win.setTimeout(() => {
        paint();
        for (const n of dirty) {
          // Account metadata changes need repainting, not a full document search.
          if (n !== doc.body) discover(n);
        }
        dirty.clear(); paint(); changed();
      }, 150);
    });
    mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'data-user'] });
    discover(doc.body); paint();
    return {
      paint,
      candidates: () => [...new Map([...visible].filter(a => a.isConnected && tracked.has(a)).map(a => [keyOf(tracked.get(a).nick), tracked.get(a)])).values()],
      destroy: () => { closed = true; win.clearTimeout(timer); observer.disconnect(); mutations.disconnect(); for (const b of badges.values()) b.remove(); tracked.clear(); visible.clear(); dirty.clear(); }
    };
  }
  // Test-only CommonJS entry; browsers do not expose module in the userscript sandbox.
  if (typeof module === 'object' && module.exports) { module.exports = { profile, identity, classify, collect, csvCell, fresh, segment, cached, watchAuthors, nextCandidate, evictionIndex, queueAgain, acceptResult }; return; }

  let me, state, storageKey, busy = false, halted = false, controller, host, root, panel, message, results, summary;
  let listTab = 'all', listPage = 1, listQuery = '', listControls, searchInput, allTab, blockedTab, prevPage, nextPageButton, pageLabel;
  const PAGE_SIZE = 20;
  let watcher, autoTimer, autoButton, pumping = false, index = new Map();
  let loadedKey, loadedRaw, loadedState, indexedState, revision = 0, renderedRevision = -1, renderExpires = 0;
  let storageListener, storageDirty = true;
  const seen = new Map(), blockedDue = new Set();
  const autoEnabled = () => !!storageKey && GM_getValue(storageKey + ':auto', true) === true;
  function indexRows(force = false) { if (!force && indexedState === state) return; index = new Map((state?.rows || []).map(r => [keyOf(r.nick), r])); indexedState = state; revision++; }
  function pauseAuto() { if (storageKey) GM_setValue(storageKey + ':auto', false); }
  const statusText = { pending: 'В очереди', blocked: 'Добавил(а) вас в ЧС', not_blocked: 'Форма доступна', unknown: 'Неизвестно', error: 'Ошибка' };
  const say = s => { message.textContent = s; };
  function save() {
    try {
      for (const row of state.rows) {
        const at = seen.get(keyOf(row.nick));
        if (at && at > (Date.parse(row.lastSeenAt) || 0)) row.lastSeenAt = new Date(at).toISOString();
      }
      const raw = JSON.stringify(state);
      GM_setValue(storageKey, raw);
      loadedKey = storageKey; loadedRaw = raw; loadedState = state;
      storageDirty = false; indexRows(true);
    }
    catch { halted = true; throw new Error('Не удалось сохранить прогресс. Освободите хранилище Tampermonkey.'); }
  }
  function load() {
    const raw = GM_getValue(storageKey, null);
    if (loadedKey === storageKey && loadedRaw === raw && loadedState) { storageDirty = false; return loadedState; }
    const s = raw ? JSON.parse(raw) : fresh(me);
    if (s.version !== VERSION || s.account.id !== me.id || !Array.isArray(s.rows) || !Array.isArray(s.errors)) throw new Error('Формат сохранения не поддерживается. Удалите данные через Tampermonkey.');
    loadedKey = storageKey; loadedRaw = raw; loadedState = s; storageDirty = false;
    return s;
  }
  function add(users, source) {
    let added = 0;
    for (const p of users) {
      if (keyOf(p.nick) === keyOf(me.nick)) continue;
      let row = index.get(keyOf(p.nick));
      if (row) { if (!row.sources.includes(source)) row.sources.push(source); continue; }
      if (state.rows.length >= CAP) break;
      row = { ...p, sources: [source], status: 'pending', checkedAt: null, reason: '' };
      state.rows.push(row); index.set(keyOf(p.nick), row);
      added++;
    }
    save(); render(); return added;
  }
  function errorLog(scope, error) {
    state.errors.push({ at: stamp(), scope, message: String(error.message).slice(0, 300) });
    state.errors = state.errors.slice(-100);
    save();
  }
  function stop() { pauseAuto(); halted = true; controller?.abort(); say('Остановлено. Автометки на паузе; прогресс сохранён.'); render(); }
  async function delay(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (halted) throw new DOMException('Остановлено', 'AbortError');
      await new Promise(resolve => setTimeout(resolve, Math.min(200, until - Date.now())));
    }
  }
  async function get(path, shouldProceed = () => true) {
    if (identity(document)?.id !== me.id) throw new Error('Сменился аккаунт. Обновите страницу.');
    const u = new URL(path, location.origin);
    if (u.origin !== location.origin || !u.pathname.startsWith(me.path + '/')) throw new Error('Недопустимый маршрут');
    await delay(Math.max(0, (state.nextRequestAt || 0) - Date.now(), state.cooldown - Date.now()));
    if (halted) throw new DOMException('Остановлено', 'AbortError');
    if (!shouldProceed()) throw new DOMException('Пользователь больше не на экране', 'AbortError');
    if (identity(document)?.id !== me.id) throw new Error('Сменился аккаунт. Обновите страницу.');
    state.nextRequestAt = Date.now() + 5000 + Math.random() * 2000;
    save();
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(u.href, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'text/html' } });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers.get('Retry-After');
          const until = /^\d+$/.test(retry || '') ? Date.now() + Number(retry) * 1000 : Date.parse(retry || '');
          state.cooldown = Math.max(Date.now() + 60000, Number.isFinite(until) ? until : 0);
          save();
        }
        throw new Error('HTTP ' + response.status + '; проверка остановлена');
      }
      if (!response.headers.get('Content-Type')?.includes('text/html')) throw new Error('Ответ не HTML');
      const html = await response.text();
      if (html.length > 5000000) throw new Error('Слишком большой ответ');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (identity(doc)?.id !== me.id) throw new Error('Нет подтверждённой сессии: вход, защита сайта или смена аккаунта');
      return doc;
    } catch (e) {
      if (e.name === 'AbortError' && !halted) throw new Error('Истекло время ожидания (25 секунд)');
      throw e;
    } finally { clearTimeout(timer); controller = null; }
  }
  async function job(task, quiet = false) {
    if (busy) return;
    busy = true; halted = false; render();
    const run = async () => {
      // Reload under the lock so two tabs cannot overwrite each other's work.
      state = load();
      indexRows();
      await task();
    };
    let acquired = false;
    try {
      if (!navigator.locks) throw new Error('Браузер не поддерживает блокировку вкладок. Обновите браузер.');
      await navigator.locks.request('shiki-blacklist:' + me.id, { ifAvailable: true }, async lock => {
        if (!lock && quiet) return;
        if (!lock) throw new Error('В другой вкладке уже идёт работа с этим аккаунтом');
        acquired = true;
        await run();
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        if (acquired) pauseAuto();
        try { if (acquired) errorLog('операция', e); } catch {}
        say(e.message);
      }
    } finally { busy = false; watcher?.paint(); render(); }
  }
  async function autoTick() {
    if (pumping || busy || !watcher || !me || document.hidden) return;
    if (identity(document)?.id !== me.id) { watcher.destroy(); watcher = null; stop(); state = null; results.replaceChildren(); summary.textContent = 'Сменился аккаунт — обновите страницу.'; return; }
    pumping = true;
    try {
      if (storageDirty || storageListener === undefined) { state = load(); indexRows(); }
      for (const p of watcher.candidates()) {
        const key = keyOf(p.nick), row = index.get(key);
        if (row) { const at = Date.now(); seen.set(key, at); row.lastSeenAt = new Date(at).toISOString(); }
      }
      watcher.paint(); render();
      if (!autoEnabled() || state.cooldown > Date.now()) return;
      if (!nextCandidate(watcher.candidates(), index, me.nick, blockedDue)) return;
      await job(async () => {
        if (!autoEnabled() || document.hidden) return;
        // Re-evaluate under the shared lock: another tab may already have checked it.
        const p = nextCandidate(watcher?.candidates() || [], index, me.nick, blockedDue);
        if (!p) return;
        let row = index.get(keyOf(p.nick));
        if (!row) {
          if (state.rows.length >= CAP) {
            const discard = evictionIndex(state.rows);
            if (discard < 0) throw new Error('Кэш заполнен. Экспортируйте результаты и очистите данные.');
            seen.delete(keyOf(state.rows[discard].nick));
            state.rows.splice(discard, 1);
          }
          row = { ...p, lastSeenAt: stamp(), sources: ['автор на экране'], status: 'pending', checkedAt: null, reason: '' };
          state.rows.push(row);
        } else if (row.status !== 'blocked') queueAgain(row);
        save(); watcher?.paint();
        say('Автометки: проверяю ' + row.nick + '…');
        try {
          const doc = await get(me.path + '/dialogs/' + segment(row.nick), () => autoEnabled() && !document.hidden && !!watcher?.candidates().some(p => keyOf(p.nick) === keyOf(row.nick)));
          const result = classify(doc, me, row);
          acceptResult(row, result); blockedDue.delete(keyOf(row.nick));
          save(); watcher?.paint();
          if (result.status === 'unknown') throw new Error('Автометки приостановлены: ' + result.reason);
          say('Автометки: проверен ' + row.nick + '.');
        } catch (e) {
          if (e.name !== 'AbortError' && row.status === 'blocked') { row.lastCheckError = e.message; row.lastAttemptAt = stamp(); }
          if (e.name !== 'AbortError' && row.status === 'pending') Object.assign(row, { status: 'error', reason: e.message, checkedAt: stamp() });
          save(); throw e;
        }
      }, true);
    } catch (e) { pauseAuto(); say(e.message); }
    finally { pumping = false; }
  }
  function startWatching() {
    watcher?.destroy(); clearInterval(autoTimer);
    if (storageListener !== undefined && typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(storageListener);
    storageListener = undefined; storageDirty = true; seen.clear(); blockedDue.clear();
    if (busy) { setTimeout(startWatching, 250); return; }
    me = identity(document);
    if (!me) { state = null; index.clear(); return; }
    storageKey = 'shiki-blacklist:v1:' + location.hostname + ':' + me.id;
    try {
      state = load(); indexRows(); render();
      if (typeof GM_addValueChangeListener === 'function') storageListener = GM_addValueChangeListener(storageKey, (_key, _old, _value, remote) => {
        if (remote) { storageDirty = true; void autoTick(); }
      });
      if (!window.IntersectionObserver) { say('Автометки недоступны: обновите браузер.'); return; }
      watcher = watchAuthors(document, p => identity(document)?.id === me.id ? index.get(keyOf(p.nick)) : null, () => { void autoTick(); }, () => Date.now(), p => { if (index.get(keyOf(p.nick))?.status === 'blocked') blockedDue.add(keyOf(p.nick)); });
      autoTimer = setInterval(autoTick, 2000);
    } catch (e) { say(e.message); }
  }
  function nextPage(doc, base, page) {
    const expected = base + '/page/' + (page + 1);
    return Array.from(doc.querySelectorAll('.b-postloader a.next[href], a[rel="next"][href]')).some(a => {
      const u = new URL(a.getAttribute('href'), location.origin);
      return u.origin === location.origin && u.pathname === expected;
    });
  }
  async function sources() {
    for (let i = 0; i < 2 && state.dialogsNext && !halted; i++) {
      const page = state.dialogsNext, base = me.path + '/dialogs';
      say('Собираю диалоги, страница ' + page + '…');
      const doc = await get(base + (page === 1 ? '' : '/page/' + page));
      if (doc.body.id !== 'dialogs_index') throw new Error('Не распознан список диалогов');
      add(collect(doc), 'диалоги');
      state.dialogsNext = nextPage(doc, base, page) ? page + 1 : null;
      save();
    }
    say('Кандидаты собраны. ' + (state.dialogsNext ? 'Повторное нажатие прочитает следующие 2 страницы диалогов.' : 'Конец доступного списка диалогов.'));
  }
  async function scan() {
    let count = 0;
    for (const row of state.rows.filter(r => r.status === 'pending' || r.recheck)) {
      if (halted) break;
      say('Проверяю ' + row.nick + '… (проверка ' + (++count) + ')');
      try {
        const doc = await get(me.path + '/dialogs/' + segment(row.nick));
        const result = classify(doc, me, row);
        acceptResult(row, result); blockedDue.delete(keyOf(row.nick));
        save(); watcher?.paint(); render();
        if (result.status === 'unknown') throw new Error('Неоднозначный ответ для ' + row.nick + ': ' + result.reason);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (row.status === 'pending') Object.assign(row, { status: 'error', reason: e.message, checkedAt: stamp() });
        save(); throw e;
      }
    }
    if (!halted) say('Очередь проверена.');
  }
  function download(type) {
    const data = { ...state, exportedAt: stamp(), origin: location.origin, coverage: 'Только собранные пользователи; глобальный список недоступен' };
    const rows = [['direction', 'nickname', 'status', 'checked_at', 'reason', 'sources']];
    for (const r of state.rows) rows.push(['incoming', r.nick, r.status, r.checkedAt, r.reason, r.sources.join('; ')]);
    const text = type === 'json' ? JSON.stringify(data, null, 2) : '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: type === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'shikimori-blacklist-' + me.id + '-' + Date.now() + '.' + type; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function element(tag, text, parent = panel) { const e = document.createElement(tag); if (text) e.textContent = text; parent.append(e); return e; }
  function button(text, action, parent = panel, independent = false) {
    const b = element('button', text, parent); b.type = 'button'; b.dataset.independent = String(independent); b.onclick = action; return b;
  }
  function render() {
    if (!state || !summary) return;
    if (autoButton) autoButton.textContent = autoEnabled() ? 'Автометки: включены — приостановить' : 'Автометки: пауза — включить';
    for (const b of root.querySelectorAll('button[data-independent="false"]')) b.disabled = busy;
    if (panel.hidden) return;
    const now = Date.now();
    if (renderedRevision === revision && now < renderExpires) return;
    renderedRevision = revision; renderExpires = Infinity;
    for (const row of state.rows) {
      if (row.status === 'blocked') continue;
      const expiry = Date.parse(row.checkedAt) + (['unknown', 'error'].includes(row.status) ? ERROR_CACHE_MS : CACHE_MS);
      if (expiry > now) renderExpires = Math.min(renderExpires, expiry);
    }
    const blocked = state.rows.filter(r => r.status === 'blocked');
    const currentBlocked = blocked.length;
    summary.textContent = `Всего: ${state.rows.length} · в ЧС: ${currentBlocked}`;
    allTab.textContent = 'Все (' + state.rows.length + ')';
    blockedTab.textContent = 'Вы в ЧС (' + blocked.length + ')';
    allTab.setAttribute('aria-selected', String(listTab === 'all'));
    blockedTab.setAttribute('aria-selected', String(listTab === 'blocked'));
    const query = keyOf(listQuery.trim());
    const rows = (listTab === 'blocked' ? blocked : state.rows).filter(r => keyOf(r.nick).includes(query));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    listPage = Math.max(1, Math.min(listPage, pages));
    pageLabel.textContent = 'Страница ' + listPage + ' из ' + pages + ' · найдено: ' + rows.length;
    prevPage.disabled = listPage === 1; nextPageButton.disabled = listPage === pages;
    results.replaceChildren();
    if (!rows.length) { element('p', query ? 'Ник не найден.' : 'В этом списке пока никого нет.', results); return; }
    const table = element('table', '', results);
    const head = element('tr', '', element('thead', '', table));
    ['Пользователь', 'Статус'].forEach(t => element('th', t, head));
    const body = element('tbody', '', table);
    // Stable collection order prevents moving rows between pages on every check.
    for (const r of rows.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE)) {
      const tr = element('tr', '', body), td = element('td', '', tr), a = element('a', r.nick, td);
      a.href = location.origin + '/' + segment(r.nick); a.target = '_blank'; a.rel = 'noopener noreferrer';
      const label = {blocked: 'В ЧС', not_blocked: 'Не в ЧС', pending: 'Не проверен', unknown: 'Неизвестно', error: 'Неизвестно'}[r.status] || 'Неизвестно';
      element('td', label + (r.checkedAt && !cached(r, now) ? ' · устарело' : ''), tr);
    }
  }
  function refreshList() { renderedRevision = -1; render(); }

  function open() {
    if (busy) { panel.hidden = false; render(); return; }
    me = identity(document);
    if (!me) { state = null; results.replaceChildren(); summary.textContent = ''; panel.hidden = false; say('Войдите в Shikimori и обновите страницу. Аккаунт не распознан.'); return; }
    storageKey = 'shiki-blacklist:v1:' + location.hostname + ':' + me.id;
    try { state = load(); indexRows(); } catch(e) { say(e.message); panel.hidden = false; return; }
    panel.hidden = false; renderedRevision = -1; render();
    say('Автометки проверяют авторов комментариев при чтении. Нет метки — не значит, что нет ЧС. Обычные результаты свежи две минуты. Подтверждённый ЧС перепроверяется при появлении автора на экране.');
  }
  function mount() {
    if (document.getElementById('shiki-local-blacklist')) return;
    host = document.createElement('div'); host.id = 'shiki-local-blacklist'; document.body.append(host);
    root = host.attachShadow({ mode: 'closed' });
    const style = element('style', '', root);
    style.textContent = ':host{all:initial;font:14px/1.5 system-ui,sans-serif;color:#18212f}button{font:inherit;background:#2455a6;color:white;border:0;border-radius:7px;padding:8px 12px;margin:4px;cursor:pointer}button:disabled{opacity:.45;cursor:wait}.launcher{position:fixed;right:0;bottom:16px;z-index:2147483646;width:34px;height:34px;margin:0;padding:8px;display:grid;place-items:center;background:#475569;color:#fff;border-radius:8px 0 0 8px;opacity:.4;transition:opacity .15s,background .15s}.launcher:hover,.launcher:focus-visible{opacity:1;background:#2455a6}.launcher:focus-visible{outline:2px solid #2455a6;outline-offset:2px}.launcher svg{width:18px;height:18px;display:block}.launcher .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}@media(hover:none){.launcher{opacity:.65;width:40px;height:40px}}@media(prefers-reduced-motion:reduce){.launcher{transition:none}}section{position:fixed;z-index:2147483647;right:16px;bottom:64px;width:min(800px,calc(100vw - 48px));max-height:78vh;overflow:auto;background:#fff;border:1px solid #b8c7dd;border-radius:12px;padding:16px;box-shadow:0 8px 40px #0004}section[hidden]{display:none}h2,h3{margin:8px 0}p{margin:8px 0}textarea{box-sizing:border-box;width:100%;min-height:65px;font:inherit}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;border-bottom:1px solid #dde3ec;padding:6px;overflow-wrap:anywhere}a{color:#2455a6}pre{white-space:pre-wrap;font-size:12px}.status{padding:9px;background:#eef4ff;border-radius:6px}input[type=search]{box-sizing:border-box;width:100%;padding:8px;margin:8px 0;font:inherit;border:1px solid #b8c7dd;border-radius:6px}button[role=tab][aria-selected=false]{background:#e7edf6;color:#2455a6}button:disabled{cursor:default}';
    const launch = button('', open, root, true); launch.className = 'launcher';
    launch.title = 'Чёрный список'; launch.setAttribute('aria-label', 'Чёрный список');
    element('span', 'Чёрный список', launch).className = 'sr-only';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const circle = document.createElementNS(svg.namespaceURI, 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '8');
    circle.setAttribute('fill', 'none'); circle.setAttribute('stroke', 'currentColor'); circle.setAttribute('stroke-width', '2');
    const slash = document.createElementNS(svg.namespaceURI, 'path');
    slash.setAttribute('d', 'M6.4 6.4L17.6 17.6'); slash.setAttribute('stroke', 'currentColor'); slash.setAttribute('stroke-width', '2');
    svg.append(circle, slash); launch.append(svg);
    panel = element('section', '', root); panel.hidden = true; panel.setAttribute('aria-label', 'Чёрный список');
    button('Закрыть', () => { panel.hidden = true; }, panel, true);
    element('h2', 'Чёрный список · 1.4.0');
    element('p', 'Глобального списка нет. Здесь только результаты проверки собранных пользователей. Статус может измениться.');
    summary = element('p'); message = element('p'); message.className = 'status'; message.setAttribute('role', 'status');
    autoButton = button('Автометки', () => {
      if (!me || !state) return say('Войдите на сайт и обновите страницу.');
      const enable = !autoEnabled();
      GM_setValue(storageKey + ':auto', enable);
      if (!enable) { halted = true; controller?.abort(); }
      say(enable ? 'Автометки включены. Проверка продолжится для авторов на экране.' : 'Автометки на паузе.'); render();
      if (enable) void autoTick();
    }, panel, true);
    const guarded = f => () => { if (!me || !state) return say('Сначала войдите и откройте панель заново.'); return job(f); };
    button('Обновить метки сейчас', guarded(async () => {
      const visible = new Set((watcher?.candidates() || []).map(p => keyOf(p.nick)));
      for (const row of state.rows) if (visible.has(keyOf(row.nick))) { queueAgain(row); if (row.status === 'blocked') blockedDue.add(keyOf(row.nick)); }
      GM_setValue(storageKey + ':auto', true);
      save(); watcher?.paint();
      say('Повторная проверка видимых авторов включена. Интервал запросов и серверные паузы сохраняются.');
    }));
    button('Стоп', stop, panel, true);
    const details = element('details'); element('summary', 'Дополнительно: ручная очередь и повторная проверка', details);
    button('Собрать диалоги', guarded(sources), details);
    button('Собрать с этой страницы', guarded(async () => say('Добавлено: ' + add(collect(document), 'открытая страница'))), details);
    button('Проверить / Продолжить', guarded(scan), details);
    const input = element('textarea', '', details); input.placeholder = 'По одному нику в строке'; input.setAttribute('aria-label', 'Ники для проверки'); input.maxLength = 30000;
    button('Добавить', guarded(async () => {
      const users = input.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(nick => profile('/' + segment(nick))).filter(Boolean);
      say('Добавлено: ' + add(users, 'вручную') + '. Кэш — до 10 000 записей.'); input.value = '';
    }), details);
    button('Повторить неизвестные и ошибки', guarded(async () => { for (const r of state.rows) if (['unknown','error'].includes(r.status)) Object.assign(r, { status: 'pending', checkedAt: null, reason: '' }); save(); say('Возвращены в очередь. Нажмите «Продолжить».'); }), details);
    button('Перепроверить все собранные', guarded(async () => { for (const r of state.rows) queueAgain(r); save(); say('Очередь восстановлена. Нажмите «Продолжить».'); }), details);
    button('Экспорт JSON', () => state && download('json'));
    button('Экспорт CSV', () => state && download('csv'));
    button('Удалить локальные данные', guarded(async () => { if (!confirm('Удалить сохранённые результаты для этого аккаунта и домена?')) return; pauseAuto(); GM_deleteValue(storageKey); state = fresh(me); loadedState = null; seen.clear(); indexRows(); watcher?.paint(); say('Локальные данные удалены. Автометки на паузе.'); }));
    element('p', 'Автометки включены по умолчанию. Проверяются только авторы на экране; в скрытой вкладке новые проверки не запускаются. Обычные результаты свежи две минуты. Подтверждённый ЧС перепроверяется при появлении автора на экране. Метка ЧС сохраняется до подтверждения снятия блокировки. Нет метки — не значит, что нет ЧС. Один запрос раз в 5–7 секунд. Стоп и ошибки ставят автометки на паузу. Данные локальные; переписка и cookies не сохраняются.');
    listControls = element('div');
    const tabs = element('div', '', listControls); tabs.setAttribute('role', 'tablist');
    allTab = button('Все', () => { listTab = 'all'; listPage = 1; refreshList(); }, tabs, true);
    blockedTab = button('Вы в ЧС', () => { listTab = 'blocked'; listPage = 1; refreshList(); }, tabs, true);
    for (const t of [allTab, blockedTab]) t.setAttribute('role', 'tab');
    searchInput = element('input', '', listControls); searchInput.type = 'search'; searchInput.placeholder = 'Поиск по нику'; searchInput.setAttribute('aria-label', 'Поиск по нику'); searchInput.value = listQuery;
    searchInput.oninput = () => { listQuery = searchInput.value; listPage = 1; refreshList(); };
    const pages = element('div', '', listControls);
    prevPage = button('← Назад', () => { listPage--; refreshList(); }, pages, true);
    pageLabel = element('span', '', pages); pageLabel.setAttribute('aria-live', 'polite');
    nextPageButton = button('Вперёд →', () => { listPage++; refreshList(); }, pages, true);
    results = element('div');
  }
  function init() { mount(); startWatching(); }
  function teardown() { halted = true; controller?.abort(); clearInterval(autoTimer); watcher?.destroy(); watcher = null; if (storageListener !== undefined && typeof GM_removeValueChangeListener === 'function') GM_removeValueChangeListener(storageListener); storageListener = undefined; renderedRevision = -1; host?.remove(); }
  init();
  document.addEventListener('turbolinks:load', init);
  document.addEventListener('turbo:load', init);
  document.addEventListener('turbolinks:before-cache', teardown);
  document.addEventListener('turbo:before-cache', teardown);
  window.addEventListener('pagehide', teardown);
  window.addEventListener('pageshow', e => { if (e.persisted) init(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && pumping) { halted = true; controller?.abort(); } else if (!document.hidden) void autoTick(); });
})();
