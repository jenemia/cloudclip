'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
  const PAGE_PATH_RE = /^\/p\/([abcdefghjkmnpqrstuvwxyz23456789]{16})\/?$/;
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // server limit (after base64 encoding)
  const MAX_IMAGE_BYTES = Math.floor((MAX_UPLOAD_BYTES * 3) / 4) - 64 * 1024;
  const PAGE_POLL_MS = 5000;
  const SAVED_PAGE_KEY = 'cloudclip.page'; // localStorage: id of this device's persistent page

  const sections = [
    'page-info', 'compose', 'page-clips', 'created', 'page-home', 'open', 'pin-gate', 'view', 'missing',
  ];
  function show(...ids) {
    for (const s of sections) $(s).hidden = !ids.includes(s);
  }

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function setError(el, msg) {
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // Browser storage can be blocked (private mode, policies): never let it break the page.
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, value) { try { window[area].setItem(key, value); } catch { /* ignore */ } },
    del(area, key) { try { window[area].removeItem(key); } catch { /* ignore */ } },
  };

  async function api(method, url, { body, pin, pagePin } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (pin) headers['X-Clip-Pin'] = pin;
    if (pagePin) headers['X-Page-Pin'] = pagePin;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, ok: res.ok, data };
  }

  // ---------------- clipboard helpers ----------------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for http:// or older browsers.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  function toPngBlob(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  async function copyImage(item) {
    if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
    const src = `data:${item.mime};base64,${item.data}`;
    try {
      // Passing a Promise keeps Safari's user-gesture requirement satisfied.
      const blob = item.mime === 'image/png' ? b64ToBlob(item.data, item.mime) : toPngBlob(src);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ================= COMPOSE =================
  const pendingImages = []; // { blob, url, name }

  function addImage(blob, name) {
    if (!blob || !blob.type.startsWith('image/')) return;
    if (blob.type === 'image/svg+xml') { toast('SVG는 지원하지 않습니다'); return; }
    if (blob.size > MAX_IMAGE_BYTES) { toast(`이미지가 너무 큽니다 (${fmtBytes(blob.size)})`); return; }
    const url = URL.createObjectURL(blob);
    pendingImages.push({ blob, url, name: name || blob.name || '' });
    renderPreviews();
  }

  function renderPreviews() {
    const box = $('previews');
    box.textContent = '';
    pendingImages.forEach((img, i) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      const el = document.createElement('img');
      el.src = img.url;
      el.alt = '';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '✕';
      rm.setAttribute('aria-label', '이미지 제거');
      rm.addEventListener('click', () => {
        URL.revokeObjectURL(img.url);
        pendingImages.splice(i, 1);
        renderPreviews();
      });
      div.append(el, rm);
      box.appendChild(div);
    });
  }

  // Set while the compose box sends into a persistent page: { id, pin, onSent() }.
  let pageCtx = null;
  let composeReady = false;

  function initCompose() {
    if (composeReady) return;
    composeReady = true;
    const textarea = $('text');

    // Paste anywhere on the page: images become attachments, text goes to the textarea.
    document.addEventListener('paste', (e) => {
      if ($('compose').hidden) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) {
        // Some browsers expose images only through items.
        for (const it of e.clipboardData?.items || []) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length) {
        files.forEach((f) => addImage(f));
        const hasText = e.clipboardData.getData('text/plain');
        if (!hasText) e.preventDefault();
      }
      if (document.activeElement !== textarea && !files.length) {
        const t = e.clipboardData?.getData('text/plain');
        if (t && document.activeElement?.tagName !== 'INPUT') {
          e.preventDefault();
          textarea.value += (textarea.value ? '\n' : '') + t;
        }
      }
    });

    $('file').addEventListener('change', (e) => {
      [...e.target.files].forEach((f) => addImage(f, f.name));
      e.target.value = '';
    });

    $('btn-read-clipboard').addEventListener('click', async () => {
      try {
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          let got = false;
          for (const item of items) {
            const imgType = item.types.find((t) => t.startsWith('image/'));
            if (imgType) {
              addImage(await item.getType(imgType));
              got = true;
            } else if (item.types.includes('text/plain')) {
              const t = await (await item.getType('text/plain')).text();
              if (t) { textarea.value += (textarea.value ? '\n' : '') + t; got = true; }
            }
          }
          toast(got ? '클립보드 내용을 가져왔어요' : '클립보드가 비어 있어요');
        } else if (navigator.clipboard?.readText) {
          const t = await navigator.clipboard.readText();
          if (t) textarea.value += (textarea.value ? '\n' : '') + t;
          toast(t ? '클립보드 내용을 가져왔어요' : '클립보드가 비어 있어요');
        } else {
          throw new Error('unsupported');
        }
      } catch {
        toast('클립보드 접근이 막혀 있어요. 직접 붙여넣기 해주세요');
        textarea.focus();
      }
    });

    const pinEl = $('pin');
    pinEl.addEventListener('input', () => { pinEl.value = pinEl.value.replace(/\D/g, '').slice(0, 4); });

    $('btn-share').addEventListener('click', share);

    $('open-form').addEventListener('submit', (e) => {
      e.preventDefault();
      let v = $('open-code').value.trim();
      // A persistent page address (/p/<16 chars>) opens that page.
      const pageMatch = v.match(/\/p\/([a-z0-9]{16})\/?$/i);
      if (pageMatch && PAGE_PATH_RE.test(`/p/${pageMatch[1].toLowerCase()}`)) {
        location.href = `/p/${pageMatch[1].toLowerCase()}`;
        return;
      }
      // Accept a full URL or just the code.
      const m = v.match(/([a-z0-9]{8})\/?$/i);
      v = m ? m[1].toLowerCase() : v.toLowerCase();
      if (!ID_RE.test(v)) { toast('코드 형식이 올바르지 않아요'); return; }
      location.href = `/${v}`;
    });

    setTimeout(() => { if (matchMedia('(pointer: fine)').matches) textarea.focus(); }, 0);
  }

  async function share() {
    const btn = $('btn-share');
    const errEl = $('compose-error');
    setError(errEl, '');
    const text = $('text').value;
    const pin = pageCtx ? '' : $('pin').value;
    const idleLabel = pageCtx ? '이 페이지로 보내기' : '공유 링크 만들기';

    if (!text.trim() && pendingImages.length === 0) {
      setError(errEl, '붙여넣은 내용이 없습니다.');
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      setError(errEl, '비밀번호는 숫자 4자리로 입력하세요.');
      return;
    }

    btn.disabled = true;
    btn.textContent = '업로드 중…';
    try {
      const estimated = new Blob([text]).size + pendingImages.reduce((n, i) => n + Math.ceil(i.blob.size / 3) * 4, 0);
      if (estimated > MAX_UPLOAD_BYTES) {
        throw new Error(`용량이 너무 큽니다. 이미지 합계 약 ${fmtBytes(MAX_IMAGE_BYTES)}까지 가능합니다.`);
      }
      const items = [];
      if (text.trim()) items.push({ type: 'text', text });
      for (const img of pendingImages) {
        items.push({ type: 'image', mime: img.blob.type, name: img.name, data: await blobToBase64(img.blob) });
      }
      const res = pageCtx
        ? await api('POST', `/api/pages/${pageCtx.id}/clips`, { body: { items }, pagePin: pageCtx.pin })
        : await api('POST', '/api/clips', { body: { items, pin: pin || undefined } });
      if (!res.ok) throw new Error(res.data.error || (res.status === 413 ? '용량이 너무 큽니다.' : '업로드에 실패했습니다.'));
      if (pageCtx) {
        clearCompose();
        toast('페이지로 보냈어요');
        pageCtx.onSent(res.data);
      } else {
        showCreated(res.data, !!pin);
      }
    } catch (e) {
      setError(errEl, e.message || '업로드에 실패했습니다.');
    } finally {
      btn.disabled = false;
      btn.textContent = idleLabel;
    }
  }

  // Clear the composed data so it is not lingering on the page.
  function clearCompose() {
    $('text').value = '';
    $('pin').value = '';
    pendingImages.splice(0).forEach((i) => URL.revokeObjectURL(i.url));
    renderPreviews();
  }

  function showCreated(meta, hasPin) {
    const url = `${location.origin}/${meta.id}`;
    $('created-code').textContent = meta.id;
    $('created-url').value = url;
    $('created-open').href = `/${meta.id}`;
    $('created-pin-note').hidden = !hasPin;
    $('btn-copy-link').onclick = async () => toast((await copyText(url)) ? '링크를 복사했어요' : '복사 실패');
    $('created-url').onclick = (e) => e.target.select();
    show('created');
    // Google Ads / GA4 conversion (no-op unless ads.js is loaded and consent was given)
    if (typeof window.ccTrack === 'function') window.ccTrack('generate_link', { has_pin: hasPin });
    clearCompose();
  }

  // ================= VIEW =================
  let currentPin = '';
  let countdownTimer;

  async function initView(id) {
    const meta = await api('GET', `/api/clips/${id}/meta`);
    if (!meta.ok) return showMissing(meta.data.error);
    if (meta.data.hasPin) {
      show('pin-gate');
      const input = $('pin-input');
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 4);
        if (input.value.length === 4) $('pin-form').requestSubmit();
      });
      $('pin-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = input.value;
        if (!/^\d{4}$/.test(pin)) return;
        const res = await api('GET', `/api/clips/${id}`, { pin });
        if (res.ok) {
          currentPin = pin;
          renderClip(id, res.data);
        } else if (res.status === 403 || res.status === 429) {
          setError($('pin-error'), res.data.error);
          input.value = '';
          input.focus();
        } else {
          showMissing(res.data.error);
        }
      });
      input.focus();
      return;
    }
    const res = await api('GET', `/api/clips/${id}`);
    if (!res.ok) return showMissing(res.data.error);
    renderClip(id, res.data);
  }

  function showMissing(msg) {
    if (msg) $('missing-msg').textContent = msg;
    show('missing');
  }

  // Fills `box` with one card per item (text / image) and returns the texts for "copy all".
  function renderItems(box, items, id) {
    box.textContent = '';
    const texts = [];

    items.forEach((item, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'item';
      const actions = document.createElement('div');
      actions.className = 'actions';
      const meta = document.createElement('span');
      meta.className = 'meta';

      if (item.type === 'text') {
        texts.push(item.text);
        const pre = document.createElement('pre');
        pre.textContent = item.text;
        meta.textContent = `텍스트 · ${item.text.length.toLocaleString()}자`;
        const copy = button('복사', 'primary', async () => toast((await copyText(item.text)) ? '복사했어요' : '복사 실패 — 직접 선택해서 복사하세요'));
        actions.append(meta, copy);
        wrap.append(pre, actions);
      } else if (item.type === 'image') {
        const src = `data:${item.mime};base64,${item.data}`;
        const img = document.createElement('img');
        img.src = src;
        img.alt = item.name || `이미지 ${i + 1}`;
        img.loading = 'lazy';
        meta.textContent = `이미지 · ${fmtBytes(Math.floor((item.data.length * 3) / 4))}`;

        const copy = button('복사', 'primary', async () => {
          toast((await copyImage(item)) ? '이미지를 복사했어요' : '이 브라우저는 이미지 복사를 지원하지 않아요. 저장을 이용하세요');
        });
        const save = document.createElement('a');
        save.className = 'button secondary';
        save.textContent = '저장';
        const ext = (item.mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
        save.download = item.name || `cloudclip-${id}-${i + 1}.${ext}`;
        save.addEventListener('click', () => { save.href = URL.createObjectURL(b64ToBlob(item.data, item.mime)); });
        save.href = '#';
        actions.append(meta, copy, save);
        wrap.append(img, actions);
      }
      box.appendChild(wrap);
    });
    return texts;
  }

  function renderClip(id, clip) {
    show('view');
    const texts = renderItems($('items'), clip.items, id);

    const copyAll = $('btn-copy-all');
    copyAll.hidden = texts.length < 2;
    copyAll.onclick = async () => toast((await copyText(texts.join('\n\n'))) ? '모두 복사했어요' : '복사 실패');

    $('btn-delete').onclick = async () => {
      if (!confirm('이 클립을 지금 삭제할까요?')) return;
      const res = await api('DELETE', `/api/clips/${id}`, { pin: currentPin });
      if (res.ok) showMissing('삭제되었습니다.');
      else toast(res.data.error || '삭제 실패');
    };

    startCountdown(clip.expiresAt);
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function startCountdown(expiresAt) {
    const el = $('countdown');
    clearInterval(countdownTimer);
    const tick = () => {
      const left = expiresAt - Date.now();
      if (left <= 0) {
        clearInterval(countdownTimer);
        $('items').textContent = '';
        showMissing('1시간이 지나 자동 삭제되었습니다.');
        return;
      }
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      el.textContent = `⏱ ${m}:${String(s).padStart(2, '0')} 후 삭제`;
      el.classList.toggle('soon', left < 5 * 60000);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ================= PERSISTENT PAGE =================
  const pinKey = (pid) => `cloudclip.pin.${pid}`; // sessionStorage: PIN for this tab only
  const savedPageId = () => {
    const v = store.get('localStorage', SAVED_PAGE_KEY);
    return v && PAGE_PATH_RE.test(`/p/${v}`) ? v : null;
  };

  async function initHome() {
    show('compose', 'page-home', 'open');
    initCompose();

    const pinNew = $('page-pin-new');
    pinNew.addEventListener('input', () => { pinNew.value = pinNew.value.replace(/\D/g, '').slice(0, 4); });
    $('btn-page-create').addEventListener('click', createPageFromHome);
    $('btn-page-new').addEventListener('click', () => {
      $('page-new').hidden = false;
      $('page-saved').hidden = true;
    });

    // Offer this device's earlier page if it is still alive.
    const saved = savedPageId();
    if (!saved) return;
    const meta = await api('GET', `/api/pages/${saved}/meta`).catch(() => null);
    if (meta?.ok) {
      $('page-saved-link').href = `/p/${saved}`;
      $('page-saved').hidden = false;
      $('page-new').hidden = true;
    } else if (meta?.status === 404) {
      store.del('localStorage', SAVED_PAGE_KEY);
    }
  }

  async function createPageFromHome() {
    const btn = $('btn-page-create');
    const errEl = $('page-create-error');
    setError(errEl, '');
    const pin = $('page-pin-new').value;
    if (!/^\d{4}$/.test(pin)) { setError(errEl, '비밀번호를 숫자 4자리로 입력하세요.'); return; }
    btn.disabled = true;
    try {
      const res = await api('POST', '/api/pages', { body: { pin } });
      if (!res.ok) throw new Error(res.data.error || '고정 페이지를 만들지 못했습니다.');
      store.set('localStorage', SAVED_PAGE_KEY, res.data.id);
      store.set('sessionStorage', pinKey(res.data.id), pin);
      // Conversion is sent here because the private page itself never loads the Google tag (sent via beacon).
      if (typeof window.ccTrack === 'function') window.ccTrack('create_page');
      location.href = `/p/${res.data.id}`;
    } catch (e) {
      setError(errEl, e.message || '고정 페이지를 만들지 못했습니다.');
      btn.disabled = false;
    }
  }

  const page = { id: '', pin: '', expiresAt: 0, polling: false, pollTimer: 0, tickTimer: 0 };
  const clipCards = new Map(); // clip id -> { el, badge, expiresAt, loaded, loading }

  async function initPage(pid) {
    const meta = await api('GET', `/api/pages/${pid}/meta`);
    if (!meta.ok) return pageGone(meta.data.error, pid);

    const cached = store.get('sessionStorage', pinKey(pid));
    if (cached) {
      const res = await api('GET', `/api/pages/${pid}`, { pagePin: cached });
      if (res.ok) return openPage(pid, cached, res.data);
      store.del('sessionStorage', pinKey(pid));
      if (res.status === 404 || res.status === 410) return pageGone(res.data.error, pid);
    }
    showPageGate(pid);
  }

  function showPageGate(pid) {
    show('pin-gate');
    $('pin-gate-hint').textContent = '이 고정 페이지는 비밀번호로 보호되어 있습니다.';
    const input = $('pin-input');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 4);
      if (input.value.length === 4) $('pin-form').requestSubmit();
    });
    $('pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value;
      if (!/^\d{4}$/.test(pin)) return;
      const res = await api('GET', `/api/pages/${pid}`, { pagePin: pin });
      if (res.ok) {
        store.set('sessionStorage', pinKey(pid), pin);
        openPage(pid, pin, res.data);
      } else if (res.status === 401 || res.status === 403) {
        setError($('pin-error'), res.data.error);
        input.value = '';
        input.focus();
      } else {
        pageGone(res.data.error, pid);
      }
    });
    input.focus();
  }

  function openPage(pid, pin, state) {
    page.id = pid;
    page.pin = pin;
    page.expiresAt = state.expiresAt;
    store.set('localStorage', SAVED_PAGE_KEY, pid);

    // Same compose box as the home page, but it sends into this page and needs no PIN of its own.
    pageCtx = { id: pid, pin, onSent: (data) => { page.expiresAt = data.expiresAt; pollPage(); } };
    $('compose-title').textContent = '이 페이지로 보내기';
    $('compose-hint').textContent = '여기에 붙여넣으면 이 페이지를 연 모든 기기에 나타나요. 클립은 1시간 뒤 삭제됩니다.';
    $('pin-row').hidden = true;
    $('btn-share').textContent = '이 페이지로 보내기';
    initCompose();
    setError($('pin-error'), '');
    show('page-info', 'compose', 'page-clips');

    const url = `${location.origin}/p/${pid}`;
    $('page-url').value = url;
    $('page-url').onclick = (e) => e.target.select();
    $('btn-page-copy').onclick = async () => toast((await copyText(url)) ? '주소를 복사했어요' : '복사 실패');
    drawQr($('page-qr'), url);
    $('btn-page-delete').onclick = async () => {
      if (!confirm('고정 페이지와 안에 있는 클립을 지금 모두 삭제할까요?')) return;
      const res = await api('DELETE', `/api/pages/${pid}`, { pagePin: pin });
      if (res.ok) pageGone('고정 페이지를 삭제했습니다.', pid);
      else toast(res.data.error || '삭제 실패');
    };

    syncClips(state.clips);
    clearInterval(page.pollTimer);
    clearInterval(page.tickTimer);
    page.pollTimer = setInterval(() => { if (!document.hidden) pollPage(); }, PAGE_POLL_MS);
    page.tickTimer = setInterval(tickPage, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && pageCtx) pollPage(); });
    tickPage();
  }

  // Dark modules on a light background with a 4-module quiet zone, whatever the colour scheme.
  function drawQr(canvas, text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text, 'Byte');
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 4;
      const scale = Math.max(3, Math.floor(480 / (n + quiet * 2)));
      const size = (n + quiet * 2) * scale;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    } catch {
      canvas.hidden = true; // the address below still works without the QR code
    }
  }

  async function pollPage() {
    if (page.polling || !pageCtx) return;
    page.polling = true;
    try {
      const res = await api('GET', `/api/pages/${page.id}`, { pagePin: page.pin });
      if (!pageCtx) return;
      if (res.ok) {
        page.expiresAt = res.data.expiresAt;
        syncClips(res.data.clips);
      } else if ([401, 403, 404, 410].includes(res.status)) {
        pageGone(res.data.error, page.id);
      }
    } catch { /* offline: the next poll tries again */ } finally {
      page.polling = false;
    }
  }

  function syncClips(list) {
    const ids = new Set(list.map((c) => c.id));
    for (const [id, card] of clipCards) {
      if (!ids.has(id)) { card.el.remove(); clipCards.delete(id); }
    }
    for (const clip of list) {
      const card = clipCards.get(clip.id) || buildClipCard(clip);
      clipCards.set(clip.id, card);
      if (!card.loaded && !card.loading) loadClipCard(clip.id, card);
    }
    const box = $('page-clip-list');
    [...list].sort((a, b) => b.createdAt - a.createdAt).forEach((c) => box.append(clipCards.get(c.id).el)); // newest first
    $('page-empty').hidden = clipCards.size > 0;
  }

  function buildClipCard(clip) {
    const el = document.createElement('div');
    el.className = 'clip-card';
    const head = document.createElement('div');
    head.className = 'clip-head';
    const when = document.createElement('span');
    when.className = 'meta';
    when.textContent = `${new Date(clip.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 도착`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    const del = button('삭제', 'danger', async () => {
      if (!confirm('이 클립을 지금 삭제할까요?')) return;
      const res = await api('DELETE', `/api/pages/${page.id}/clips/${clip.id}`, { pagePin: page.pin });
      if (res.ok) pollPage();
      else toast(res.data.error || '삭제 실패');
    });
    head.append(when, badge, del);
    const body = document.createElement('div');
    body.className = 'items';
    el.append(head, body);
    return { el, body, badge, expiresAt: clip.expiresAt, loaded: false, loading: false };
  }

  async function loadClipCard(id, card) {
    card.loading = true;
    card.body.textContent = '불러오는 중…';
    try {
      const res = await api('GET', `/api/pages/${page.id}/clips/${id}`, { pagePin: page.pin });
      if (res.ok) {
        renderItems(card.body, res.data.items, id);
        card.loaded = true;
      } else {
        card.body.textContent = res.data.error || '불러오지 못했습니다.';
      }
    } catch {
      card.body.textContent = '불러오지 못했습니다. 네트워크를 확인하세요.';
    } finally {
      card.loading = false;
    }
  }

  const fmtClock = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  function tickPage() {
    if (!pageCtx) return;
    const left = page.expiresAt - Date.now();
    if (left <= 0) { pageGone('마지막 클립 이후 6시간이 지나 고정 페이지가 삭제되었습니다.', page.id); return; }
    const el = $('page-countdown');
    el.textContent = `⏱ 새 클립이 없으면 ${fmtClock(left)} 후 삭제`;
    el.classList.toggle('soon', left < 30 * 60000);
    for (const [id, card] of clipCards) {
      const l = card.expiresAt - Date.now();
      if (l <= 0) { card.el.remove(); clipCards.delete(id); continue; }
      card.badge.textContent = `⏱ ${Math.floor(l / 60000)}:${String(Math.floor((l % 60000) / 1000)).padStart(2, '0')} 후 삭제`;
      card.badge.classList.toggle('soon', l < 5 * 60000);
    }
    $('page-empty').hidden = clipCards.size > 0;
  }

  function pageGone(msg, pid) {
    clearInterval(page.pollTimer);
    clearInterval(page.tickTimer);
    pageCtx = null;
    clipCards.clear();
    $('page-clip-list').textContent = '';
    if (pid) {
      store.del('sessionStorage', pinKey(pid));
      if (savedPageId() === pid) store.del('localStorage', SAVED_PAGE_KEY);
    }
    showMissing(msg || '고정 페이지가 없거나 만료되었습니다.');
  }

  // ================= HTTPS =================
  if (!window.isSecureContext) {
    $('insecure').hidden = false;
    // Only offer the link on the default port; a custom HTTP port usually has no TLS behind it.
    if (location.port) $('insecure-link').hidden = true;
    else $('insecure-link').href = `https://${location.host}${location.pathname}${location.search}`;
  }

  // ================= ROUTING =================
  const path = location.pathname.toLowerCase();
  const pageMatch = path.match(PAGE_PATH_RE);
  const id = path.slice(1);
  if (pageMatch || ID_RE.test(id)) {
    // Private clip / page: never index, never show marketing content.
    $('about').hidden = true;
    const robots = document.querySelector('meta[name="robots"]');
    if (robots) robots.content = 'noindex, nofollow';
    document.title = pageMatch ? 'CloudClip – 고정 페이지' : 'CloudClip – 클립';
  }
  const netError = () => showMissing('불러오지 못했습니다. 네트워크를 확인하세요.');
  if (pageMatch) initPage(pageMatch[1]).catch(netError);
  else if (ID_RE.test(id)) initView(id).catch(netError);
  else initHome();
})();
