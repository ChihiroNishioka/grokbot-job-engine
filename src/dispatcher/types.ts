export type WakePayload = { v: 1; event: 'jobs.available'; event_id: string };
export type WakeResult = { accepted: boolean; status?: number; event_id: string; error?: string };
export interface WakeDispatcher { wake(): Promise<WakeResult> }
