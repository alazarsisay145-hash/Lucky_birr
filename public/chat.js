'use strict';

const STORAGE_KEY = 'secure_chat_participant_id';
let participantId = localStorage.getItem(STORAGE_KEY) || '';
let participant = null;
let pollingTimer = null;
let mediaRecorder = null;
let audioChunks = [];
let messageCursor = 0;
let renderedMessageIds = new Set();
const mediaCache = new Map();

const joinPanel = document.getElementById('joinPanel');
const chatPanel = document.getElementById('chatPanel');
const joinStatus = document.getElementById('joinStatus');
const chatStatus = document.getElementById('chatStatus');
const displayNameInput = document.getElementById('displayNameInput');
const renameInput = document.getElementById('renameInput');
const messagesEl = document.getElementById('messages');
const participantsInfo = document.getElementById('participantsInfo');
const slotInfo = document.getElementById('slotInfo');

function setStatus(el, message, isError = false) {
  el.textContent = message || '';
  el.classList.toggle('error', Boolean(isError));
}

async function readJson(resp) {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch (_err) {
    return iso;
  }
}

async function getMediaDataUri(msg) {
  if (mediaCache.has(msg.id)) return mediaCache.get(msg.id);
  if (!msg.media?.mediaUrl) throw new Error('Media URL is unavailable');

  const query = new URLSearchParams({ participantId });
  const response = await fetch(`${msg.media.mediaUrl}?${query.toString()}`, { cache: 'no-store' });
  const data = await readJson(response);
  const dataUri = `data:${data.media.mimeType};base64,${data.media.dataBase64}`;
  mediaCache.set(msg.id, dataUri);
  return dataUri;
}

function renderParticipants(participants) {
  participantsInfo.textContent = participants.length
    ? participants.map((item) => `S${item.slot}:${item.displayName}`).join(' | ')
    : 'No operators online';
}

function createMessageElement(msg) {
  const block = document.createElement('article');
  block.className = 'msg' + (msg.senderId === participantId ? ' self' : '');
  block.dataset.messageId = msg.id;

  const head = document.createElement('div');
  head.className = 'msg-head';

  const who = document.createElement('strong');
  who.textContent = msg.senderName;
  head.appendChild(who);

  const when = document.createElement('span');
  when.textContent = formatTime(msg.createdAt);
  head.appendChild(when);
  block.appendChild(head);

  if (msg.type === 'text') {
    const p = document.createElement('p');
    p.textContent = msg.text;
    block.appendChild(p);
  } else if (msg.type === 'image' && msg.media?.mediaUrl) {
    const img = document.createElement('img');
    img.alt = `${msg.senderName} image message`;
    img.loading = 'lazy';
    getMediaDataUri(msg)
      .then((uri) => { img.src = uri; })
      .catch(() => { img.alt = 'Image failed to load'; });
    block.appendChild(img);
  } else if (msg.type === 'voice' && msg.media?.mediaUrl) {
    const audio = document.createElement('audio');
    audio.controls = true;
    getMediaDataUri(msg)
      .then((uri) => { audio.src = uri; })
      .catch(() => {
        const fail = document.createElement('p');
        fail.textContent = 'Voice message failed to load.';
        block.appendChild(fail);
      });
    block.appendChild(audio);
  }

  return block;
}

function resetMessagesView() {
  messageCursor = 0;
  renderedMessageIds = new Set();
  mediaCache.clear();
  messagesEl.innerHTML = '';
}

function renderMessages(messages, { reset = false } = {}) {
  const previousBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  if (reset) {
    resetMessagesView();
  }

  for (const msg of messages) {
    if (renderedMessageIds.has(msg.id)) continue;
    messagesEl.appendChild(createMessageElement(msg));
    renderedMessageIds.add(msg.id);
  }

  if (previousBottom < 30) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function setAuthenticatedView(enabled) {
  joinPanel.classList.toggle('hidden', enabled);
  chatPanel.classList.toggle('hidden', !enabled);
}

async function joinChat() {
  const displayName = displayNameInput.value.trim();
  const response = await fetch('/api/chat/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantId, displayName })
  });
  const data = await readJson(response);
  participantId = data.participant.id;
  participant = data.participant;
  localStorage.setItem(STORAGE_KEY, participantId);
  resetMessagesView();
  renameInput.value = participant.displayName;
  slotInfo.textContent = `Slot ${participant.slot} (${participant.displayName})`;
  renderParticipants(data.participants || []);
  setAuthenticatedView(true);
}

async function refreshState() {
  if (!participantId) return;
  let hasMore = true;
  let loopGuard = 0;

  while (hasMore && loopGuard < 10) {
    loopGuard += 1;
    const query = new URLSearchParams({
      participantId,
      since: String(messageCursor)
    });
    const response = await fetch(`/api/chat/state?${query.toString()}`, { cache: 'no-store' });
    if (response.status === 403) {
      localStorage.removeItem(STORAGE_KEY);
      participantId = '';
      participant = null;
      resetMessagesView();
      setAuthenticatedView(false);
      setStatus(joinStatus, 'Session expired. Rejoin channel.', true);
      return;
    }

    const data = await readJson(response);
    participant = data.participant;
    slotInfo.textContent = `Slot ${participant.slot} (${participant.displayName})`;
    renderParticipants(data.participants || []);
    if (typeof data.nextCursor === 'number' && data.nextCursor < messageCursor) {
      renderMessages(data.messages || [], { reset: true });
    } else {
      renderMessages(data.messages || []);
    }
    if (typeof data.nextCursor === 'number') {
      messageCursor = data.nextCursor;
    }
    hasMore = Boolean(data.hasMore);
  }
}

async function updateName() {
  const displayName = renameInput.value.trim();
  const response = await fetch('/api/chat/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantId, displayName })
  });
  const data = await readJson(response);
  participant = data.participant;
  renameInput.value = participant.displayName;
  slotInfo.textContent = `Slot ${participant.slot} (${participant.displayName})`;
  renderParticipants(data.participants || []);
  setStatus(chatStatus, 'Display name updated.');
}

async function sendText() {
  const textInput = document.getElementById('textInput');
  const text = textInput.value.trim();
  if (!text) {
    setStatus(chatStatus, 'Type a message first.', true);
    return;
  }

  const response = await fetch('/api/chat/messages/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participantId, text })
  });
  await readJson(response);
  textInput.value = '';
  await refreshState();
}

async function sendMediaFile(file, kind) {
  const formData = new FormData();
  formData.append('participantId', participantId);
  formData.append('kind', kind);
  formData.append('file', file, file.name || `${kind}.bin`);

  const response = await fetch('/api/chat/messages/media', {
    method: 'POST',
    body: formData
  });
  await readJson(response);
  await refreshState();
}

async function handleImageSelect(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  await sendMediaFile(file, 'image');
}

async function handleVoiceSelect(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  await sendMediaFile(file, 'voice');
}

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  audioChunks = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    try {
      const type = mediaRecorder.mimeType || 'audio/webm';
      const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') || type.includes('m4a') ? 'm4a' : 'webm';
      const blob = new Blob(audioChunks, { type });
      const file = new File([blob], `voice-${Date.now()}.${extension}`, { type });
      await sendMediaFile(file, 'voice');
      setStatus(chatStatus, 'Voice message sent.');
    } catch (error) {
      setStatus(chatStatus, error.message, true);
    } finally {
      for (const track of stream.getTracks()) track.stop();
      mediaRecorder = null;
      audioChunks = [];
      document.getElementById('recordBtn').disabled = false;
      document.getElementById('stopRecordBtn').disabled = true;
    }
  };

  mediaRecorder.start();
  document.getElementById('recordBtn').disabled = true;
  document.getElementById('stopRecordBtn').disabled = false;
  setStatus(chatStatus, 'Recording started...');
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  setStatus(chatStatus, 'Processing voice message...');
}

async function safeAction(action) {
  try {
    setStatus(chatStatus, '');
    setStatus(joinStatus, '');
    await action();
  } catch (error) {
    if (joinPanel.classList.contains('hidden')) {
      setStatus(chatStatus, error.message, true);
    } else {
      setStatus(joinStatus, error.message, true);
    }
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(() => {
    safeAction(refreshState);
  }, 2000);
}

document.getElementById('joinBtn').addEventListener('click', () => safeAction(async () => {
  await joinChat();
  await refreshState();
  startPolling();
  setStatus(chatStatus, 'Secure channel online.');
}));

document.getElementById('renameBtn').addEventListener('click', () => safeAction(updateName));
document.getElementById('sendTextBtn').addEventListener('click', () => safeAction(sendText));
document.getElementById('imageInput').addEventListener('change', (event) => safeAction(() => handleImageSelect(event)));
document.getElementById('voiceInput').addEventListener('change', (event) => safeAction(() => handleVoiceSelect(event)));
document.getElementById('recordBtn').addEventListener('click', () => safeAction(startRecording));
document.getElementById('stopRecordBtn').addEventListener('click', () => safeAction(stopRecording));

document.getElementById('textInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    safeAction(sendText);
  }
});

(async function bootstrap() {
  if (!participantId) {
    setAuthenticatedView(false);
    return;
  }

  try {
    await joinChat();
    await refreshState();
    startPolling();
    setStatus(chatStatus, 'Secure channel restored.');
  } catch (_err) {
    localStorage.removeItem(STORAGE_KEY);
    participantId = '';
    setAuthenticatedView(false);
  }
})();
