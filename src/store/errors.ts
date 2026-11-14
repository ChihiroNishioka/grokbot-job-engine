export class StoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'StoreError'; }
}
