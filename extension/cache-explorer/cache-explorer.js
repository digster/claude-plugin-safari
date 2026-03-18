/* cache-explorer.js — Browse, view, and manage cached Claude results */

const sidebarList = document.getElementById('sidebar-list');
const countBadge = document.getElementById('count-badge');
const refreshBtn = document.getElementById('refresh-btn');
const clearAllBtn = document.getElementById('clear-all-btn');
const detailPlaceholder = document.getElementById('detail-placeholder');
const detailContent = document.getElementById('detail-content');
const detailUrl = document.getElementById('detail-url');
const detailPrompt = document.getElementById('detail-prompt');
const detailMeta = document.getElementById('detail-meta');
const detailResult = document.getElementById('detail-result');
const detailCopyBtn = document.getElementById('detail-copy-btn');
const detailDeleteBtn = document.getElementById('detail-delete-btn');

// Currently selected result (full object from the list)
let selectedResult = null;

// All cached results loaded from native handler
let cachedResults = [];

// ── Initialization ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadResults();
});

// ── Event listeners ─────────────────────────────────────────

refreshBtn.addEventListener('click', () => {
  loadResults();
});

clearAllBtn.addEventListener('click', async () => {
  clearAllBtn.disabled = true;
  await sendMessage({ action: 'clearAllCache' });
  clearAllBtn.disabled = false;
  selectedResult = null;
  showPlaceholder();
  loadResults();
});

detailCopyBtn.addEventListener('click', () => {
  const text = detailResult.innerText;
  navigator.clipboard.writeText(text).then(() => {
    detailCopyBtn.textContent = 'Copied!';
    setTimeout(() => { detailCopyBtn.textContent = 'Copy'; }, 1500);
  });
});

detailDeleteBtn.addEventListener('click', async () => {
  if (!selectedResult) return;
  const result = selectedResult.result || selectedResult;
  const url = result.url;
  if (!url) return;

  detailDeleteBtn.disabled = true;
  await sendMessage({ action: 'deleteCachedResult', url });
  detailDeleteBtn.disabled = false;

  selectedResult = null;
  showPlaceholder();
  loadResults();
});

// ── Data loading ────────────────────────────────────────────

/**
 * Fetch all cached results from the native handler and render the sidebar.
 */
async function loadResults() {
  const response = await sendMessage({ action: 'listCachedResults' });
  cachedResults = response?.results || [];
  countBadge.textContent = cachedResults.length;
  renderSidebar();
}

// ── Sidebar rendering ───────────────────────────────────────

function renderSidebar() {
  if (cachedResults.length === 0) {
    sidebarList.innerHTML = '<div class="empty-state">No cached results</div>';
    return;
  }

  sidebarList.innerHTML = '';
  for (const item of cachedResults) {
    const result = item.result || item;
    const url = result.url || 'Unknown URL';
    const status = result.status || 'unknown';
    const modified = item._modified;

    const el = document.createElement('div');
    el.className = 'sidebar-item';

    // Mark active if this is the selected result
    if (selectedResult) {
      const selectedUrl = (selectedResult.result || selectedResult).url;
      if (selectedUrl === url) el.classList.add('active');
    }

    // Build meta line: status dot + timestamp + cost
    const metaParts = [];
    if (modified) metaParts.push(formatTimestamp(modified));
    if (result.response?.cost_usd != null) {
      metaParts.push(`$${result.response.cost_usd.toFixed(4)}`);
    }

    el.innerHTML = `
      <div class="sidebar-item-url">${escapeHtml(url)}</div>
      <div class="sidebar-item-meta">
        <span class="status-dot ${escapeHtml(status)}"></span>
        ${metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join('')}
      </div>
    `;

    el.addEventListener('click', () => {
      selectedResult = item;
      showDetail(item);
      // Update active state in sidebar
      document.querySelectorAll('.sidebar-item.active').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
    });

    sidebarList.appendChild(el);
  }
}

// ── Detail panel ────────────────────────────────────────────

function showPlaceholder() {
  detailPlaceholder.classList.remove('hidden');
  detailContent.classList.add('hidden');
}

function showDetail(item) {
  detailPlaceholder.classList.add('hidden');
  detailContent.classList.remove('hidden');

  const result = item.result || item;

  // URL
  detailUrl.textContent = result.url || 'Unknown URL';

  // Prompt
  if (result.prompt) {
    detailPrompt.innerHTML = `<span class="label">Prompt:</span> ${escapeHtml(result.prompt)}`;
    detailPrompt.classList.remove('hidden');
  } else {
    detailPrompt.classList.add('hidden');
  }

  // Metadata: cost, tokens, duration, timestamp
  const metaParts = [];
  const response = result.response;

  if (response?.cost_usd != null) metaParts.push(`$${response.cost_usd.toFixed(4)}`);
  if (response?.input_tokens) metaParts.push(`${response.input_tokens} input tokens`);
  if (response?.output_tokens) metaParts.push(`${response.output_tokens} output tokens`);
  if (result.startTime && result.endTime) {
    const duration = Math.round((result.endTime - result.startTime) / 1000);
    metaParts.push(`${duration}s`);
  } else if (response?.duration_ms) {
    metaParts.push(`${Math.round(response.duration_ms / 1000)}s`);
  }
  if (item._modified) metaParts.push(formatTimestamp(item._modified));

  detailMeta.innerHTML = metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join('');

  // Render the response content
  let text = '';
  if (response && typeof response === 'object') {
    text = response.result || response.text || response.output || JSON.stringify(response, null, 2);
  } else if (result.error) {
    text = `Error: ${result.error}`;
  } else {
    text = String(response || 'No content');
  }

  detailResult.innerHTML = renderMarkdown(text);
}

// ── Markdown renderer (copied from result.js) ───────────────

function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks
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

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Format a Unix timestamp (ms) to a human-readable date string.
 */
function formatTimestamp(ms) {
  const date = new Date(ms);
  const now = new Date();
  const diff = now - date;

  // Less than 24 hours ago — show relative time
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) {
      const minutes = Math.floor(diff / 60000);
      return minutes <= 1 ? 'just now' : `${minutes}m ago`;
    }
    return `${hours}h ago`;
  }

  // Less than 7 days — show day name + time
  if (diff < 604800000) {
    return date.toLocaleDateString('en-US', { weekday: 'short' }) +
      ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Older — show full date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function sendMessage(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (e) {
    console.error('sendMessage failed:', e);
    return null;
  }
}
