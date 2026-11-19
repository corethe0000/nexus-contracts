import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { setLanguage } from './lib/i18n';
import './styles.css';

type Init = { settings?: { locale?: string } };
const utilities = (window as unknown as { NEXUS?: { utilities?: { onceInitialize?: (f: (d: Init) => void) => void } } }).NEXUS?.utilities;

let started = false;
function start(locale?: string) {
  if (started) {
    return;
  }
  started = true;
  setLanguage(locale ?? navigator.language);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

//in the wallet: its language, sent when the module page starts (English after a second without it)
if (utilities?.onceInitialize) {
  utilities.onceInitialize((d) => start(d?.settings?.locale));
  setTimeout(() => start('en'), 1500);
} else {
  start();
}
