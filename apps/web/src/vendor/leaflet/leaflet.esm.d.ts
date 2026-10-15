/**
 * Tipos mínimos de Leaflet 1.9.4 (vendorizado en este directorio, licencia
 * BSD-2 en LICENSE). Solo lo que usa components/LiveMap.tsx.
 */
export interface LatLngLiteral {
  lat: number;
  lng: number;
}
export type LatLngTuple = [number, number];

export interface LeafletLayer {
  addTo(map: LeafletMap): this;
  remove(): this;
}
export interface LeafletMarker extends LeafletLayer {
  setLatLng(latlng: LatLngLiteral | LatLngTuple): this;
  setIcon(icon: unknown): this;
  setZIndexOffset(offset: number): this;
  bindTooltip(content: string, options?: Record<string, unknown>): this;
  setTooltipContent(content: string): this;
  on(event: string, fn: (...args: any[]) => void): this;
}
export interface LeafletPolyline extends LeafletLayer {
  setLatLngs(latlngs: Array<LatLngLiteral | LatLngTuple>): this;
}
export interface LeafletMap {
  setView(center: LatLngLiteral | LatLngTuple, zoom: number, options?: Record<string, unknown>): this;
  fitBounds(bounds: unknown, options?: Record<string, unknown>): this;
  invalidateSize(): this;
  remove(): this;
  getZoom(): number;
  on(event: string, fn: (...args: any[]) => void): this;
}

export function map(element: HTMLElement, options?: Record<string, unknown>): LeafletMap;
export function tileLayer(url: string, options?: Record<string, unknown>): LeafletLayer;
export function marker(latlng: LatLngLiteral | LatLngTuple, options?: Record<string, unknown>): LeafletMarker;
export function divIcon(options: Record<string, unknown>): unknown;
export function polyline(latlngs: Array<LatLngLiteral | LatLngTuple>, options?: Record<string, unknown>): LeafletPolyline;
export function latLngBounds(latlngs: Array<LatLngLiteral | LatLngTuple>): unknown;
