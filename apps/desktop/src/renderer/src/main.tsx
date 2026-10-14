import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { I18nProvider } from './i18n';

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
