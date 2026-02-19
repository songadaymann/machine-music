export type EventListener = (event: string, data: unknown) => void;

export class EventBus {
  private listeners: Set<EventListener> = new Set();

  addListener(listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: EventListener): void {
    this.listeners.delete(listener);
  }

  publish(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  get count(): number {
    return this.listeners.size;
  }
}
