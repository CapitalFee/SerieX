import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import '@/styles/theme.css';
import '@/styles/components.css';
import '@/styles/payroll.css';
import { APP_MARK_SVG } from '@/shell/glyphs';

// Application icon for the browser tab (index.html has none).
if (!document.querySelector('link[rel="icon"]')) {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(APP_MARK_SVG);
  document.head.appendChild(link);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
