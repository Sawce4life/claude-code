import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Keep the app openable with no signal. Failing to register is not fatal.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${__BUILD_ID__}`)
      .catch(() => undefined);
  });
}
