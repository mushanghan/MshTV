import { memo } from 'react';
import { Group, Rect, Text } from 'react-konva';
import type Konva from 'konva';
import type { CanvasGroup } from '../model';
import type { CanvasPalette } from '../theme';
import { SelectionLight, useSelectionLift } from './SelectionLight';
import { groupTitleBounds } from './groups';

interface Props {
  group: CanvasGroup; palette: CanvasPalette; largeCorners: boolean; selected: boolean; draggable: boolean; editing: boolean;
  performanceMode: boolean; animateSelection: boolean;
  register: (id: string, node: Konva.Group | null) => void;
  onDown: (id: string, event: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart: (id: string) => void; onDragMove: (id: string) => void; onDragEnd: (id: string) => void;
  onEdit: (id: string, field: 'name') => void;
}

export const GroupBoard = memo(function GroupBoard({ group, palette, largeCorners, selected, performanceMode, animateSelection, draggable, editing, register, onDown, onDragStart, onDragMove, onDragEnd, onEdit }: Props) {
  const floating = selected && !performanceMode;
  const radius = largeCorners ? 20 : 10;
  const groupRef = useSelectionLift(floating && !editing, animateSelection && !editing);
  const resize = (event: Konva.KonvaEventObject<Event>) => {
    const node = event.currentTarget as Konva.Group;
    const width = Math.max(80, node.width() * node.scaleX()), height = Math.max(80, node.height() * node.scaleY());
    const y = node.y() + node.offsetY() * (1 - node.scaleY());
    node.setAttrs({ width, height, y, scaleX: 1, scaleY: 1 });
    node.findOne<Konva.Rect>('.group-background')?.size({ width, height });
    node.findOne<Konva.Text>('.group-label')?.width(groupTitleBounds(width).width);
  };
  return <Group ref={node => { groupRef.current = node; register(group.id, node); }} x={group.x} y={group.y} width={group.width} height={group.height} draggable={draggable}
    onMouseDown={e => onDown(group.id, e)}
    onDragStart={() => onDragStart(group.id)} onDragMove={() => onDragMove(group.id)} onDragEnd={() => onDragEnd(group.id)} onTransform={resize}>
    {floating && <SelectionLight steady={editing} radius={radius} glow={palette.selectionGlow}/>}
    <Rect name="group-background" width={group.width} height={group.height} fill={palette.group} stroke={selected && performanceMode ? palette.selected : palette.groupBorder} strokeWidth={1} cornerRadius={radius}
      shadowEnabled={(palette.elevation && largeCorners) || floating} shadowForStrokeEnabled={false} shadowColor="#232730" shadowOpacity={.10}
      shadowBlur={floating ? 16 : 14} shadowOffsetY={floating ? 6 : 4}/>
    <Text name="group-label" {...groupTitleBounds(group.width)} text={group.name} fill={palette.groupTitle} fontSize={12} wrap="none" ellipsis visible={!editing}
      hitFunc={(context, shape) => {
        const label = shape as Konva.Text;
        context.beginPath();
        context.rect(0, 0, Math.min(label.width(), label.getTextWidth()), label.height());
        context.closePath();
        context.fillStrokeShape(label);
      }}
      onDblClick={event => {
        if (event.evt.button !== 0 || event.evt.ctrlKey || event.evt.metaKey) return;
        onEdit(group.id, 'name');
      }}/>
  </Group>;
});
