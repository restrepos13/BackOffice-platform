// Node 22+ trae un localStorage experimental que tapa el de jsdom (y sin archivo no
// funciona): en las pruebas se usa uno en memoria, igual en window y en global.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, String(v)); }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
if (typeof window !== 'undefined') Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
