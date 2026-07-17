const form = document.getElementById('submissionForm');
const statusEl = document.getElementById('status');
const submitButton = document.getElementById('submitButton');
const playNowButton = document.getElementById('playNowButton');
const backToGameButton = document.getElementById('backToGameButton');
const gameScreen = document.getElementById('gameScreen');
const submissionScreen = document.getElementById('submissionScreen');

playNowButton.addEventListener('click', () => {
  gameScreen.classList.add('hidden');
  submissionScreen.classList.remove('hidden');
  setStatus('', false);
});

backToGameButton.addEventListener('click', () => {
  submissionScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  setStatus('', false);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const payload = new FormData(form);
  const fullName = String(payload.get('fullName') || '').trim();
  const phone = String(payload.get('phone') || '').trim();
  const ticketNumber = String(payload.get('ticketNumber') || '').trim();
  const amount = String(payload.get('amount') || '').trim();

  if (!fullName || !phone || !ticketNumber || !amount) {
    setStatus('Please fill in all required fields.', true);
    return;
  }

  setStatus('Submitting...', false);
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      body: payload
    });

    const raw = await response.text();
    let data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        data = {};
      }
    }
    if (!response.ok) {
      throw new Error(data.error || 'Submission failed');
    }

    form.reset();
    setStatus('✅ Submission received. Waiting for approval.', false);
  } catch (error) {
    setStatus(`❌ ${error.message}`, true);
  } finally {
    submitButton.disabled = false;
  }
});

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = `status ${isError ? 'err' : 'ok'}`;
}
