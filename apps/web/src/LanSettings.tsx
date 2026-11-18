import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { request } from './api';

interface Status {
  enabled: boolean; address: string | null; port: number; activeUrl: string | null; accepting: boolean;
  restartRequired: boolean; error: string | null; fingerprint: string | null;
  addresses: { address: string; name: string; prefix: number }[];
  devices: { id: string; name: string; address: string }[];
}

export function LanSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [section, setSection] = useState<'connection' | 'devices'>('connection');
  const [address, setAddress] = useState(''), [port, setPort] = useState('5443'), [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [pair, setPair] = useState<{ code: string; expires: string }>();

  useEffect(() => {
    const controller = new AbortController();
    void request<Status>('/lan/status', { signal: controller.signal }).then(data => {
      setStatus(data); setEnabled(data.enabled); setAddress(data.address ?? data.addresses[0]?.address ?? ''); setPort(String(data.port));
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);

  const post = <T,>(path: string, body: object = {}) => request<T>('/lan/' + path, { method: 'POST', body: JSON.stringify(body) });
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function save(renewCertificate = false) {
    await post('settings', { enabled, address, port: Number(port), renewCertificate });
    setPair(undefined);
    setStatus(await request<Status>('/lan/status'));
  }
  return <div className="modal-backdrop" onKeyDown={e => {
    if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); }
  }}>
    <section className="workspace-dialog storage-dialog lan-dialog" role="dialog" aria-modal="true" aria-label="局域网访问">
      <div className="panel-heading"><h2>局域网访问</h2><button type="button" autoFocus className="icon-button" aria-label="关闭局域网设置" disabled={busy} onClick={onClose}><X size={18}/></button></div>
      <div className="storage-tabs" role="group" aria-label="局域网设置页面">
        <button type="button" className="workspace-button" aria-pressed={section === 'connection'} disabled={busy} onClick={() => setSection('connection')}>连接</button>
        <button type="button" className="workspace-button" aria-pressed={section === 'devices'} disabled={busy} onClick={() => setSection('devices')}>设备</button>
      </div>
      {status && section === 'connection' && <>
        <p role="status">主机运行中 · {status.accepting ? '局域网 HTTPS 已接受连接' : status.restartRequired ? '等待重启' : '仅本机访问'}</p>
        {status.error && <p role="alert">{status.error}</p>}
        {status.restartRequired && <p>保存当前编辑，关闭后端并重新运行 start.cmd。关闭局域网或更改设置后，旧连接立即失效。</p>}
        {status.accepting && status.activeUrl && <label>其他设备访问地址<input readOnly value={status.activeUrl} onFocus={e => e.currentTarget.select()}/></label>}
        <form onSubmit={e => { e.preventDefault(); void run(() => save()); }}>
          <label className="lan-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>启用局域网访问</label>
          {enabled && <>
            <label>监听网卡地址<select value={address} required onChange={e => setAddress(e.target.value)}>
              <option value="">请选择</option>
              {status.addresses.map(item => <option key={item.address} value={item.address}>{item.name} · {item.address}/{item.prefix}</option>)}
            </select></label>
            <label>HTTPS 端口<input type="number" min={1024} max={65535} required value={port} onChange={e => setPort(e.target.value)}/></label>
          </>}
          <button type="submit" className="workspace-button primary" disabled={busy}>保存局域网设置</button>
        </form>
        {status.enabled && status.fingerprint && <>
          <h3>首次连接</h3>
          <p>将信任证书提供给你的设备，核对 SHA-256 指纹并在系统中信任。用同一个浏览器和地址访问，首次输入配对码后会记住该设备。</p>
          <div className="storage-actions">
            <a className="workspace-button" href="/api/v1/lan/certificate" download>下载信任证书</a>
            <button type="button" className="workspace-button" disabled={busy || !enabled} onClick={() => void run(() => save(true))}>更新证书</button>
          </div>
          <code>{status.fingerprint.match(/.{1,4}/g)?.join(' ')}</code>
        </>}
        {status.accepting && <>
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void run(async () => {
            await post('test'); setMessage('主机的 HTTPS 地址和证书检查通过。请在另一台设备打开该地址验证网络连通。');
          })}>测试主机连接</button>
          <p>如果其他设备连接超时，请检查 Windows 防火墙入站设置、访客 Wi‑Fi 或不同子网间的路由。主机测试只验证本机的 HTTPS。</p>
        </>}
      </>}
      {status && section === 'devices' && (status.accepting ? <>
        <div className="storage-actions">
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void run(async () => {
            setPair(await post<{ code: string; expires: string }>('code'));
          })}>生成一次性配对码</button>
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void run(async () => {
            setStatus(await request<Status>('/lan/status'));
          })}>刷新设备</button>
        </div>
        {pair && <p>配对码 <strong className="lan-code">{pair.code}</strong> · {new Date(pair.expires).toLocaleTimeString('zh-CN')} 前使用一次</p>}
        {status.devices.length === 0 && <p>还没有配对设备。</p>}
        {status.devices.map(device => <div key={device.id} className="lan-device">
          <div>{device.name}<small>已记住 · 配对地址 {device.address}</small></div>
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void run(async () => {
            await request('/lan/devices/' + encodeURIComponent(device.id), { method: 'DELETE' });
            setStatus(await request<Status>('/lan/status'));
          })}>撤销访问</button>
        </div>)}
      </> : <p>局域网接受连接后，可以在这里配对和管理设备。</p>)}
      {busy && <p role="status">正在处理…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>;
}
