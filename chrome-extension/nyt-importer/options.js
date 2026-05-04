const tokenInput = document.getElementById('token');
const apiBaseInput = document.getElementById('apiBase');
const msg = document.getElementById('msg');

(async () => {
  const { token, apiBase } = await chrome.storage.sync.get(['token', 'apiBase']);
  if (token) tokenInput.value = token;
  apiBaseInput.value = apiBase || 'https://meals.alaskatargeting.com';
})();

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const apiBase = apiBaseInput.value.trim().replace(/\/$/, '');
  if (!token) { msg.textContent = 'Token cannot be empty.'; msg.style.color = 'var(--error)'; return; }
  if (!apiBase) { msg.textContent = 'API URL cannot be empty.'; msg.style.color = 'var(--error)'; return; }
  await chrome.storage.sync.set({ token, apiBase });
  msg.style.color = '';
  msg.textContent = '✓ Saved.';
  setTimeout(() => { msg.textContent = ''; }, 2500);
});
