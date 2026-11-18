import { create } from 'zustand';

type Theme = 'dark' | 'light';
const storageKey = 'mshtv:theme';
const lightGray = 7;

const lightSurfaces = {
  paper: '#f7f7f8', surface: '#fdfdfd', sidebar: '#e8e9ec', raised: '#ffffff', inset: '#f1f2f4',
  line: '#e1e3e6', 'line-strong': '#cbd0d6', 'sidebar-line': '#d9dce2',
  'accent-soft': '#e9ebee',
  'warning-bg': '#eef0f3',
  canvas: '#efeff1', grid: '#9fa4ad52', 'playback-surface': '#fcfcfdf5',
};

function shade(hex: string, percent: number, target = 80) {
  const channels = [1, 3, 5].map(offset => {
    const base = parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(base + (target - base) * percent / 100).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}${hex.slice(7)}`;
}

function initialTheme(): Theme {
  try { return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? shade(lightSurfaces.surface, lightGray) : '#141619');
}

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => ({
  theme: initialTheme(),
  toggle() {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
    try { localStorage.setItem(storageKey, next); } catch { /* The current page still switches themes. */ }
  },
}));

export function initializeTheme() {
  const root = document.documentElement;
  for (const [name, color] of Object.entries(lightSurfaces)) {
    root.style.setProperty(`--light-${name}`, shade(color, lightGray));
  }
  root.style.setProperty('--light-muted', shade('#4f5259', lightGray * 1.5, 23));
  root.style.setProperty('--light-subtle', shade('#656972', lightGray * 1.5, 23));
  applyTheme(useTheme.getState().theme);
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    const theme = initialTheme();
    if (theme === useTheme.getState().theme) return;
    applyTheme(theme);
    useTheme.setState({ theme });
  });
}

const canvasPalettes = {
  dark: {
    card: '#24282d', cardBorder: '#3a3f44', cardTitle: '#e1e4e5', cardMeta: '#808990',
    stillPlaceholder: '#30363a', audioPlaceholder: '#2b3037', audioWave: '#8e9caa',
    previewMask: '#23282be6', previewWarning: '#d3ad8e', playBackground: '#1c2229', playIcon: '#b9c6cc',
    note: '#33312a', noteBorder: '#3a3f44', noteText: '#eee9d9', noteHint: '#8e8a7b', noteEmphasis: '#f07878',
    group: '#202a24', groupBorder: '#53695b', groupTitle: '#a5bbad',
    selected: '#a7c4b1', anchor: '#b1cbb9', anchorFill: '#1a211e', overview: '#6f8d7d', box: '#a8c9b5', boxFill: '#a8c9b51a',
    selectionGlow: { color: 'rgba(182, 139, 91, .72)', fill: '#b68b5b', blur: 22 },
    elevation: false,
  },
  light: {
    card: '#ffffff', cardBorder: '#d9dce1', cardTitle: '#282a30', cardMeta: '#646873',
    stillPlaceholder: '#eff0f2', audioPlaceholder: '#eceef1', audioWave: '#737984',
    previewMask: '#f0f1f4ef', previewWarning: '#545862', playBackground: '#31353d', playIcon: '#f7f8fa',
    note: '#ffffff', noteBorder: '#d9dce1', noteText: '#282a2f', noteHint: '#656972', noteEmphasis: '#aa342d',
    group: '#e8eaee', groupBorder: '#d0d4db', groupTitle: '#4f535c',
    selected: '#5b616d', anchor: '#535963', anchorFill: '#ffffff', overview: '#7d838f', box: '#666d79', boxFill: '#666d791e',
    selectionGlow: { color: 'rgba(255, 244, 208, .97)', fill: '#fff9e8', blur: 24 },
    elevation: true,
  },
};
export type CanvasPalette = typeof canvasPalettes.dark;
const light = canvasPalettes.light;
const lightCanvasPalette: CanvasPalette = {
  ...light,
  card: shade(light.card, lightGray), note: shade(light.note, lightGray), group: shade(light.group, lightGray),
  cardBorder: shade(light.cardBorder, lightGray), noteBorder: shade(light.noteBorder, lightGray), groupBorder: shade(light.groupBorder, lightGray),
  stillPlaceholder: shade(light.stillPlaceholder, lightGray), audioPlaceholder: shade(light.audioPlaceholder, lightGray),
  cardMeta: shade(light.cardMeta, lightGray * 1.5, 23), noteHint: shade(light.noteHint, lightGray * 1.5, 23),
  groupTitle: shade(light.groupTitle, lightGray * 1.5, 23),
};
export function useCanvasPalette(): CanvasPalette {
  return useTheme(state => state.theme === 'light' ? lightCanvasPalette : canvasPalettes.dark);
}
