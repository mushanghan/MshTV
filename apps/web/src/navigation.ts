export const boardId = new URLSearchParams(location.search).get('board');
export const boardUrl = (id: string) => `/?board=${encodeURIComponent(id)}`;
export const isLanClient = location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export function scopedApiUrl(path: string) {
  if (!boardId || boardId === 'main' || !/^\/api\/v1\/(assets|library|media|exports|clipboard|events)(?:\/|\?|$)/.test(path)) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}boardId=${encodeURIComponent(boardId)}`;
}
