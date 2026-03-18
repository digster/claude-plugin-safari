/* popup.js — UI logic for Claude Assistant popup */

const askBtn = document.getElementById('ask-btn');
const settingsBtn = document.getElementById('settings-btn');
const prefixDisplay = document.getElementById('prefix-display');
const urlDisplay = document.getElementById('url-display');
const loadingEl = document.getElementById('loading');
const elapsedEl = document.getElementById('elapsed');
const resultArea = document.getElementById('result-area');
const resultContent = document.getElementById('result-content');
const resultMeta = document.getElementById('result-meta');
const copyBtn = document.getElementById('copy-btn');
const popoutBtn = document.getElementById('popout-btn');
const errorArea = document.getElementById('error-area');
const stopBtn = document.getElementById('stop-btn');
const cancelledArea = document.getElementById('cancelled-area');

let currentUrl = '';
let currentTabId = null;
let elapsedTimer = null;

// ── Initialization ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    // Load settings and current tab URL in parallel (lastResult needs currentUrl first)
    const [settings, tabs] = await Promise.all([
      sendMessage({ action: 'getSettings' }),
      browser.tabs.query({ active: true, currentWindow: true })
    ]);

    // Display prefix
    const prefix = settings?.prefix || 'Summarize';
    prefixDisplay.textContent = prefix;

    // Display current tab URL and capture tabId for badge management
    if (tabs && tabs.length > 0 && tabs[0].url) {
      currentUrl = tabs[0].url;
      currentTabId = tabs[0].id;
      urlDisplay.textContent = currentUrl;

      // Disable for non-http URLs (about:blank, settings, etc.)
      const isValidUrl = currentUrl.startsWith('http://') || currentUrl.startsWith('https://');
      askBtn.disabled = !isValidUrl;
    } else {
      urlDisplay.textContent = 'No active tab';
      askBtn.disabled = true;
    }

    // Fetch per-URL cached result (falls through to lastResult.json if no per-URL match)
    const lastResult = await sendMessage({ action: 'getLastResult', url: currentUrl });

    // Check if there's a running or completed result to restore (only for current URL)
    if (lastResult && lastResult.url === currentUrl) {
      if (lastResult.status === 'running') {
        showLoading(lastResult.startTime);
        pollForResult();
      } else if (lastResult.status === 'complete') {
        showResult(lastResult);
        // Clear badge — user has seen the result
        sendMessage({ action: 'clearBadge', url: currentUrl });
      } else if (lastResult.status === 'error') {
        showError(lastResult.error);
        sendMessage({ action: 'clearBadge', url: currentUrl });
      } else if (lastResult.status === 'cancelled') {
        showCancelled();
      }
    }
  } catch (err) {
    console.error('Popup initialization failed:', err);
    showError('Failed to initialize. Please try reopening the popup.');
  }
});

// ── Event listeners ─────────────────────────────────────────

askBtn.addEventListener('click', async () => {
  if (!currentUrl) return;

  askBtn.disabled = true;
  hideError();
  hideResult();
  hideCancelled();
  showLoading();

  const result = await sendMessage({ action: 'runClaude', url: currentUrl, tabId: currentTabId });

  stopLoading();

  if (result?.status === 'cancelled') {
    showCancelled();
    askBtn.disabled = false;
  } else if (result?.status === 'error') {
    showError(result.error);
    // Clear badge — user sees the error in the popup
    sendMessage({ action: 'clearBadge', url: currentUrl });
    askBtn.disabled = false;
  } else if (result?.status === 'complete') {
    showResult(result);
    // Clear badge — user sees the result in the popup
    sendMessage({ action: 'clearBadge', url: currentUrl });
    askBtn.disabled = false;
  } else {
    showError(result?.error || 'No response received. Check that the extension is enabled.');
    askBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await sendMessage({ action: 'cancelClaude', url: currentUrl });
  stopLoading();
  showCancelled();
  askBtn.disabled = false;
});

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

copyBtn.addEventListener('click', () => {
  const text = resultContent.innerText;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
});

popoutBtn.addEventListener('click', () => {
  // Open the full-page result view in a new tab
  browser.tabs.create({
    url: browser.runtime.getURL('result/result.html')
  });
});

// ── UI helpers ──────────────────────────────────────────────

function showLoading(startTime) {
  loadingEl.classList.remove('hidden');
  askBtn.classList.add('hidden');
  stopBtn.disabled = false;

  const start = startTime || Date.now();
  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - start) / 1000);
    elapsedEl.textContent = formatElapsed(seconds);
  }, 1000);
}

function stopLoading() {
  loadingEl.classList.add('hidden');
  askBtn.classList.remove('hidden');
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function showResult(result) {
  resultArea.classList.remove('hidden');

  // Extract the text content from the response
  const response = result.response;
  let text = '';
  let meta = {};

  if (response && typeof response === 'object') {
    // JSON output format from Claude CLI
    text = response.result || response.text || response.output || JSON.stringify(response, null, 2);
    meta = {
      cost: response.cost_usd,
      inputTokens: response.input_tokens,
      outputTokens: response.output_tokens,
      duration: response.duration_ms
    };
  } else {
    text = String(response || '');
  }

  // Render with basic markdown formatting
  resultContent.innerHTML = renderMarkdown(text);

  // Show metadata if available
  const metaParts = [];
  if (meta.cost != null) metaParts.push(`$${meta.cost.toFixed(4)}`);
  if (meta.inputTokens) metaParts.push(`${meta.inputTokens} in`);
  if (meta.outputTokens) metaParts.push(`${meta.outputTokens} out`);
  if (result.startTime && result.endTime) {
    const duration = Math.round((result.endTime - result.startTime) / 1000);
    metaParts.push(`${duration}s`);
  } else if (meta.duration) {
    metaParts.push(`${Math.round(meta.duration / 1000)}s`);
  }

  resultMeta.innerHTML = metaParts.map(p => `<span>${p}</span>`).join('');
}

function showError(message) {
  errorArea.textContent = message;
  errorArea.classList.remove('hidden');
}

function hideError() {
  errorArea.classList.add('hidden');
}

function hideResult() {
  resultArea.classList.add('hidden');
}

function showCancelled() {
  cancelledArea.classList.remove('hidden');
}

function hideCancelled() {
  cancelledArea.classList.add('hidden');
}

/**
 * Poll for result completion when popup was reopened during a running request.
 * Checks every 2 seconds until the result is no longer 'running'.
 */
async function pollForResult() {
  const check = async () => {
    const result = await sendMessage({ action: 'getLastResult', url: currentUrl });

    // Stop polling if result is no longer for the current URL
    if (!result || result.url !== currentUrl) {
      stopLoading();
      askBtn.disabled = false;
      return;
    }

    if (result.status !== 'running') {
      stopLoading();
      if (result.status === 'complete') {
        showResult(result);
        sendMessage({ action: 'clearBadge', url: currentUrl });
      } else if (result.status === 'error') {
        showError(result.error);
        sendMessage({ action: 'clearBadge', url: currentUrl });
      } else if (result.status === 'cancelled') {
        showCancelled();
      }
      askBtn.disabled = false;
      return;
    }
    setTimeout(check, 2000);
  };
  setTimeout(check, 2000);
}

// ── Markdown renderer (basic) ───────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks (```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Messaging helper ────────────────────────────────────────

async function sendMessage(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (e) {
    console.error('sendMessage failed:', e);
    return null;
  }
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// ── Exports for testing ──────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown, formatElapsed };
}
