// БЕНДЕР — глаза и уши морды: камера и микрофон планшета.
// Ничего не включается само. Сервер говорит «включено» только тому, у кого есть
// токен из /eyes on (ссылка от бота: ?eyes=...). Без токена — морда просто морда.
// iPad требует жеста для камеры и микрофона: если сервер включил, а тапа ещё не было,
// ждём первого касания по экрану.
'use strict';

(function () {
  const TOKEN_KEY = 'bender_eyes_token';
  const FRAME_EVERY_MS = 5000;
  const FRAME_WIDTH = 640;
  const JPEG_QUALITY = 0.6;

  // Токен из ссылки бота → localStorage; из адреса убираем, чтобы не светился.
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('eyes');
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (_) { /* приватный режим */ }
    params.delete('eyes');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  }
  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { token = ''; }

  const pill = document.getElementById('eyes');
  const pillText = pill ? pill.querySelector('.txt') : null;

  const st = {
    wantOn: false,   // сервер сказал «включено»
    starting: false,
    stream: null,    // MediaStream камеры
    video: null,
    canvas: null,
    frameTimer: 0,
    recog: null,     // распознавание речи
    micWanted: false,
  };

  function q() {
    return `token=${encodeURIComponent(token)}`;
  }

  function updatePill() {
    if (!pill) return;
    pill.hidden = !token;
    let text = 'глаза · выкл';
    let cls = 'off';
    if (st.wantOn && st.stream) {
      text = st.micWanted ? 'глаза · вижу · слышу' : 'глаза · вижу';
      cls = 'on';
    } else if (st.wantOn) {
      text = 'глаза · тапни';
      cls = 'wait';
    }
    pill.className = cls;
    if (pillText) pillText.textContent = text;
  }

  // ---- камера: кадр раз в пять секунд, в JPEG 640 px --------------------------
  function sendFrame() {
    if (!st.video || !st.video.videoWidth || !st.canvas) return;
    const scale = FRAME_WIDTH / st.video.videoWidth;
    st.canvas.width = FRAME_WIDTH;
    st.canvas.height = Math.round(st.video.videoHeight * scale);
    st.canvas.getContext('2d').drawImage(st.video, 0, 0, st.canvas.width, st.canvas.height);
    st.canvas.toBlob((blob) => {
      if (!blob) return;
      fetch(`api/eyes/frame?${q()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
        cache: 'no-store',
      }).then((res) => {
        if (res.status === 403) stopAll(); // сессия кончилась — камеру гасим
      }).catch(() => { /* сеть мигнула — следующий кадр через пять секунд */ });
    }, 'image/jpeg', JPEG_QUALITY);
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: FRAME_WIDTH }, height: { ideal: 480 } },
      audio: false,
    });
    st.video = document.createElement('video');
    st.video.muted = true;
    st.video.playsInline = true;
    st.video.srcObject = st.stream;
    await st.video.play().catch(() => {});
    st.canvas = document.createElement('canvas');
    st.frameTimer = setInterval(sendFrame, FRAME_EVERY_MS);
    setTimeout(sendFrame, 1500);
    return true;
  }

  // ---- микрофон: распознавание речи (Web Speech API), фразы — на сервер -------
  function sendHeard(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    fetch(`api/eyes/heard?${q()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      cache: 'no-store',
    }).catch(() => { /* не критично: речь не потеряна, просто не ушла */ });
  }

  function startMic() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) return false; // браузер без распознавания — только глаза
    if (st.recog) { // прошлая попытка без жеста: гасим, чтобы не было двух распознаваний
      st.recog.onend = null;
      try { st.recog.stop(); } catch (_) { /* уже остановлено */ }
      st.recog = null;
    }
    const recog = new Rec();
    recog.lang = 'ru-RU';
    recog.continuous = true;
    recog.interimResults = false;
    recog.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) sendHeard(event.results[i][0].transcript);
      }
    };
    recog.onerror = (event) => {
      // доступ к микрофону не дали — больше не пытаемся
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') st.micWanted = false;
    };
    // iOS сам обрывает распознавание после тишины — перезапускаем, пока сессия жива
    recog.onend = () => {
      if (!st.micWanted || !st.wantOn) return;
      setTimeout(() => {
        try { recog.start(); } catch (_) { /* уже идёт */ }
      }, 800);
    };
    st.recog = recog;
    try {
      recog.start();
      st.micWanted = true;
      return true;
    } catch (_) {
      st.recog = null;
      return false;
    }
  }

  // ---- старт / стоп -----------------------------------------------------------
  // Пытаемся поднять то, что ещё не работает: камеру и/или микрофон.
  // Вызывается при включении сессии и на каждом касании, пока чего-то нет.
  async function start() {
    if (st.starting || !st.wantOn || !token) return;
    st.starting = true;
    if (!st.stream) {
      try { await startCamera(); } catch (_) { /* нет разрешения или жеста — ждём касания */ }
    }
    if (st.wantOn && !st.micWanted) startMic();
    st.starting = false;
    updatePill();
  }

  function stopAll() {
    clearInterval(st.frameTimer);
    st.frameTimer = 0;
    if (st.stream) st.stream.getTracks().forEach((track) => track.stop());
    st.stream = null;
    st.video = null;
    st.canvas = null;
    st.micWanted = false;
    if (st.recog) {
      st.recog.onend = null;
      try { st.recog.stop(); } catch (_) { /* уже остановлено */ }
      st.recog = null;
    }
    updatePill();
  }

  // Вызывает face.js при каждом опросе /api/face: state = { on, leftSec }.
  function sync(state) {
    const on = Boolean(state && state.on) && Boolean(token);
    if (on && !st.wantOn) {
      st.wantOn = true;
      updatePill();
      start(); // на iPad без жеста тут не выйдет — тогда ждём тапа
    } else if (!on && st.wantOn) {
      st.wantOn = false;
      stopAll();
    } else {
      updatePill();
    }
  }

  // Касание по экрану (жест для iOS): если сессия включена и камеры ещё нет — стартуем.
  window.addEventListener('pointerdown', () => {
    if (st.wantOn && (!st.stream || !st.micWanted) && !st.starting) start();
  });

  window.BenderEyes = {
    sync,
    token: () => token,
  };
  updatePill();
})();
