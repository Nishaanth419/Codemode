/* ── State ─────────────────────────────────────────────────────────── */
let chats = [];
let activeChatId = null;
let isStreaming = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.warn('The app shell could not be cached for offline use:', error);
  }));
}

/* ── DOM refs ──────────────────────────────────────────────────────── */
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const chatList   = document.getElementById('chat-list');
const newChatButton = document.getElementById('new-chat-button');
const emptyState = document.getElementById('empty-state');
const messages   = document.getElementById('messages');
const userInput  = document.getElementById('user-input');
const sendBtn    = document.getElementById('send-btn');
const authButton = document.getElementById('auth-button');
const loginScreen = document.getElementById('login-screen');
const loginCta = document.getElementById('login-cta');
const mainLayout = document.getElementById('main');
const themeToggle = document.getElementById('theme-toggle');
const themeToggleIcon = document.getElementById('theme-toggle-icon');
let isConnected = false;

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  const nextLabel = selected === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  themeToggle.setAttribute('aria-label', nextLabel);
  themeToggle.title = nextLabel;
  themeToggleIcon.innerHTML = selected === 'dark'
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
    : '<path d="M20.2 15.7A8.5 8.5 0 0 1 8.3 3.8 8.6 8.6 0 1 0 20.2 15.7Z"/>';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', selected === 'dark' ? '#111815' : '#f5f7f6');
  localStorage.setItem('code-mode-theme', selected);
}

applyTheme(localStorage.getItem('code-mode-theme') || 'light');
themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ── Status helpers ─────────────────────────────────────────────────── */
function setStatus(state, label) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = label;
}

/* ── Load this signed-in user's conversations ───────────────────────── */
async function loadChats() {
  try {
    const response = await fetch('/api/chats');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        isConnected = false;
        authButton.style.display = 'none';
        loginScreen.style.display = 'flex';
        mainLayout.style.display = 'none';
        setStatus('', 'Sign in required');
        return;
      }
      throw new Error(data.error || ('HTTP ' + response.status));
    }
    isConnected = true;
    authButton.textContent = 'Disconnect';
    authButton.title = 'Disconnect your INDmoney account';
    authButton.style.display = '';
    loginScreen.style.display = 'none';
    mainLayout.style.display = 'flex';
    chats = data.chats || [];
    renderChats();
    if (chats.length) await selectChat(chats[0].id);
    else await startNewChat();
    setStatus('online', chats.length + ' chats');
  } catch (err) {
    chatList.innerHTML = '<div class="tools-error">Could not load chats<br><small>' + escHtml(err.message) + '</small></div>';
    setStatus('error', 'Connection failed');
  }
}

loginCta.addEventListener('click', () => window.location.assign('/auth/indmoney/connect'));

authButton.addEventListener('click', async () => {
  if (!isConnected) {
    window.location.assign('/auth/indmoney/connect');
    return;
  }
  authButton.disabled = true;
  try {
    await fetch('/auth/indmoney/disconnect', { method: 'POST' });
    messages.innerHTML = '';
    messages.classList.remove('has-messages');
    emptyState.style.display = '';
    chats = [];
    activeChatId = null;
    await loadChats();
  } finally {
    authButton.disabled = false;
  }
});

function renderChats() {
  chatList.innerHTML = '';
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'chat-select' + (chat.id === activeChatId ? ' active' : '');
    select.textContent = chat.title || 'New chat';
    select.title = select.textContent;
    select.addEventListener('click', () => selectChat(chat.id).catch((error) => {
      addMessage('assistant', '<span style="color:var(--error)">' + escHtml(error.message) + '</span>');
    }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chat-delete';
    remove.textContent = '×';
    remove.title = 'Delete chat';
    remove.setAttribute('aria-label', 'Delete ' + (chat.title || 'chat'));
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id).catch((error) => addMessage('assistant', '<span style="color:var(--error)">' + escHtml(error.message) + '</span>'));
    });
    row.append(select, remove);
    chatList.appendChild(row);
  }
}

async function refreshChats() {
  const response = await fetch('/api/chats');
  if (!response.ok) throw new Error('Could not refresh the chat list.');
  chats = (await response.json()).chats || [];
  renderChats();
  setStatus('online', chats.length + ' chats');
}

async function startNewChat() {
  if (isStreaming) return;
  const response = await fetch('/api/chats', { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not create a new chat.');
  chats.unshift(data);
  activeChatId = data.id;
  messages.innerHTML = '';
  messages.classList.remove('has-messages');
  emptyState.style.display = '';
  renderChats();
  userInput.focus();
}

async function selectChat(chatId) {
  if (isStreaming) return;
  const response = await fetch('/api/chats/' + encodeURIComponent(chatId));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not open this chat.');
  activeChatId = chatId;
  messages.innerHTML = '';
  messages.classList.remove('has-messages');
  emptyState.style.display = '';
  for (const message of data.messages || []) {
    if (message.role === 'user') addMessage('user', escHtml(message.content).replace(/\n/g, '<br>'));
    else if (message.role === 'assistant') addMessage('assistant', renderMarkdown(message.content));
  }
  renderChats();
}

async function deleteChat(chatId) {
  if (isStreaming) return;
  if (!window.confirm('Delete this chat?')) return;
  const response = await fetch('/api/chats/' + encodeURIComponent(chatId), { method: 'DELETE' });
  if (!response.ok) throw new Error('Could not delete this chat.');
  chats = chats.filter((chat) => chat.id !== chatId);
  if (activeChatId === chatId) {
    activeChatId = null;
    if (chats.length) await selectChat(chats[0].id);
    else await startNewChat();
  } else renderChats();
}

newChatButton.addEventListener('click', () => startNewChat().catch((error) => {
  addMessage('assistant', '<span style="color:var(--error)">' + escHtml(error.message) + '</span>');
}));

/* ── Chat ────────────────────────────────────────────────────────────── */
function showMessages() {
  emptyState.style.display = 'none';
  messages.classList.add('has-messages');
}

function timeStr() {
  return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function addMessage(role, content) {
  showMessages();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const avatar = role === 'user' ? 'U' : 'C';
  const label  = role === 'user' ? 'You' : 'Agent';
  div.innerHTML = `
    <div class="message-header">
      <div class="message-avatar ${role}">${avatar}</div>
      <div class="message-role">${label}</div>
      <div class="message-time">${timeStr()}</div>
    </div>
    <div class="message-body">${content}</div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function addTypingIndicator() {
  showMessages();
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'typing-indicator';
  div.innerHTML = `
    <div class="message-header">
      <div class="message-avatar assistant">C</div>
      <div class="message-role">Agent</div>
    </div>
    <div class="message-body">
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

/* ── Streaming response handler ──────────────────────────────────────── */
async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;
  isStreaming = true;
  sendBtn.disabled = true;
  setStatus('loading', 'Thinking…');

  addMessage('user', escHtml(text).replace(/\n/g, '<br>'));
  userInput.value = '';
  autoResize();

  const typingDiv = addTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, chatId: activeChatId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (err.loginUrl) {
        const connectLink = `<br><a href="${escHtml(err.loginUrl)}">Connect INDmoney</a>`;
        throw Object.assign(new Error(err.error || 'Connect your INDmoney account.'), { connectLink });
      }
      throw new Error([err.error, err.details].filter(Boolean).join(': ') || `HTTP ${res.status}`);
    }

    removeTypingIndicator();
    const msgDiv = addMessage('assistant', '');
    const bodyDiv = msgDiv.querySelector('.message-body');
    bodyDiv.innerHTML = '';

    // Stream and parse the response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let rawText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      rawText += chunk;
      // Render the accumulated text as it comes in
      bodyDiv.innerHTML = renderMarkdown(rawText.trim());
      messages.scrollTop = messages.scrollHeight;
    }

    if (rawText.trim() === '') {
      bodyDiv.innerHTML = '<em>The model returned no text. Check the local server logs for details.</em>';
    }

    await refreshChats();
  } catch (err) {
    removeTypingIndicator();
    addMessage('assistant',
      `<span style="color:var(--error)">⚠ Error: ${escHtml(err.message)}</span>${err.connectLink || ''}`
    );
    setStatus('error', 'Request failed');
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

/* ── Markdown renderer (minimal) ─────────────────────────────────────── */
function renderMarkdown(text) {
  // Escape helper
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Extract chart blocks first so the agent can return data-driven visuals.
  const chartBlocks = [];
  text = text.replace(/```chart\s*\n([\s\S]*?)```/gi, (_, json) => {
    const idx = chartBlocks.length;
    chartBlocks.push(parseChartSpec(json));
    return `\x00CHART${idx}\x00`;
  });

  // Some model responses wrap the same JSON in bold Markdown instead of a
  // chart fence. Recognize that shape too and render it as a chart.
  text = text.replace(/\*\*\s*(\{[\s\S]*?\})\s*\*\*/g, (whole, json) => {
    const spec = parseChartSpec(json);
    if (!spec) return whole;
    const idx = chartBlocks.length;
    chartBlocks.push(spec);
    return `\x00CHART${idx}\x00`;
  });

  // Extract and replace code blocks
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || 'js', code: code.trimEnd() });
    return `\x00CODE${idx}\x00`;
  });

  // Process inline elements
  text = esc(text);

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold/italic
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Line breaks & paragraphs
  text = text.replace(/\n\n/g, '</p><p style="margin-top:12px">');
  text = text.replace(/\n/g, '<br>');
  text = '<p>' + text + '</p>';

  // Restore code blocks with syntax highlighting
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
    const { lang, code } = codeBlocks[idx];
    const highlighted = highlightCode(code);
    const btnId = 'copy-' + Math.random().toString(36).slice(2);
    return `
      <div class="code-block">
        <div class="code-block-header">
          <span class="lang-badge">${esc(lang || 'code')}</span>
          Code snippet
          <button class="copy-btn" id="${btnId}" onclick="copyCode(this, ${JSON.stringify(code)})">Copy</button>
        </div>
        <pre>${highlighted}</pre>
      </div>`;
  });

  text = text.replace(/\x00CHART(\d+)\x00/g, (_, idx) => renderDataChart(chartBlocks[idx]));

  // Detect result JSON blocks (wrapped in triple backtick or plain)
  // The agent may send result sections prefixed with "Result:" or "Output:"
  text = text.replace(/<p>(<strong>)?(?:Result|Output|Execution Result):?(<\/strong>)?\s*<\/p>/gi,
    '<div class="exec-result-header">⬡ Execution Result</div>');

  return text;
}

function parseChartSpec(json) {
  try {
    // Normalize HTML-encoded spaces/quotes that occasionally appear in model output.
    const normalized = String(json)
      .replace(/&#x20;|&#32;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&');
    const spec = JSON.parse(normalized);
    return spec && ['bar', 'donut'].includes(spec.type) && Array.isArray(spec.data) ? spec : null;
  } catch {
    return null;
  }
}

function renderDataChart(spec) {
  if (!spec || !['bar', 'donut'].includes(spec.type) || !Array.isArray(spec.data)) return '';
  const rows = spec.data.slice(0, 12).map(item => ({
    label: String(item?.label ?? '').slice(0, 80),
    value: Number(item?.value),
  })).filter(item => item.label && Number.isFinite(item.value) && item.value >= 0);
  if (!rows.length) return '';

  const esc = escHtml;
  const title = esc(String(spec.title || 'Data visualization').slice(0, 120));
  const unit = String(spec.unit || '').slice(0, 12);
  const formatValue = value => `${esc(unit)}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value)}`;
  let visualization;

  if (spec.type === 'bar') {
    const max = Math.max(...rows.map(row => row.value), 1);
    visualization = rows.map(row => `
      <div class="chart-row" title="${esc(row.label)}: ${formatValue(row.value)}">
        <span class="chart-label">${esc(row.label)}</span>
        <div class="chart-track"><div class="chart-bar" style="width:${Math.max(row.value / max * 100, row.value ? 2 : 0)}%"></div></div>
        <span class="chart-value">${formatValue(row.value)}</span>
      </div>`).join('');
  } else {
    const colors = ['#27835e', '#6bb48a', '#5d88b5', '#d09b4f', '#a56d9a', '#8aa657', '#d16f62', '#4b9bb1', '#8973af', '#55a585', '#c87848', '#87958d'];
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    if (!total) return '';
    let cursor = 0;
    const stops = rows.map((row, i) => {
      const start = cursor;
      cursor += row.value / total * 100;
      return `${colors[i % colors.length]} ${start}% ${cursor}%`;
    }).join(',');
    visualization = `<div class="donut-layout"><div class="donut-ring" role="img" aria-label="${title}" style="background:conic-gradient(${stops})"></div><div class="donut-legend">${rows.map((row, i) => `
      <div class="donut-item"><span class="donut-swatch" style="background:${colors[i % colors.length]}"></span><span>${esc(row.label)}</span><strong>${formatValue(row.value)}</strong></div>`).join('')}
      </div></div>`;
  }
  return `<figure class="data-chart"><figcaption class="data-chart-title">${title}</figcaption>${visualization}</figure>`;
}

/* ── Minimal syntax highlighter ──────────────────────────────────────── */
function highlightCode(code) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let s = esc(code);

  // Strings
  s = s.replace(/(&#39;[^&#]*&#39;|&quot;[^&]*&quot;|`[^`]*`)/g,
    '<span class="syntax-string">$1</span>');

  // Keywords
  const kw = ['const','let','var','async','await','function','return','if','else',
    'for','while','try','catch','throw','new','import','export','from','class',
    'extends','typeof','instanceof','null','undefined','true','false','this'];
  kw.forEach(k => {
    s = s.replace(new RegExp(`\\b(${k})\\b`, 'g'),
      '<span class="syntax-keyword">$1</span>');
  });

  // Comments
  s = s.replace(/(\/\/[^\n]*)/g, '<span class="syntax-comment">$1</span>');

  // Numbers
  s = s.replace(/\b(\d+\.?\d*)\b/g, '<span class="syntax-number">$1</span>');

  // Function calls
  s = s.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    '<span class="syntax-call">$1</span>(');

  // Properties after dot
  s = s.replace(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    '.<span class="syntax-property">$1</span>');

  return s;
}

/* ── Copy code ───────────────────────────────────────────────────────── */
function copyCode(btn, code) {
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

/* ── Escape HTML ────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Textarea auto-resize ────────────────────────────────────────────── */
function autoResize() {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
}
userInput.addEventListener('input', autoResize);

/* ── Keyboard handler ────────────────────────────────────────────────── */
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(userInput.value);
  }
});

/* ── Send button ─────────────────────────────────────────────────────── */
sendBtn.addEventListener('click', () => sendMessage(userInput.value));

/* ── Example prompts ─────────────────────────────────────────────────── */
document.querySelectorAll('.example-prompt').forEach(btn => {
  btn.addEventListener('click', () => {
    const prompt = btn.dataset.prompt;
    userInput.value = prompt;
    autoResize();
    sendMessage(prompt);
  });
});

/* ── Init ────────────────────────────────────────────────────────────── */
loadChats();
userInput.focus();
