import { ChevronRight, HardDrive, Network, Settings } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { LanSettings } from './LanSettings';
import { StoragePanel } from './StoragePanel';
import { isLanClient } from './navigation';
import { useSelectionHdr } from './selectionHdr';
import { useTheme } from './theme';

type SettingsPanel = 'lan' | 'storage';

export function SettingsMenu({ ready }: { ready: boolean }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<SettingsPanel | null>(() => {
    if (isLanClient) return null;
    const target = new URLSearchParams(location.search).get('settings');
    return target === 'lan' || target === 'storage' ? target : null;
  });
  const panelId = useId();
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    content.current?.querySelector<HTMLElement>('button:enabled, input:enabled')?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  function openPanel(target: SettingsPanel) {
    setOpen(false);
    setPanel(target);
  }

  function closePanel() {
    setPanel(null);
    trigger.current?.focus();
  }

  return <>
    <div className="settings-control" ref={control} onKeyDown={event => {
      event.stopPropagation();
      if (!open || event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    }}>
      <button ref={trigger} type="button" className="icon-button" aria-label="设置" title="设置"
        aria-controls={panelId} aria-expanded={open} onClick={() => setOpen(!open)}><Settings size={18}/></button>
      <div id={panelId} ref={content} className="settings-menu" role="group" aria-label="设置选项" hidden={!open}>
        {!isLanClient && <div className="settings-links" role="group" aria-label="主机设置">
          <button type="button" disabled={!ready} onClick={() => openPanel('lan')}>
            <Network size={16}/><span>局域网访问</span><ChevronRight size={14}/>
          </button>
          <button type="button" disabled={!ready} onClick={() => openPanel('storage')}>
            <HardDrive size={16}/><span>存储与维护</span><ChevronRight size={14}/>
          </button>
        </div>}
        <HdrSettings/>
      </div>
    </div>
    {ready && panel === 'lan' && <LanSettings onClose={closePanel}/>}
    {ready && panel === 'storage' && <StoragePanel onClose={closePanel}/>}
  </>;
}

function HdrSettings() {
  const light = useTheme(state => state.theme === 'light');
  const { hdrEnabled, flashMode, output, setHdrEnabled, setFlashMode } = useSelectionHdr();
  let status = '可在画布中预览';
  if (!hdrEnabled) status = '已关闭，使用 SDR';
  else if (!light && !flashMode) status = '深色主题仅在闪光弹模式下显示 HDR 高光';
  else if (output === 'ready') status = 'HDR 输出已就绪';
  else if (output === 'fallback') status = '当前使用 SDR，请检查系统 HDR 和浏览器支持';

  return <div className="settings-display" role="group" aria-label="HDR 亮度">
    <label className="settings-row">HDR 选中光晕
      <input type="checkbox" role="switch" checked={hdrEnabled} onChange={event => setHdrEnabled(event.currentTarget.checked)}/>
    </label>
    <p className="settings-status" role="status">{status}</p>
    <label className="settings-row">闪光弹模式
      <input type="checkbox" role="switch" disabled={!hdrEnabled} checked={flashMode} onChange={event => setFlashMode(event.currentTarget.checked)}/>
    </label>
  </div>;
}
