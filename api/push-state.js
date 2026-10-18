/**
 * Entry push deduplication is event-based, not direction-based.
 * A new BUY or SELL event should be eligible even when the previous
 * delivered event had the same direction.
 */
export function shouldNotifyEntryEvent(previousEventKey, currentEventKey) {
  return Boolean(currentEventKey) && previousEventKey !== currentEventKey;
}
