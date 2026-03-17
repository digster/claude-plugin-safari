/* settings.js — Configuration UI for Claude Assistant */

const prefixInput = document.getElementById('prefix-input');
const cliPathInput = document.getElementById('cli-path-input');
const allowedToolsInput = document.getElementById('allowed-tools-input');
const verifyBtn = document.getElementById('verify-btn');
const verifyStatus = document.getElementById('verify-status');
const saveBtn = document.getElementById('save-btn');
const messageEl = document.getElementById('message');

// ── Load current settings on page open ──────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await sendMessage({ action: 'getSettings' });
  if (settings) {
    prefixInput.value = settings.prefix || '';
    cliPathInput.value = settings.cliPath || '';
    allowedToolsInput.value = settings.allowedTools || '';
  }
});

// ── Save settings ───────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const settings = {
    prefix: prefixInput.value.trim(),
    cliPath: cliPathInput.value.trim(),
    allowedTools: allowedToolsInput.value.trim()
  };

  const result = await sendMessage({ action: 'saveSettings', settings });

  if (!result) {
    showMessage('Failed to save settings. Extension may not be responding.', 'error');
  } else if (result.error) {
    showMessage('Error saving settings: ' + result.error, 'error');
  } else {
    showMessage('Settings saved.', 'success');
  }
});

// ── Verify CLI path ─────────────────────────────────────────

verifyBtn.addEventListener('click', async () => {
  const cliPath = cliPathInput.value.trim();
  if (!cliPath) {
    showVerifyStatus('Please enter a CLI path.', false);
    return;
  }

  verifyBtn.disabled = true;
  verifyBtn.textContent = 'Checking...';

  const result = await sendMessage({ action: 'verifyCli', cliPath });

  verifyBtn.disabled = false;
  verifyBtn.textContent = 'Verify';

  if (result?.exists) {
    showVerifyStatus('CLI found and executable.', true);
  } else {
    showVerifyStatus(result?.error || 'CLI not found at this path.', false);
  }
});

// ── UI helpers ──────────────────────────────────────────────

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.remove('hidden');
  setTimeout(() => messageEl.classList.add('hidden'), 3000);
}

function showVerifyStatus(text, ok) {
  verifyStatus.textContent = text;
  verifyStatus.className = `verify-status ${ok ? 'ok' : 'fail'}`;
  verifyStatus.classList.remove('hidden');
}

async function sendMessage(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (e) {
    console.error('sendMessage failed:', e);
    return null;
  }
}
