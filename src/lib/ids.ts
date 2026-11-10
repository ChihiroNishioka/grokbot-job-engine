import { randomBytes, randomUUID } from 'node:crypto';

export function randomToken(): string { return randomBytes(32).toString('base64url'); }
export function randomId(): string { return randomUUID(); }
