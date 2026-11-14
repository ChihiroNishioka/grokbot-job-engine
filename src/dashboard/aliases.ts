import { createHmac } from 'node:crypto';

export type RequesterId = 'self' | 'member';
export type AliasResolver = (requesterId: RequesterId, senderHandle: string | null) => string;

export function createAliasResolver(input: {
  key: string;
  aliases: Record<string, string>;
  handles: readonly string[];
}): AliasResolver {
  const hashes = [...new Set(input.handles)].map(handle => [
    handle,
    createHmac('sha256', input.key).update(handle, 'utf8').digest('hex'),
  ] as const);
  const allHashes = hashes.map(([, hash]) => hash);
  const byHandle = new Map<string, string>();
  for (const [handle, hash] of hashes) {
    const configured = input.aliases[hash];
    if (configured !== undefined) {
      byHandle.set(handle, configured);
      continue;
    }
    let length = 6;
    while (length < 64 && allHashes.some(other => other !== hash && other.slice(0, length) === hash.slice(0, length))) length += 1;
    byHandle.set(handle, `家族-${hash.slice(0, length)}`);
  }
  return (requesterId, senderHandle) => {
    if (requesterId === 'self') return '本人';
    if (senderHandle === null) return '家族（識別なし）';
    const known = byHandle.get(senderHandle);
    if (known !== undefined) return known;
    const hash = createHmac('sha256', input.key).update(senderHandle, 'utf8').digest('hex');
    return input.aliases[hash] ?? `家族-${hash.slice(0, 6)}`;
  };
}
