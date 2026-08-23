// 走相對路徑，由 Vite dev server 的 proxy（vite.config.js）轉發到本機後端，
// 前端跟後端在瀏覽器眼中永遠是同一個 origin，不管是用 localhost、區網 IP、還是外部通道網址開都一樣，
// 也順便避開「localhost 與 IP 位址是不同 cookie site」的問題。僅在特殊情況才用 VITE_API_URL 覆蓋指向遠端後端。
const API_URL = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (isJson && data.error) || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

export { API_URL };
