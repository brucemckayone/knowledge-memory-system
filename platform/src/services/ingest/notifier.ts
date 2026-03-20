/**
 * Ingest Notifier (W34)
 *
 * Simple event emitter for ingest lifecycle hooks.
 * Adapters and downstream services can subscribe to events
 * like 'ingested', 'duplicate', 'error'.
 */

type IngestEvent = 'ingested' | 'duplicate' | 'error';
type IngestEventHandler = (data: Record<string, unknown>) => void;

class IngestNotifier {
  private listeners = new Map<IngestEvent, IngestEventHandler[]>();

  on(event: IngestEvent, handler: IngestEventHandler): void {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  off(event: IngestEvent, handler: IngestEventHandler): void {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter(h => h !== handler));
  }

  emit(event: IngestEvent, data: Record<string, unknown>): void {
    const handlers = this.listeners.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Ingest notifier error (${event}):`, error);
      }
    }
  }
}

export const ingestNotifier = new IngestNotifier();
