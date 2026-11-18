import { useEffect, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { connectSession, disconnectDevice, pairDevice, useLanSession } from './api';

export function LanSession({ children }: { children: ReactNode }) {
  const { state, opened } = useLanSession();
  const [name, setName] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const check = () => {
    useLanSession.setState({ state: 'checking' });
    void connectSession().catch(cause => {
      if (cause.status !== 401) useLanSession.setState({ state: 'offline' });
    });
  };
  useEffect(check, []);
  return <>
    {opened && <div inert={state !== 'connected'}>{children}</div>}
    {state !== 'connected' && <div className="modal-backdrop lan-backdrop">
      <section className="workspace-dialog lan-dialog" role="dialog" aria-modal="true" aria-label="MshTV 局域网连接">
        <h2>MshTV · 局域网连接</h2>
        {state === 'checking' && <p role="status">正在连接 MshTV 主机…</p>}
        {state === 'offline' && <><p role="alert">暂时无法连接主机。请检查 Windows 上的 MshTV 是否在运行，以及两台设备的网络是否可互通。</p>
          <button className="workspace-button" type="button" onClick={check}>重新连接</button></>}
        {state === 'pair' && <form onSubmit={e => {
          e.preventDefault();
          if (busy) return;
          setBusy(true); setError('');
          void pairDevice(name, code).then(() => setCode('')).catch(cause => setError(cause.message)).finally(() => setBusy(false));
        }}>
          <p>在 Windows 主机打开「设置 → 局域网访问 → 设备」，生成一次性配对码。配对后，此浏览器会记住设备。</p>
          <label>设备名称<input required maxLength={60} value={name} onChange={e => setName(e.target.value)}/></label>
          <label>配对码<input required inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} onChange={e => setCode(e.target.value)}/></label>
          {error && <p role="alert">{error}</p>}
          <button className="workspace-button primary" disabled={busy}>连接工作空间</button>
        </form>}
      </section>
    </div>}
  </>;
}

export function DeviceLogout() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <>
    <button type="button" className="icon-button" title="退出设备连接" aria-label="退出设备连接" disabled={busy} onClick={() => {
      setBusy(true); setError('');
      void disconnectDevice().catch(cause => setError(cause.message)).finally(() => setBusy(false));
    }}><LogOut size={16}/></button>
    {error && <div className="modal-backdrop"><section className="workspace-dialog" role="alertdialog" aria-label="无法退出连接">
      <p role="alert">{error}</p><button type="button" className="workspace-button" onClick={() => setError('')}>返回</button>
    </section></div>}
  </>;
}
