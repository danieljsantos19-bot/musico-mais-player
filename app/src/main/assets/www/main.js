const DB_NAME = 'musico-mais-player';
const STORE = 'tracks';
const PLAYLIST_KEY = 'playlist-order';
const PLAYLIST_LIBRARY_KEY = 'playlist-library';
const state = {
  tracks: [],
  current: 0,
  objectUrl: '',
  fontSize: 20,
  bateria: 0.5,
  baixo: 0.5,
  teclado: 0.5,
};
const audio = new Audio();
audio.preload = 'none';
let audioContext = null;
let sourceNode = null;
let mixerReady = false;
let screenWakeLock = null;

// Mantém a tela acesa enquanto o player está aberto e visível, quando
// o navegador oferece suporte à Screen Wake Lock API.
async function keepScreenAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    if (screenWakeLock && !screenWakeLock.released) return;
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => {
      screenWakeLock = null;
    }, { once: true });
  } catch (_) {
    // O navegador ou o sistema pode impedir o bloqueio de tela.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void keepScreenAwake();
});

function setupMixer() {
  if (mixerReady) return;
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaElementSource(audio);
  const splitter = audioContext.createChannelSplitter(2);
  const merger = audioContext.createChannelMerger(2);
  const leftGain = audioContext.createGain();
  const rightBassGain = audioContext.createGain();
  const rightKeyboardGain = audioContext.createGain();
  sourceNode.connect(splitter);
  splitter.connect(leftGain, 0);
  splitter.connect(rightBassGain, 1);
  splitter.connect(rightKeyboardGain, 1);
  leftGain.connect(merger, 0, 0);
  rightBassGain.connect(merger, 0, 1);
  rightKeyboardGain.connect(merger, 0, 1);
  merger.connect(audioContext.destination);
  audio._mix = { left: leftGain, bass: rightBassGain, keyboard: rightKeyboardGain };
  mixerReady = true;
}
function updateMixer() {
  const mix = audio._mix;
  if (!mix) return;
  mix.left.gain.value = state.bateria;
  // Baixo e teclado compartilham o mesmo canal físico R. Mantemos o ganho
  // total de R constante em 100% e usamos os dois controles para repartir
  // esse nível entre baixo e teclado.
  const rTotal = state.baixo + state.teclado;
  if (rTotal <= 0) {
    mix.bass.gain.value = 0;
    mix.keyboard.gain.value = 0;
  } else {
    mix.bass.gain.value = state.baixo / rTotal;
    mix.keyboard.gain.value = state.teclado / rTotal;
  }
}

function uid(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
}
let dbPromise;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
async function putTrack(t) {
  return putTracks([t]);
}
async function putTracks(tracks) {
  if (!tracks.length) return;
  const d = await db();
  const records = await Promise.all(tracks.map(async track => {
    let blobData = track.blobData;
    let blobType = track.blobType || 'audio/mpeg';
    if (!blobData && track.blob) {
      blobData = await track.blob.arrayBuffer();
      blobType = track.blob.type || blobType;
    }
    return {
      id: track.id,
      name: track.name,
      blobData,
      blobType,
      lyrics: track.lyrics || ''
    };
  }));
  await new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação IndexedDB cancelada'));
  });
}
async function getAllTracks() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    r.onsuccess = () => {
      resolve(r.result.map(t => ({
        id: t.id,
        name: t.name,
        lyrics: t.lyrics || '',
        blob: t.blobData
          ? new Blob([t.blobData], { type: t.blobType || 'audio/mpeg' })
          : t.blob
      })).filter(t => t.blob));
    };
    r.onerror = () => reject(r.error);
  });
}
function baseName(name) {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .pop().replace(/\.[^.]+$/, '')
    .trim()
    .toLowerCase();
}
function songKey(name) {
  let key = String(name || '').replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
  // Aceita nomes como "musica.lrc", "musica.txt" e também "musica.mp3.lrc".
  key = key.replace(/\.(lrc|txt)$/i, '').replace(/\.(mp3|wav|m4a|ogg|aac)$/i, '');
  return key
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '')
    .replace(/[^a-z0-9]+/g, '');
}
function parsePlaylist(text) {
  return text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x && !x.startsWith('#'))
    .map(baseName);
}
function parseLyrics(text, fileName) {
  return /\.lrc$/i.test(fileName) ? text.replace(/\r\n/g, '\n') : text;
}
function getTimedLyrics(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const lyric = line.replace(/\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/g, '').trim();
    if (!matches.length || !lyric || /^\[[a-z]+:/i.test(lyric)) continue;
    for (const match of matches) {
      const fraction = match[3] ? Number(('0.' + match[3]).slice(0, 5)) : 0;
      rows.push({ time: Number(match[1]) * 60 + Number(match[2]) + fraction, text: lyric });
    }
  }
  return rows.sort((a, b) => a.time - b.time);
}
function renderLyricRows(track, currentTime = 0) {
  const raw = track?.lyrics || '';
  const timed = getTimedLyrics(raw);
  const visibleCount = 10;
  const lines = timed.length
    ? (() => {
        const activeIndex = timed.reduce((last, row, i) => row.time <= currentTime ? i : last, -1);
        const safeActive = Math.max(0, activeIndex);
        // Mantém a linha atual fixa na 3ª linha da janela de 10 linhas.
        // Assim ficam duas linhas antes dela e as demais depois.
        const anchorRow = 2;
        const start = Math.max(0, Math.min(safeActive - anchorRow, timed.length - visibleCount));
        return timed.slice(start, start + visibleCount).map((row, i) => ({
          text: row.text,
          active: start + i === safeActive,
        }));
      })()
    : raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, visibleCount).map(text => ({ text, active: false }));
  return Array.from({ length: visibleCount }, (_, i) => {
    const row = lines[i];
    return '<div class="lyric-row' + (row?.active ? ' active' : '') + (!row ? ' empty-row' : '') + '"><span>' + esc(row?.text || ' ') + '</span></div>';
  }).join('');
}
function esc(s) {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[c] || c
  );
}
function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  return (
    Math.floor(sec / 60) +
    ':' +
    Math.floor(sec % 60)
      .toString()
      .padStart(2, '0')
  );
}
function status(s) {
  const e = document.querySelector('#status');
  if (e) e.textContent = s;
}
function persistOrder() {
  localStorage.setItem(PLAYLIST_KEY, JSON.stringify(state.tracks.map(t => t.id)));
}
const NAMED_PLAYLIST_PREFIX = 'musico-mais-saved-playlist:';
function getPlaylistLibrary() {
  let library = {};
  try {
    const stored = JSON.parse(localStorage.getItem(PLAYLIST_LIBRARY_KEY) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) library = stored;
  } catch (_) {}
  // Cada playlist também fica salva em uma chave própria, para que salvar
  // ou exportar outra playlist não faça as anteriores desaparecerem.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(NAMED_PLAYLIST_PREFIX)) continue;
      const name = decodeURIComponent(key.slice(NAMED_PLAYLIST_PREFIX.length));
      const songs = JSON.parse(localStorage.getItem(key) || '[]');
      if (name && Array.isArray(songs)) library[name] = songs;
    }
  } catch (_) {}
  return library;
}
function saveNamedPlaylist() {
  if (!state.tracks.length) {
    status('Importe músicas antes de salvar uma playlist.');
    return;
  }
  const old = document.querySelector('#savePlaylistDialog');
  if (old) old.remove();
  const dialog = document.createElement('div');
  dialog.id = 'savePlaylistDialog';
  dialog.className = 'playlist-picker';
  dialog.innerHTML =
    '<div class="playlist-picker-box save-playlist-box">' +
      '<div class="playlist-picker-title">SALVAR PLAYLIST</div>' +
      '<label class="save-playlist-label">Nome da playlist</label>' +
      '<input id="playlistNameInput" class="playlist-name-input" type="text" placeholder="Ex.: MPB" autocomplete="off">' +
      '<div class="save-playlist-actions">' +
        '<button type="button" id="savePlaylistConfirm">SALVAR</button>' +
        '<button type="button" id="savePlaylistCancel">CANCELAR</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(dialog);
  const input = dialog.querySelector('#playlistNameInput');
  input.focus();
  dialog.querySelector('#savePlaylistCancel').onclick = () => dialog.remove();
  dialog.querySelector('#savePlaylistConfirm').onclick = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const library = getPlaylistLibrary();
    // Guardar nomes e cada playlist em chave própria protege as listas anteriores.
    const savedSongs = state.tracks.map(t => t.name);
    library[name] = savedSongs;
    try {
      localStorage.setItem(NAMED_PLAYLIST_PREFIX + encodeURIComponent(name), JSON.stringify(savedSongs));
      localStorage.setItem(PLAYLIST_LIBRARY_KEY, JSON.stringify(library));
    } catch (_) {
      status('Não foi possível salvar: armazenamento do aparelho indisponível ou cheio.');
      return;
    }
    persistOrder();
    dialog.remove();
    status('Playlist "' + name + '" salva no aparelho. Total de playlists: ' + Object.keys(getPlaylistLibrary()).length + '.');
  };
}
async function openSavedPlaylist(name) {
  const library = getPlaylistLibrary();
  const savedNames = library[name] || [];
  const storedTracks = await getAllTracks();
  const byKey = new Map(storedTracks.map(t => [songKey(t.name), t]));
  const byId = new Map(storedTracks.map(t => [t.id, t]));

  // Aceita playlists novas (por nome) e playlists antigas (por ID).
  // Abrir uma playlist substitui completamente a playlist atual.
  state.tracks = savedNames
    .map(savedItem => byKey.get(songKey(savedItem)) || byId.get(savedItem))
    .filter(Boolean);

  state.current = 0;
  persistOrder();
  render();
  status(state.tracks.length
    ? 'Playlist "' + name + '" aberta com ' + state.tracks.length + ' música(s).'
    : 'Nenhuma música dessa playlist foi encontrada nos áudios salvos.');
}

function importNamedPlaylist() {
  const library = getPlaylistLibrary();
  const names = Object.keys(library);
  if (!names.length) {
    document.querySelector('#playlistInput')?.click();
    return;
  }
  const old = document.querySelector('#playlistPicker');
  if (old) old.remove();

  const picker = document.createElement('div');
  picker.id = 'playlistPicker';
  picker.className = 'playlist-picker';
  picker.innerHTML =
    '<div class="playlist-picker-box">' +
      '<div class="playlist-picker-title">MINHAS PLAYLISTS</div>' +
      '<div class="playlist-picker-list">' +
        names.map((name, i) =>
          '<button type="button" class="playlist-choice" data-name="' + encodeURIComponent(name) + '">' +
            '<b>' + String(i + 1).padStart(2, '0') + '</b><span>' + esc(name) + '</span>' +
          '</button>'
        ).join('') +
      '</div>' +
      '<button type="button" class="playlist-picker-close">FECHAR</button>' +
    '</div>';

  document.body.appendChild(picker);
  picker.querySelectorAll('.playlist-choice').forEach(btn => {
    btn.onclick = async () => {
      picker.remove();
      await openSavedPlaylist(decodeURIComponent(btn.dataset.name));
    };
  });
  picker.querySelector('.playlist-picker-close').onclick = () => picker.remove();
}
async function deleteTrack(id) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function savePlaylistFile() {
  if (!state.tracks.length) {
    status('Importe pelo menos uma música antes de salvar a playlist.');
    return;
  }
  const body = '#EXTM3U\n' + state.tracks.map(t => t.name + '.mp3').join('\n') + '\n';
  const blob = new Blob([body], { type: 'audio/x-mpegurl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Musico_Mais_Playlist.m3u';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  persistOrder();
  const library = getPlaylistLibrary();
  library['Playlist atual'] = state.tracks.map(t => t.id);
  localStorage.setItem(PLAYLIST_LIBRARY_KEY, JSON.stringify(library));
  status('Playlist salva em Downloads e dentro do Player.');
}

function render() {
  const app = document.querySelector('#app');
  const current = state.tracks[state.current];
  const lyricRows = renderLyricRows(current, audio.currentTime);
  app.innerHTML =
    '<main class="shell">' +
    '<section class="top-actions">' +
    '<button id="playlistBtn">☰ IMPORTAR PLAYLIST</button><button id="mp3Btn">📁 IMPORTAR ÁUDIO + LETRA</button><button id="savePlaylistBtn">💾 SALVAR PLAYLIST</button>' +
    '</section>' +
    '<input id="mp3Input" type="file" webkitdirectory directory multiple hidden>' +
    '<input id="playlistInput" type="file" accept=".m3u,.m3u8,.pls,.txt" hidden>' +
    '<section class="playlist panel"><div id="list"></div><div class="playlist-seek"><div class="playlist-seek-actions"><div class="seek-control"><div class="time-row"><span id="currentTime">0:00</span><span id="duration">0:00</span></div><input id="seek" type="range" min="0" max="100" value="0" aria-label="Posição da música"></div><button id="clearPlaylistBtn" type="button">LIMPAR PLAYLIST</button></div></div></section>' +
    '<section class="mixer panel"><div class="mixer-grid">' +
    '<div class="knob-wrap"><span>🥁 BATERIA L</span><button class="knob" id="bateria" type="button" data-min="0" data-max="1" data-value="' + state.bateria + '" aria-label="Volume Bateria L"><i></i></button><b id="bateriaValue">' + Math.round(state.bateria * 100) + '%</b></div>' +
    '<div class="knob-wrap"><span>🎸 BAIXO R</span><button class="knob" id="baixo" type="button" data-min="0" data-max="1" data-value="' + state.baixo + '" aria-label="Volume Baixo R"><i></i></button><b id="baixoValue">' + Math.round(state.baixo * 100) + '%</b></div>' +
    '<div class="knob-wrap"><span>🎹 TECLADO R</span><button class="knob" id="teclado" type="button" data-min="0" data-max="1" data-value="' + state.teclado + '" aria-label="Volume Teclado R"><i></i></button><b id="tecladoValue">' + Math.round(state.teclado * 100) + '%</b></div>' +
    '</div></section>' +
    '<section class="lyrics panel">' +
    '<div id="lyricsText" style="font-size:' + state.fontSize + 'px">' +
    lyricRows +
    '</div></section>' +
    '<nav class="controls"><button id="prev">⏮<small>ANTERIOR</small></button><button id="play" class="main">▶<small>PLAY / PAUSE</small></button><button id="stop">■<small>STOP</small></button><button id="next">⏭<small>PRÓXIMO</small></button></nav>' +
    '<div class="status" id="status">Arquivos salvos no aparelho. Pode usar sem internet.</div></main>';
  renderList();
  bind();
  if (current) loadCurrent(false);
}
function renderList() {
  const list = document.querySelector('#list');
  list.innerHTML = state.tracks.length
    ? state.tracks
        .map(
          (t, i) =>
            '<div class="track-row" data-index="' + i + '">' +
            '<button class="track ' + (i === state.current ? 'selected' : '') + '" data-index="' + i + '" type="button">' +
            '<b>' + String(i + 1).padStart(2, '0') + '</b><span>' + esc(t.name) + '</span>' +
            '</button>' +
            '<button class="track-action drag-handle" type="button" data-index="' + i + '" aria-label="Alterar posição">☰</button>' +
            '<button class="track-action delete-track" type="button" data-index="' + i + '" aria-label="Excluir música">🗑</button>' +
            '</div>'
        )
        .join('')
    : '<div class="empty">Nenhuma música importada.</div>';

  list.querySelectorAll('.track').forEach(button => {
    button.onclick = () => {
      state.current = Number(button.dataset.index);
      loadCurrent(true);
      render();
    };
  });
  list.querySelectorAll('.delete-track').forEach(button => {
    button.onpointerdown = e => e.stopPropagation();
    button.onclick = async e => {
      e.preventDefault();
      e.stopPropagation();
      const index = Number(button.dataset.index);
      const removed = state.tracks[index];
      if (!removed) return;
      await deleteTrack(removed.id);
      if (state.objectUrl) {
        URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = '';
      }
      state.tracks.splice(index, 1);
      if (state.current > index) state.current -= 1;
      if (state.current >= state.tracks.length) state.current = Math.max(0, state.tracks.length - 1);
      persistOrder();
      render();
      status('Música removida da playlist.');
    };
  });
  // Acompanhar automaticamente a faixa atual, mantendo a playlist rolável manualmente.
  requestAnimationFrame(() => {
    const active = list.querySelector('.track.selected');
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = active.getBoundingClientRect();
    const margin = 8;
    if (rowRect.bottom > listRect.bottom - margin) {
      list.scrollTop += rowRect.bottom - listRect.bottom + margin;
    } else if (rowRect.top < listRect.top + margin) {
      list.scrollTop -= listRect.top + margin - rowRect.top;
    }
  });

  list.querySelectorAll('.drag-handle').forEach(handle => {
    let dragging = false;
    let from = -1;
    handle.onpointerdown = e => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      from = Number(handle.dataset.index);
      handle.setPointerCapture(e.pointerId);
      handle.closest('.track-row')?.classList.add('dragging');
    };
    handle.onpointerup = e => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragging) return;
      dragging = false;
      const rows = [...list.querySelectorAll('.track-row')];
      let to = from;
      let best = Infinity;
      rows.forEach((row, index) => {
        const rect = row.getBoundingClientRect();
        const distance = Math.abs(e.clientY - (rect.top + rect.height / 2));
        if (distance < best) { best = distance; to = index; }
      });
      list.querySelectorAll('.track-row').forEach(row => row.classList.remove('dragging'));
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
        const currentId = state.tracks[state.current]?.id;
        const [moved] = state.tracks.splice(from, 1);
        state.tracks.splice(to, 0, moved);
        state.current = Math.max(0, state.tracks.findIndex(t => t.id === currentId));
        persistOrder();
        renderList();
        status('Posição da música alterada.');
      }
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    handle.onpointercancel = () => {
      dragging = false;
      list.querySelectorAll('.track-row').forEach(row => row.classList.remove('dragging'));
    };
  });
}
function updatePlaybackUi() {
  const seek = document.querySelector('#seek');
  const currentTime = document.querySelector('#currentTime');
  const duration = document.querySelector('#duration');
  if (seek && audio.duration) seek.value = String((audio.currentTime / audio.duration) * 100);
  if (currentTime) currentTime.textContent = fmt(audio.currentTime);
  if (duration) duration.textContent = fmt(audio.duration);
  const lyrics = document.querySelector('#lyricsText');
  if (lyrics) lyrics.innerHTML = renderLyricRows(state.tracks[state.current], audio.currentTime);
}
function loadCurrent(auto) {
  const t = state.tracks[state.current];
  if (!t || !t.blob) return;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(t.blob);
  audio.src = state.objectUrl;
  audio.load();
  if (auto) audio.play().catch(() => status('Toque em PLAY para iniciar.'));
}
function confirmClearPlaylist() {
  if (!state.tracks.length) {
    status('A playlist já está vazia.');
    return;
  }
  document.querySelector('#clearPlaylistDialog')?.remove();
  const dialog = document.createElement('div');
  dialog.id = 'clearPlaylistDialog';
  dialog.className = 'playlist-picker';
  dialog.innerHTML =
    '<div class="playlist-picker-box clear-playlist-box" role="dialog" aria-modal="true" aria-labelledby="clearPlaylistTitle">' +
      '<div class="playlist-picker-title" id="clearPlaylistTitle">LIMPAR PLAYLIST</div>' +
      '<p class="clear-playlist-message">Deseja limpar a playlist atual?</p>' +
      '<p class="clear-playlist-note">Os áudios, as letras e as playlists salvas continuarão no aparelho.</p>' +
      '<div class="save-playlist-actions">' +
        '<button type="button" id="clearPlaylistConfirm">LIMPAR</button>' +
        '<button type="button" id="clearPlaylistCancel" class="clear-playlist-cancel">CANCELAR</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('#clearPlaylistCancel').onclick = close;
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.querySelector('#clearPlaylistConfirm').onclick = () => {
    audio.pause();
    audio.currentTime = 0;
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = '';
    }
    state.tracks = [];
    state.current = 0;
    persistOrder();
    close();
    render();
    status('Playlist limpa. Os áudios e as playlists salvas foram preservados.');
  };
  dialog.querySelector('#clearPlaylistCancel').focus();
}
function prevTrack() {
  if (!state.tracks.length) return;
  state.current =
    (state.current - 1 + state.tracks.length) % state.tracks.length;
  render();
  loadCurrent(true);
}
function nextTrack() {
  if (!state.tracks.length) return;
  state.current = (state.current + 1) % state.tracks.length;
  render();
  loadCurrent(true);
}
function bind() {
  document
    .querySelector('#mp3Btn').addEventListener('click', () =>
      document.querySelector('#mp3Input').click()
    );
  // O áudio e a letra são selecionados juntos pelo mesmo botão.
  const disabledLyricImport = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const tracks = await getAllTracks();
    const match = tracks.find(t => songKey(t.name) === songKey(f.name)) || tracks[state.current];
    if (!match) {
      status('Selecione uma música antes de importar a letra.');
      return;
    }
    match.lyrics = parseLyrics(text, f.name);
    await putTrack(match);
    state.tracks = await getAllTracks();
    state.tracks.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    state.current = Math.max(0, state.tracks.findIndex(t => t.id === match.id));
    render();
    status('Letra carregada para "' + match.name + '".');
    e.target.value = '';
  };
  document.querySelector('#playlistBtn').addEventListener('click', () => {
    importNamedPlaylist();
  });
  document.querySelector('#savePlaylistBtn').addEventListener('click', saveNamedPlaylist);
  document.querySelector('#clearPlaylistBtn').addEventListener('click', confirmClearPlaylist);

  document.querySelector('#mp3Input').onchange = async e => {
    const files = Array.from((e.target).files || []);
    if (!files.length) {
      status('Nenhum arquivo foi selecionado.');
      return;
    }
    status('Lendo ' + files.length + ' arquivo(s): áudio e letras...');
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac)$/i.test(f.name));
    const lyricFiles = files.filter(f => /\.(lrc|txt)$/i.test(f.name));
    const existingByBase = new Map(state.tracks.map(t => [baseName(t.name), t]));
    const audioTracks = audioFiles.map(f => {
      const old = existingByBase.get(baseName(f.name));
      return {
        id: old?.id || uid(f.name),
        name: f.name.replace(/\.[^.]+$/, ''),
        blob: f,
        lyrics: old?.lyrics || '',
      };
    });
    if (!audioTracks.length) {
      status('Nenhum MP3/áudio foi encontrado na seleção.');
      e.target.value = '';
      return;
    }
    await putTracks(audioTracks);
    let linkedLyrics = 0;
    const importedIds = new Set(audioTracks.map(t => t.id));
    // Reutiliza os arquivos já selecionados em memória: não relê toda a biblioteca
    // de MP3 do IndexedDB só para montar a playlist recém-importada.
    const importedTracks = audioTracks;
    const usedTrackIds = new Set();
    const lyricUpdates = [];
    const lyricTexts = await Promise.all(lyricFiles.map(async f => ({ file: f, text: parseLyrics(await f.text(), f.name).trim() })));
    for (const item of lyricTexts) {
      const f = item.file;
      // Associa letras primeiro apenas aos áudios desta importação,
      // nunca a músicas antigas de outros estilos que já estão no aparelho.
      let t = importedTracks.find(x => !usedTrackIds.has(x.id) && (
        songKey(x.name) === songKey(f.name) ||
        baseName(x.name) === baseName(f.name) ||
        baseName(x.name + '.lrc') === baseName(f.name) ||
        baseName(x.name + '.txt') === baseName(f.name)
      ));
      // Se o nome não coincidir, usa a música correspondente pela ordem dos arquivos.
      if (!t && audioFiles.length === lyricFiles.length) {
        const pos = lyricFiles.indexOf(f);
        const audioFile = audioFiles[pos];
        t = importedTracks.find(x => baseName(x.name) === baseName(audioFile.name) && !usedTrackIds.has(x.id));
      }
      // Se houver uma única letra sem nome correspondente, usa apenas um áudio importado agora.
      if (!t && lyricFiles.length === 1) {
        t = importedTracks.find(x => !usedTrackIds.has(x.id));
      }
      if (t) {
        t.lyrics = item.text;
        lyricUpdates.push(t);
        usedTrackIds.add(t.id);
        linkedLyrics += 1;
      }
    }
    await putTracks(lyricUpdates);
    // A biblioteca offline mantém todos os arquivos, mas a lista visível
    // contém somente os áudios escolhidos nesta importação.
    // Mantém na tela os próprios arquivos importados, evitando uma segunda
    // leitura completa do IndexedDB após salvar os MP3.
    state.tracks = audioTracks;
    state.tracks.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    render();
    status(audioFiles.length
      ? 'Pasta importada: ' + audioFiles.length + ' áudio(s) e ' + linkedLyrics + ' letra(s) associada(s).'
      : 'Nenhum áudio encontrado na pasta selecionada.');
    (e.target).value = '';
  };
  document.querySelector('#playlistInput').onchange =
    async e => {
      const f = (e.target).files?.[0];
      if (!f) return;
      const names = parsePlaylist(await f.text());
      const by = new Map(state.tracks.map(t => [baseName(t.name), t]));
      const ordered = names.map(n => by.get(n)).filter(Boolean);
      const rest = state.tracks.filter(t => !names.includes(baseName(t.name)));
      state.tracks = ordered.concat(rest);
      persistOrder();
      state.current = 0;
      render();
      status(
        ordered.length
          ? 'Playlist importada e organizada.'
          : 'Importe os MP3s primeiro para a playlist encontrar as músicas.'
      );
    };
  document.querySelector('#play').addEventListener('click', async () => {
    if (!state.tracks.length) return;
    setupMixer();
    updateMixer();
    if (audioContext?.state === 'suspended') await audioContext.resume();
    if (audio.paused) await audio.play(); else audio.pause();
    const b = document.querySelector('#play');
    if (b)
      b.innerHTML = audio.paused
        ? '▶<small>PLAY / PAUSE</small>'
        : '❚❚<small>PLAY / PAUSE</small>';
  });
  document.querySelector('#stop').addEventListener('click', () => {
    audio.pause();
    audio.currentTime = 0;
  });
  document.querySelector('#prev').addEventListener('click', prevTrack);
  document.querySelector('#next').addEventListener('click', nextTrack);
  const bindKnob = (id, key, valueId, min, max) => {
    const knob = document.querySelector('#' + id);
    const value = document.querySelector('#' + valueId);
    if (!knob) return;
    let dragging = false;
    let startY = 0;
    let startValue = state[key];
    const paint = () => {
      const ratio = (state[key] - min) / (max - min);
      knob.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
      if (value) value.textContent = Math.round(state[key] * 100) + '%';
    };
    knob.addEventListener('pointerdown', e => {
      dragging = true;
      startY = e.clientY;
      startValue = state[key];
      knob.setPointerCapture(e.pointerId);
    });
    knob.addEventListener('pointermove', e => {
      if (!dragging) return;
      const sensitivity = (max - min) / 140;
      state[key] = Math.max(min, Math.min(max, startValue + (startY - e.clientY) * sensitivity));
      paint();
      setupMixer(); updateMixer();
      if (audioContext?.state === 'suspended') void audioContext.resume();
    });
    knob.addEventListener('pointerup', () => { dragging = false; });
    knob.addEventListener('pointercancel', () => { dragging = false; });
    knob.addEventListener('wheel', e => {
      e.preventDefault();
      state[key] = Math.max(min, Math.min(max, state[key] - Math.sign(e.deltaY) * (max - min) / 40));
      paint(); setupMixer(); updateMixer();
    }, { passive: false });
    paint();
  };
  bindKnob('bateria', 'bateria', 'bateriaValue', 0, 1);
  bindKnob('baixo', 'baixo', 'baixoValue', 0, 1);
  bindKnob('teclado', 'teclado', 'tecladoValue', 0, 1);
  document.querySelector('#seek').oninput = e => {
    if (audio.duration) {
      audio.currentTime = (Number((e.target).value) / 100) * audio.duration;
      updatePlaybackUi();
    }
  };
}
audio.addEventListener('ended', nextTrack);
audio.addEventListener('loadedmetadata', updatePlaybackUi);
audio.addEventListener('timeupdate', updatePlaybackUi);
async function start() {
  void keepScreenAwake();
  state.tracks = await getAllTracks();
  const order = JSON.parse(
    localStorage.getItem(PLAYLIST_KEY) || '[]'
  );
  const rank = new Map(order.map((id, i) => [id, i]));
  state.tracks.sort(
    (a, b) =>
      (rank.get(a.id) ?? 999999) - (rank.get(b.id) ?? 999999) ||
      a.name.localeCompare(b.name, 'pt-BR')
  );
  render();
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
void start();