/* result.js — Full-page pop-out result view for Claude Assistant */

const resultContent = document.getElementById('result-content');
const promptDisplay = document.getElementById('prompt-display');
const resultMeta = document.getElementById('result-meta');
const copyBtn = document.getElementById('copy-btn');

// ── Load last result from storage ───────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const lastResult = await sendMessage({ action: 'getLastResult' });

  if (!lastResult || lastResult.status !== 'complete') {
    resultContent.innerHTML = '<p class="placeholder">No result available. Run a query from the extension popup first.</p>';
    return;
  }

  // Show the prompt used
  promptDisplay.innerHTML = `<span class="label">Prompt:</span> ${escapeHtml(lastResult.prompt || '')}`;

  // Extract and render the response text
  const response = lastResult.response;
  let text = '';
  let meta = {};

  if (response && typeof response === 'object') {
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

  resultContent.innerHTML = renderMarkdown(text);

  // Display metadata
  const metaParts = [];
  if (meta.cost != null) metaParts.push(`$${meta.cost.toFixed(4)}`);
  if (meta.inputTokens) metaParts.push(`${meta.inputTokens} input tokens`);
  if (meta.outputTokens) metaParts.push(`${meta.outputTokens} output tokens`);
  if (lastResult.startTime && lastResult.endTime) {
    const duration = Math.round((lastResult.endTime - lastResult.startTime) / 1000);
    metaParts.push(`${duration}s`);
  } else if (meta.duration) {
    metaParts.push(`${Math.round(meta.duration / 1000)}s`);
  }
  if (lastResult.url) metaParts.push(lastResult.url);

  resultMeta.innerHTML = metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join('');
});

// ── Copy to clipboard ───────────────────────────────────────

copyBtn.addEventListener('click', () => {
  const text = resultContent.innerText;
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
});

// ── Markdown renderer ───────────────────────────────────────

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

// ── Messaging helper ────────────────────────────────────────

function sendMessage(message) {
  return new Promise((resolve) => {
    browser.runtime.sendMessage(message, resolve);
  });
}
