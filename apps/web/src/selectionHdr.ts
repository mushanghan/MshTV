import { create } from 'zustand';

const enabledKey = 'mshtv:selection-hdr';
const flashKey = 'mshtv:selection-hdr-flash';
const normalStrength = 25;
export const hdrDisplayQuery = '(dynamic-range: high)';

type Output = 'idle' | 'ready' | 'fallback';

function read(key: string) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function save(key: string, value: string) {
  try { localStorage.setItem(key, value); }
  catch { /* The current page can still use the preference. */ }
}

function preferences() {
  const hdrEnabled = read(enabledKey) === 'on';
  return {
    hdrEnabled,
    flashMode: hdrEnabled && read(flashKey) === 'on',
  };
}

type Preferences = ReturnType<typeof preferences>;

export function hdrBrightness(settings: Preferences, dark: boolean) {
  if (!settings.hdrEnabled) return 0;
  if (settings.flashMode) return 100;
  return dark ? 0 : normalStrength;
}

export const useSelectionHdr = create<Preferences & {
  output: Output;
  setHdrEnabled: (value: boolean) => void;
  setFlashMode: (value: boolean) => void;
}>((set, get) => ({
  ...preferences(),
  output: 'idle',
  setHdrEnabled(hdrEnabled) {
    if (hdrEnabled) set({ hdrEnabled });
    else {
      set({ hdrEnabled, flashMode: false });
      save(flashKey, 'off');
    }
    save(enabledKey, hdrEnabled ? 'on' : 'off');
  },
  setFlashMode(value) {
    const flashMode = get().hdrEnabled && value;
    set({ flashMode });
    save(flashKey, flashMode ? 'on' : 'off');
  },
}));

export function initializeSelectionHdr() {
  window.addEventListener('storage', event => {
    if (event.key === enabledKey || event.key === flashKey || event.key === null) {
      useSelectionHdr.setState(preferences());
    }
  });
}
