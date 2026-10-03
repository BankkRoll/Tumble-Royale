/**
 * UI preview harness entry (`/ui.html`). Mounts the real overlay over a fake
 * 3D backdrop, seeds mock data, wires a mock game and opens `?screen=<id>`.
 */
import { createRoot } from 'react-dom/client';
import { mountUI, setAudioHooks, ui } from '@tumble/ui';
import '../styles.css';
import './preview.css';
import { DevMenu } from './DevMenu.tsx';
import { FakeWorld } from './FakeWorld.tsx';
import { installMockGame } from './mockGame.ts';
import { applyPreset } from './presets.ts';
import { seedMeta } from './world.ts';

const params = new URLSearchParams(location.search);

if (params.has('cues')) {
  setAudioHooks({
    cue: (name) => console.debug('[cue]', name),
    music: (track) => console.debug('[music]', track),
  });
}

seedMeta();
installMockGame();

const fake = document.getElementById('fake3d');
if (fake) createRoot(fake).render(<FakeWorld />);

const uiRoot = document.getElementById('ui');
if (uiRoot) mountUI(uiRoot);

const dev = document.getElementById('dev');
if (dev) createRoot(dev).render(<DevMenu />);

const start = params.get('screen');
if (!start || !applyPreset(start)) {
  ui.getState().setBoot({ progress: 0, label: '' });
  ui.getState().setScreen('boot', { transition: 'none' });
  let p = 0;
  const id = window.setInterval(() => {
    p = Math.min(1, p + 0.07 + Math.random() * 0.08);
    ui.getState().setBoot({ progress: p, label: '' });
    if (p >= 1) {
      window.clearInterval(id);
      window.setTimeout(() => ui.getState().setScreen('splash'), 300);
    }
  }, 160);
}
