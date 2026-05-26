let pendingResolver = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data.type === 'INPUT_SUBMIT' && pendingResolver) {
    pendingResolver(new Response(event.data.value));
    pendingResolver = null;
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/__pyodide_input_trigger__')) {
    event.respondWith(
      new Promise((resolve) => {
        pendingResolver = resolve;
        self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'INPUT_REQUEST' });
          });
        });
      })
    );
  }
});