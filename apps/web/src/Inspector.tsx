import { Group, MousePointer2, Ungroup } from 'lucide-react';
import { useCanvas } from './store';
import { duration, fileSize, statusLabel, useAsset, useMediaPreview } from './library';
import { useMediaGeometry, mediaLayout } from './canvas/mediaGeometry';
import { groupNameLimit } from './model';

export function Inspector() {
  const doc = useCanvas(s => s.doc), selected = useCanvas(s => s.selected), selectedGroups = useCanvas(s => s.selectedGroups), editable = useCanvas(s => s.editable);
  const board = doc.groups.find(g => selectedGroups.length === 1 && g.id === selectedGroups[0]), current = doc.items.find(i => i.id === selected[0]);
  const asset = useAsset(current?.assetId);
  useMediaGeometry();
  const target = board ?? (current && mediaLayout(current));
  const selectMembers = () => {
    const groups = new Set(selectedGroups);
    useCanvas.getState().select(doc.items.filter(item => item.groupId && groups.has(item.groupId)).map(item => item.id));
  };
  if (selectedGroups.length > 1) return <div className="property-section">
    <h3>已选 {selectedGroups.length} 个分组</h3>
    <button className="wide-button" onClick={selectMembers}>选中组内元素</button>
    <button className="wide-button" disabled={!editable} onClick={() => useCanvas.getState().ungroup()}>解除分组</button>
  </div>;
  if (!target) return <div className="no-selection"><MousePointer2 size={25} strokeWidth={1}/><h3>选择一个元素或分组板</h3><p>查看布局与名称，<br/>或框选多个元素一起整理。</p></div>;
  const grouped = !!board || doc.items.some(i => selected.includes(i.id) && i.groupId);
  const title = board ? board.name : selected.length > 1 ? `${selected.length} 个元素` : current!.type === 'note' ? current!.text.split('\n')[0] || '空白备注' : current!.title;
  return <>
    <div className="property-type">{board ? '分组板' : selected.length > 1 ? 'MULTIPLE SELECTION' : current!.type.toUpperCase()}</div>
    <h2 className="property-title">{title}</h2>
    {asset && <div className="property-section"><h3>素材文件</h3><p className="property-hint">{asset.name}<br/>{asset.extension.toUpperCase()} · {fileSize(asset.size)} {duration(asset.duration)}<br/>{statusLabel(asset.status)}</p><button className="wide-button" onClick={() => useMediaPreview.getState().open(asset.id)}>预览素材</button><p className="property-hint">{asset.kind === 'video' ? '单击画布中的视频画面可播放或暂停。' : '双击画布中的媒体画面也可预览。'}</p></div>}
    <div className="property-section"><h3>布局</h3><div className="geometry-grid">{[['X', target.x], ['Y', target.y], ['W', target.width], ['H', target.height]].map(([name, value]) => <div key={name}><span>{name}</span><strong>{Math.round(Number(value))}</strong></div>)}</div>
      <p className="property-hint">{board ? '拖动标题或空白处移动整组，双击标题重命名。拖动边框或角点调整长宽，内容可单独拖动。' : selected.every(id => doc.items.find(i => i.id === id)?.type === 'note') ? '拖动边框或角点自由调整宽高，字号固定。' : '拖动角点等比调整尺寸。'}<br/>{board ? '调整板子尺寸不会缩放内容。' : '按住 Ctrl 可增减选中项。'}</p>
    </div>
    {board ? <div className="property-section"><label htmlFor="group-name">分组名称</label><input id="group-name" aria-label="分组名称" key={board.id + board.name} defaultValue={board.name} maxLength={groupNameLimit} disabled={!editable} onBlur={e => {
      const name = e.target.value.trim() || board.name, s = useCanvas.getState();
      s.commit({ ...s.doc, groups: s.doc.groups.map(g => g.id === board.id ? { ...g, name } : g) });
    }}/><p className="property-hint">{doc.items.filter(i => i.groupId === board.id).length} 个成员。删除分组板只解除归属，保留内容。</p><button className="wide-button" onClick={selectMembers}>选中组内元素</button></div> : selected.length === 1 && <div className="property-section">
      {current!.type === 'note' ? <p className="property-hint">双击卡片正文即可输入；单击选中，拖动可移动备注。</p> : <><label htmlFor="item-title">名称</label><input id="item-title" aria-label="卡片名称" key={current!.id + current!.title} defaultValue={current!.title} maxLength={200} disabled={!editable} onBlur={e => {
        const s = useCanvas.getState(); s.commit({ ...s.doc, items: s.doc.items.map(i => i.id === current!.id ? { ...i, title: e.target.value } : i) });
      }}/><p className="property-hint">也可双击卡片底部名称，直接在画布中修改。</p></>}
      <p className="property-hint">拖入分组板自动加入，拖出自动脱离；松手时以卡片中心判断。</p>
    </div>}
    <div className="property-section"><h3>组织</h3><button className="wide-button" disabled={!editable || selected.length < 2} onClick={() => useCanvas.getState().group()}><Group size={15}/>将选中项分组</button><button className="wide-button" disabled={!editable || !grouped} onClick={() => useCanvas.getState().ungroup()}><Ungroup size={15}/>解除分组</button></div>
  </>;
}
