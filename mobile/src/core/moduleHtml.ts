export function moduleHtml(code: string): string {
  const safeCode = code.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>body{font:14px system-ui;background:#101513;color:#f2f6f3;padding:16px}input,textarea,button{font:inherit;border:1px solid #345144;border-radius:8px;padding:9px;background:#17221b;color:#f2f6f3}button{cursor:pointer}textarea{width:100%;box-sizing:border-box}</style></head><body><div id="app"></div><script>
(() => {
  const pending = new Map();
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'fugu-rpc-response') return;
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error)); else item.resolve(msg.result);
  });
  window.fugu = { call: (method, payload) => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2) + Date.now();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout')); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    parent.postMessage({ type: 'fugu-rpc', id, method, payload }, '*');
  }) };
})();
</script><script>${safeCode}</script></body></html>`;
}
