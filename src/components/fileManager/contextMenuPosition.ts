export type ContextMenuContainerBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function contextMenuPositionInContainer(
  clientX: number,
  clientY: number,
  bounds: ContextMenuContainerBounds,
) {
  return {
    x: clamp(clientX - bounds.left, 0, Math.max(0, bounds.width - 1)),
    y: clamp(clientY - bounds.top, 0, Math.max(0, bounds.height - 1)),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
