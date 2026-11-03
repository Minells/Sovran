import '@vscode/codicons/dist/codicon.css';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

async function boot() {
  // Development harness only (vite dev server outside VS Code); tree-shaken from production builds.
  if (import.meta.env.DEV && !window.acquireVsCodeApi) await import('./dev/mockHost');
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
