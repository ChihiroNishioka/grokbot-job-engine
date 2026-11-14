export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}
export type Unreachable = { ok: false; unreachable: true; reason: 'nc_not_found' | 'connect_failed' | 'timeout' };
export type TransportResult = { ok: true; status: number; body: string } | Unreachable;
export interface Transport { request(request: HttpRequest): Promise<TransportResult> }
