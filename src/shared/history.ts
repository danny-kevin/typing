/** History metadata only. File bytes never leave this machine. */
export type HistoryReason = 'save' | 'before-reload' | 'before-revert' | 'before-restore'
export interface HistoryConfig { enabled: boolean; maxCount: number; maxAgeDays: number; maxBytes: number }
export const DEFAULT_HISTORY: HistoryConfig = { enabled: true, maxCount: 100, maxAgeDays: 90, maxBytes: 200 * 1024 * 1024 }
export const HISTORY_MAX_FILE_BYTES = 5 * 1024 * 1024
export interface HistoryEntry { id: string; time: number; size: number; hash: string; reason: HistoryReason }
export interface HistoryListing {
  directory: string; config: HistoryConfig; disabled: boolean; snapshots: HistoryEntry[]
  usedBytes: number; overBudget: boolean; maxFileBytes: number; error?: string
}
