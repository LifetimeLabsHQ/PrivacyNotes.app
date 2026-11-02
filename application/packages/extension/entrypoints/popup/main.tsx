import { createRoot } from 'react-dom/client';
import { initReactI18next } from 'react-i18next';
import { IconDefaults } from '@web/icons';
import { startI18n } from '../../src/i18n';
import { App } from './App';
import './style.css';

// The popup follows the system's light or dark choice.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyScheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyScheme();
dark.addEventListener('change', applyScheme);

void startI18n([initReactI18next]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <IconDefaults>
      <App />
    </IconDefaults>,
  );
});
