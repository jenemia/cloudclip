'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // server limit (after base64 encoding)
  const MAX_IMAGE_BYTES = Math.floor((MAX_UPLOAD_BYTES * 3) / 4) - 64 * 1024;

  const sections = ['compose', 'created', 'open', 'pin-gate', 'view', 'missing'];
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

  async function api(method, url, { body, pin } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (pin) headers['X-Clip-Pin'] = pin;
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

  function initCompose() {
    show('compose', 'open');
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
    const pin = $('pin').value;

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
      const res = await api('POST', '/api/clips', { body: { items, pin: pin || undefined } });
      if (!res.ok) throw new Error(res.data.error || (res.status === 413 ? '용량이 너무 큽니다.' : '업로드에 실패했습니다.'));
      showCreated(res.data, !!pin);
    } catch (e) {
      setError(errEl, e.message || '업로드에 실패했습니다.');
    } finally {
      btn.disabled = false;
      btn.textContent = '공유 링크 만들기';
    }
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
    // Clear the composed data so it is not lingering on the page.
    $('text').value = '';
    $('pin').value = '';
    pendingImages.splice(0).forEach((i) => URL.revokeObjectURL(i.url));
    renderPreviews();
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

  function renderClip(id, clip) {
    show('view');
    const box = $('items');
    box.textContent = '';
    const texts = [];

    clip.items.forEach((item, i) => {
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

  // ================= HTTPS =================
  if (!window.isSecureContext) {
    $('insecure').hidden = false;
    // Only offer the link on the default port; a custom HTTP port usually has no TLS behind it.
    if (location.port) $('insecure-link').hidden = true;
    else $('insecure-link').href = `https://${location.host}${location.pathname}${location.search}`;
  }

  // ================= ROUTING =================
  const id = location.pathname.slice(1).toLowerCase();
  if (ID_RE.test(id)) initView(id).catch(() => showMissing('불러오지 못했습니다. 네트워크를 확인하세요.'));
  else initCompose();
})();
