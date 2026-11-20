import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { setLanguage } from './lib/i18n';
import { setWalletGenesis, watchWallet } from './lib/walletUser';
import './styles.css';

type Init = { settings?: { locale?: string }; userStatus?: { genesis?: string } | null };
type Utilities = { onceInitialize?: (f: (d: Init) => void) => void; onWalletDataUpdated?: (f: (d: Init) => void) => void };
const utilities = (window as unknown as { NEXUS?: { utilities?: Utilities } }).NEXUS?.utilities;

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
  utilities.onceInitialize((d) => {
    setWalletGenesis(d?.userStatus?.genesis);
    start(d?.settings?.locale);
  });
  watchWallet(utilities);
  setTimeout(() => start('en'), 1500);
} else {
  start();
}
