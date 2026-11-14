export function redactHandle(text: string, handle: string | null): string {
  if (handle === null) return text;
  const values = [handle, handle.slice(handle.indexOf(':') + 1)];
  const pattern = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
}
