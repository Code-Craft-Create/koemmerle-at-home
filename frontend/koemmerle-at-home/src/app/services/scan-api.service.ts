import { Injectable, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Product {
  id: number;
  migrosId?: string;
  migrosOnlineId?: number;
  migrosUid?: number;
  migrosUrl: string;
  name: string;
  imageUrl?: string;
  imageData?: string;
  barcodes: string;
  weightText?: string;
  weightMinGrams?: number;
  weightMaxGrams?: number;
  weightUnit?: string;
  price?: number;
  multiplier: number;
  priceFetchedAt?: string;
  lastSyncedAt?: string;
  categories?: string;
  hasMapping: boolean;
  available: boolean;
  relevance: number;
  orderCount: number;
  lastOrderDate?: string;
  stickerPrintedAt?: string;
}

export interface RecipeItemDto {
  id: number;
  productId: number;
  productName: string;
  imageUrl?: string;
  imageData?: string;
  quantity: number;
  multiplier: number;
  migrosId?: string;
  migrosOnlineId?: number;
  migrosUid?: number;
}

export interface RecipeDto {
  id: number;
  barcode: string;
  name: string;
  imageData?: string;
  items: RecipeItemDto[];
}

export interface RecipeExportDocument {
  format: 'KoemmerleAtHomeRecipes';
  version: number;
  exportedAt: string;
  recipes: RecipeExportDto[];
}

export interface RecipeExportDto {
  barcode: string;
  name: string;
  imageData?: string;
  items: RecipeExportItemDto[];
}

export interface RecipeExportItemDto {
  quantity: number;
  product: {
    name: string;
    migrosId?: string;
    migrosOnlineId?: number;
    migrosUid?: number;
  };
}

export interface RecipeImportResult {
  imported: number;
  updated: number;
  skippedProducts: number;
  skipped: {
    recipeBarcode: string;
    productName: string;
    migrosId?: string;
    migrosOnlineId?: number;
    migrosUid?: number;
  }[];
}

/** @deprecated use RecipeDto */
export type MappingDto = RecipeDto;
/** @deprecated use RecipeItemDto */
export type MappingItemDto = RecipeItemDto;

export interface Order {
  id: number;
  migrosOrderId: string;
  detailPath?: string;
  dateText?: string;
  orderDate?: string;
  totalAmount?: number;
  status: 'HeaderFetched' | 'DetailFetched' | 'FullySynced';
  firstSeenAt: string;
  items: OrderItem[];
}

export interface OrderItem {
  id: number;
  orderId: number;
  productId?: number;
  product?: Product;
  migrosProductUrl: string;
  productNameAtOrder: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
}

export interface ScanQueueItem {
  id: number;
  barcode: string;
  productName: string;
  migrosUrl: string;
  quantity: number;
  multiplier: number;
  scannedAt: string;
  status: 'Pending' | 'Processing' | 'Done' | 'Failed' | 'UnknownBarcode';
  errorMessage?: string;
  productImageUrl?: string;
  productImageData?: string;
  recipeName?: string;
  recipeImageData?: string;
}

export interface BasketItem {
  uid: string;
  productName: string;
  imageUrl: string | null;
  quantity: number;
  multiplier: number;
  price: number | null;
  category: string;
  migrosProductUrl: string | null;
}

export interface BasketSwimlane {
  id: string;
  label: string;
  categories: string[];
}

export interface ScanChoice {
  migrosUid: number;
  name: string;
  imageUrl?: string;
  weightText?: string;
  price?: number;
  multiplier: number;
}

export interface ScanResult {
  barcode: string;
  recognized: boolean;
  productName?: string;
  imageUrl?: string;
  queueItemId?: number;
  quantity?: number;
  multiplier: number;
  itemCount?: number;
  allQueueItemIds?: number[];
  alternatives?: ScanChoice[];
  totalAlternatives?: number;
}

export interface OrderProductSyncProgress {
  orderId: number;
  done: number;
  total: number;
  currentProduct?: string;
  linkedProductUrl?: string;
}

export interface OrderStat {
  productId?: number;
  productName: string;
  imageUrl?: string;
  imageData?: string;
  categories?: string;
  multiplier: number;
  totalQuantity: number;
  totalWeightGrams?: number;
}

export interface ForecastItem {
  productId: number | null;
  productName: string;
  imageUrl: string | null;
  imageData?: string;
  categories: string | undefined;
  multiplier: number;
  totalOrders: number;
  avgQuantityPerOrder: number;
  avgIntervalDays: number | null;
  lastOrderDate: string;
  predictedNextDate: string | null;
  daysUntilNeeded: number | null;
  firstBarcode: string | null;
}

export interface MonthlyTotal {
  month: string;
  totalQuantity: number;
}

export interface ProductByBarcodeResult {
  type: 'found' | 'candidates' | 'unknown';
  products?: Product[];
  choices?: ScanChoice[];
}

export interface ScanAlternativesResult {
  choices: ScanChoice[];
  total: number;
}

export interface CartStatus {
  isPaused: boolean;
  isLoggedIn: boolean;
}

export interface MigrosSessionStatus {
  isLoggedIn: boolean;
  expiresAt: string | null;
  expiresInSec: number | null;
}

export interface AppVersion {
  version: string;
  commit?: string;
  displayVersion?: string;
  informationalVersion?: string;
  latestRelease?: LatestRelease | null;
}

export interface LatestRelease {
  version: string;
  tagName: string;
  name: string;
  htmlUrl: string;
  publishedAt?: string | null;
}

export interface AppSettings {
  autoUpdateOrders: boolean;
}

export interface StickerLayoutSettings {
  cols: number;
  rows: number;
  layout: 'horizontal' | 'vertical';
  padding: number;
  imageRatio: number;
  fontSize: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  showCutlines: boolean;
}

export interface StickerExportProduct {
  name: string;
  type: 'product' | 'recipe';
  migrosId?: string;
  migrosOnlineId?: number;
  migrosUid?: number;
  barcode?: string;
}

export interface StickerExportDto {
  id: number;
  exportedAt: string;
  productCount: number;
  layoutJson: string;
  productsJson: string;
}

@Injectable({ providedIn: 'root' })
export class ScanApiService {
  private readonly serverOrigin = window.location.port === '4200'
    ? 'http://localhost:5050'
    : window.location.origin;
  private readonly base = `${this.serverOrigin}/api`;
  private hub: signalR.HubConnection;
  private scanResult$ = new Subject<ScanResult>();
  private orderSyncProgress$ = new Subject<OrderProductSyncProgress>();
  private queueUpdated$ = new Subject<ScanQueueItem[]>();
  private migrosSessionUpdated$ = new Subject<MigrosSessionStatus>();

  constructor(private http: HttpClient, private zone: NgZone) {
    this.hub = new signalR.HubConnectionBuilder()
      .withUrl(`${this.serverOrigin}/hubs/scan`)
      .withAutomaticReconnect()
      .build();

    this.hub.on('ScanResult',              (r) => this.zone.run(() => this.scanResult$.next(r)));
    this.hub.on('OrderProductSyncProgress',(p) => this.zone.run(() => this.orderSyncProgress$.next(p)));
    this.hub.on('MigrosSessionUpdated', (s: MigrosSessionStatus) =>
      this.zone.run(() => this.migrosSessionUpdated$.next(s)));
    this.hub.on('QueueUpdated', (q: ScanQueueItem[]) => this.zone.run(() => {
      const noImage = q.filter(i => !i.productImageData && !i.recipeImageData);
      if (noImage.length > 0)
        console.warn('[QueueUpdated] items with no image:', noImage.map(i => ({ id: i.id, name: i.productName, productImageUrl: i.productImageUrl, status: i.status })));
      this.queueUpdated$.next(q);
    }));
    this.hub.start().catch(err => console.error('SignalR error:', err));
  }

  get scanResults$(): Observable<ScanResult> { return this.scanResult$.asObservable(); }
  get orderSyncProgress$Obs(): Observable<OrderProductSyncProgress> { return this.orderSyncProgress$.asObservable(); }
  get queueUpdated$Obs(): Observable<ScanQueueItem[]> { return this.queueUpdated$.asObservable(); }
  get migrosSessionUpdated$Obs(): Observable<MigrosSessionStatus> { return this.migrosSessionUpdated$.asObservable(); }

  getVersion(): Observable<AppVersion> {
    return this.http.get<AppVersion>(`${this.base}/version`);
  }

  // ── Products ───────────────────────────────────────────────────────────────
  getProducts(): Observable<Product[]> {
    return this.http.get<Product[]>(`${this.base}/products`);
  }
  getProduct(id: number): Observable<Product> {
    return this.http.get<Product>(`${this.base}/products/${id}`);
  }
  updateProduct(id: number, data: Partial<Pick<Product, 'name'|'barcodes'|'weightText'|'weightMinGrams'|'weightMaxGrams'|'weightUnit'|'price'|'categories'>>): Observable<Product> {
    return this.http.put<Product>(`${this.base}/products/${id}`, data);
  }
  syncProduct(id: number): Observable<Product> {
    return this.http.post<Product>(`${this.base}/products/${id}/sync`, {});
  }
  syncProductByUrl(migrosUrl: string): Observable<Product> {
    return this.http.post<Product>(`${this.base}/products/sync-url`, { migrosUrl });
  }
  syncThumbnails(): Observable<{ synced: number; failed: number; cancelled: boolean }> {
    return this.http.post<{ synced: number; failed: number; cancelled: boolean }>(`${this.base}/products/sync-thumbnails`, {});
  }
  deleteProduct(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/products/${id}`);
  }
  markStickerPrinted(ids: number[]): Observable<void> {
    return this.http.post<void>(`${this.base}/products/sticker-printed`, ids);
  }
  clearStickerPrinted(): Observable<void> {
    return this.http.delete<void>(`${this.base}/products/sticker-printed`);
  }

  // ── Sticker layout settings ────────────────────────────────────────────────
  getStickerLayout(): Observable<StickerLayoutSettings | null> {
    return this.http.get<{ value: string | null }>(`${this.base}/settings/json/StickerLayout`).pipe(
      map(r => r.value ? JSON.parse(r.value) as StickerLayoutSettings : null)
    );
  }
  setStickerLayout(layout: StickerLayoutSettings): Observable<void> {
    return this.http.put<void>(`${this.base}/settings/json/StickerLayout`, { value: JSON.stringify(layout) });
  }

  // ── Sticker exports ────────────────────────────────────────────────────────
  getStickerExports(): Observable<StickerExportDto[]> {
    return this.http.get<StickerExportDto[]>(`${this.base}/sticker-exports`);
  }
  createStickerExport(req: { layoutJson: string; productsJson: string }): Observable<StickerExportDto> {
    return this.http.post<StickerExportDto>(`${this.base}/sticker-exports`, req);
  }
  deleteStickerExport(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/sticker-exports/${id}`);
  }

  // ── Recipes ────────────────────────────────────────────────────────────────
  getRecipes(): Observable<RecipeDto[]> {
    return this.http.get<RecipeDto[]>(`${this.base}/recipes`);
  }
  getRecipe(id: number): Observable<RecipeDto> {
    return this.http.get<RecipeDto>(`${this.base}/recipes/${id}`);
  }
  createRecipe(barcode: string, name: string): Observable<RecipeDto> {
    return this.http.post<RecipeDto>(`${this.base}/recipes`, { barcode, name });
  }
  updateRecipe(id: number, barcode: string, name: string): Observable<void> {
    return this.http.put<void>(`${this.base}/recipes/${id}`, { barcode, name });
  }
  deleteRecipe(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/recipes/${id}`);
  }
  deleteRecipes(ids: number[]): Observable<void> {
    return this.http.delete<void>(`${this.base}/recipes`, { body: { ids } });
  }
  exportRecipes(ids: number[]): Observable<RecipeExportDocument> {
    return this.http.post<RecipeExportDocument>(`${this.base}/recipes/export`, { ids });
  }
  importRecipes(document: RecipeExportDocument): Observable<RecipeImportResult> {
    return this.http.post<RecipeImportResult>(`${this.base}/recipes/import`, document);
  }
  setRecipeImage(recipeId: number, imageData: string | null): Observable<{ imageData: string | null }> {
    return this.http.put<{ imageData: string | null }>(`${this.base}/recipes/${recipeId}/image`, { imageData });
  }
  addRecipeItem(recipeId: number, productId: number, quantity = 1): Observable<RecipeItemDto> {
    return this.http.post<RecipeItemDto>(`${this.base}/recipes/${recipeId}/items`, { productId, quantity });
  }
  updateRecipeItem(recipeId: number, itemId: number, quantity: number): Observable<RecipeItemDto> {
    return this.http.put<RecipeItemDto>(`${this.base}/recipes/${recipeId}/items/${itemId}`, { quantity });
  }
  removeRecipeItem(recipeId: number, itemId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/recipes/${recipeId}/items/${itemId}`);
  }

  getProductByBarcode(barcode: string): Observable<ProductByBarcodeResult> {
    return this.http.get<ProductByBarcodeResult>(`${this.base}/products/by-barcode`, { params: { barcode } });
  }
  getProductByUid(uid: number): Observable<Product> {
    return this.http.get<Product>(`${this.base}/products/by-uid`, { params: { uid } });
  }

  // ── Statistics ────────────────────────────────────────────────────────────
  getProductOrderUsage(): Observable<OrderStat[]> {
    return this.http.get<OrderStat[]>(`${this.base}/statistics/orders`);
  }
  getOrderStats(from: string, to: string): Observable<OrderStat[]> {
    return this.http.get<OrderStat[]>(`${this.base}/statistics/orders`, {
      params: { from, to }
    });
  }
  getStatisticsDebug(from: string, to: string): Observable<any> {
    return this.http.get<any>(`${this.base}/statistics/debug`, {
      params: { from, to }
    });
  }

  getForecast(): Observable<ForecastItem[]> {
    return this.http.get<ForecastItem[]>(`${this.base}/statistics/forecast`);
  }

  enqueueForecast(barcodes: string[]): Observable<{ enqueued: number; skipped: number }> {
    return this.http.post<{ enqueued: number; skipped: number }>(
      `${this.base}/statistics/forecast/enqueue`, { barcodes });
  }

  getMonthlyTotals(period: 'month' | 'biweekly' = 'month'): Observable<MonthlyTotal[]> {
    return this.http.get<MonthlyTotal[]>(`${this.base}/statistics/monthly`, { params: { period } });
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  getOrders(): Observable<Order[]> {
    return this.http.get<Order[]>(`${this.base}/orders`);
  }
  getOrder(id: number): Observable<Order> {
    return this.http.get<Order>(`${this.base}/orders/${id}`);
  }
  syncOrderHeaders(): Observable<{ synced: number }> {
    return this.http.post<{ synced: number }>(`${this.base}/orders/sync-headers`, {});
  }
  syncOrderDetail(id: number): Observable<void> {
    return this.http.post<void>(`${this.base}/orders/${id}/sync-detail`, {});
  }
  syncOrderProducts(id: number): Observable<void> {
    return this.http.post<void>(`${this.base}/orders/${id}/sync-products`, {});
  }
  cancelProductSync(): Observable<void> {
    return this.http.post<void>(`${this.base}/orders/cancel-product-sync`, {});
  }

  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${this.base}/settings`);
  }
  setAutoUpdateOrders(autoUpdateOrders: boolean): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${this.base}/settings/auto-update-orders`, { autoUpdateOrders });
  }

  // ── Scan / Cart ────────────────────────────────────────────────────────────
  getCartQuantity(barcode: string, migrosId?: number): Observable<{ currentQuantity: number }> {
    const params: Record<string, string> = { barcode };
    if (migrosId != null) params['migrosId'] = String(migrosId);
    return this.http.get<{ currentQuantity: number }>(`${this.base}/cart/quantity`, { params });
  }

  scan(barcode: string): Observable<ScanResult> {
    const connectionId = this.hub?.connectionId ?? '';
    return this.http.post<ScanResult>(`${this.base}/scan`, { barcode }, {
      headers: { 'X-SignalR-Connection-Id': connectionId }
    });
  }
  getScanAlternatives(barcode: string, offset: number, limit = 50): Observable<ScanAlternativesResult> {
    return this.http.get<ScanAlternativesResult>(`${this.base}/scan/alternatives`, {
      params: { barcode, offset, limit }
    });
  }
  enqueue(barcode: string, quantity: number, migrosUid?: number): Observable<number[]> {
    return this.http.post<number[]>(`${this.base}/scan/enqueue`, { barcode, quantity, migrosUid });
  }
  getQueue(): Observable<ScanQueueItem[]> {
    return this.http.get<ScanQueueItem[]>(`${this.base}/cart/queue`);
  }
  getBasket(): Observable<BasketItem[]> {
    return this.http.get<BasketItem[]>(`${this.base}/cart/basket`);
  }
  getBasketSwimlanes(): Observable<BasketSwimlane[]> {
    return this.http.get<BasketSwimlane[]>(`${this.base}/cart/basket/swimlanes`);
  }
  saveBasketSwimlanes(swimlanes: BasketSwimlane[]): Observable<BasketSwimlane[]> {
    return this.http.put<BasketSwimlane[]>(`${this.base}/cart/basket/swimlanes`, swimlanes);
  }
  resetBasketSwimlanes(): Observable<BasketSwimlane[]> {
    return this.http.delete<BasketSwimlane[]>(`${this.base}/cart/basket/swimlanes`);
  }
  setBasketQuantity(uid: string, quantity: number): Observable<void> {
    return this.http.put<void>(`${this.base}/cart/basket/quantity`, { uid, quantity });
  }
  getCartStatus(): Observable<CartStatus> {
    return this.http.get<CartStatus>(`${this.base}/cart/status`);
  }
  pauseCart(): Observable<void> {
    return this.http.post<void>(`${this.base}/cart/pause`, {});
  }
  resumeCart(): Observable<void> {
    return this.http.post<void>(`${this.base}/cart/resume`, {});
  }
  deleteQueueItem(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/cart/queue/${id}`);
  }
  retryQueueItem(id: number): Observable<void> {
    return this.http.post<void>(`${this.base}/cart/queue/${id}/retry`, {});
  }
  clearCompletedQueue(): Observable<void> {
    return this.http.delete<void>(`${this.base}/cart/queue/completed`);
  }
  clearAllQueue(): Observable<void> {
    return this.http.delete<void>(`${this.base}/cart/queue/all`);
  }

  getMigrosSession(): Observable<MigrosSessionStatus> {
    return this.http.get<MigrosSessionStatus>(`${this.base}/auth/migros-session`);
  }
  startMigrosLogin(): Observable<{ message: string }> {
    return this.http.post<any>(`${this.base}/auth/migros-login`, {});
  }
  setMigrosToken(accessToken: string): Observable<{ expiresAt: string }> {
    return this.http.post<any>(`${this.base}/auth/migros-token`, { accessToken });
  }

  // ── DATA MANAGEMENT ──────────────────────────────────────────────────────

  deleteAllProducts(): Observable<void> {
    return this.http.delete<void>(`${this.base}/products/all`);
  }

  deleteAllOrders(): Observable<void> {
    return this.http.delete<void>(`${this.base}/orders/all`);
  }

  deleteAllRecipes(): Observable<void> {
    return this.http.delete<void>(`${this.base}/recipes/all`);
  }
}
