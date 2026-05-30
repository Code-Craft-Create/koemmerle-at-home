import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { BasketItem, Product, ScanApiService } from '../services/scan-api.service';
import { OrderImportPhase, OrderImportService } from '../services/order-import.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

const FUSE_OPTIONS: IFuseOptions<Product> = {
  keys: ['name', 'barcodes'],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

@Component({
  selector: 'app-promotions',
  imports: [CommonModule, FormsModule, RouterModule, CategoryFilterComponent],
  templateUrl: './promotions.component.html',
  styleUrl: './promotions.component.scss'
})
export class PromotionsComponent implements OnInit, OnDestroy {
  products: Product[] = [];
  private fuse = new Fuse<Product>([], FUSE_OPTIONS);
  basketByUid = new Map<string, BasketItem>();
  basketBusyIds = new Set<number>();
  syncBusy = false;
  syncAll = false;
  syncAllPhase: OrderImportPhase = null;
  syncAllCurrent = 0;
  syncAllTotal = 0;
  syncAllAvailabilityTotal = 0;
  message = '';

  searchRaw = '';
  textFilter = '';
  categoryFilter = '';
  sortCol: 'name' | 'relevance' | 'lastOrderDate' = 'relevance';
  sortDir: 1 | -1 = -1;
  pageSize = 100;
  page = 0;
  readonly pageSizes = [20, 50, 100, 200, 500];

  private searchSubject = new Subject<string>();
  private searchSub!: Subscription;
  private importSub?: Subscription;
  private importDoneSub?: Subscription;
  private _filteredKey = '';
  private _filteredCache: Product[] = [];

  readonly pieR = 9;
  readonly pieC = 2 * Math.PI * this.pieR;

  constructor(
    private api: ScanApiService,
    private orderImport: OrderImportService
  ) {}

  ngOnInit() {
    this.searchSub = this.searchSubject.pipe(debounceTime(150)).subscribe(v => {
      this.textFilter = v;
      this.page = 0;
    });
    this.load();
    this.loadBasket();
    this.importSub = this.orderImport.state$.subscribe(s => {
      this.syncAll = s.active;
      this.syncAllPhase = s.phase;
      this.syncAllCurrent = s.current;
      this.syncAllTotal = s.total;
      if (s.phase === 'availability' && s.total > 0) this.syncAllAvailabilityTotal = s.total;
      if (s.phase !== 'availability') this.syncAllAvailabilityTotal = 0;
      if (s.message) this.message = s.message;
    });
    this.importDoneSub = this.orderImport.completed$.subscribe(count => {
      if (count > 0) this.load();
    });
  }

  ngOnDestroy() {
    this.searchSub.unsubscribe();
    this.importSub?.unsubscribe();
    this.importDoneSub?.unsubscribe();
  }

  setSort(col: 'name' | 'relevance' | 'lastOrderDate') {
    if (this.sortCol === col) this.sortDir = this.sortDir === 1 ? -1 : 1;
    else {
      this.sortCol = col;
      this.sortDir = col === 'name' ? 1 : -1;
    }
    this.page = 0;
  }

  setPageSize(size: number) { this.pageSize = size; this.page = 0; }

  onTextInput(val: string) {
    this.searchRaw = val;
    this.searchSubject.next(val);
  }

  onFilterChange() { this.page = 0; }

  resetSearch() {
    this.searchRaw = '';
    this.textFilter = '';
    this.categoryFilter = '';
    this.page = 0;
  }

  get filtered(): Product[] {
    const key = `${this.textFilter}|${this.categoryFilter}|${this.sortCol}|${this.sortDir}`;
    if (key === this._filteredKey) return this._filteredCache;
    this._filteredKey = key;

    const text = this.textFilter.trim();
    let result: Product[];
    if (text) {
      result = this.fuse.search(text)
        .filter(r => matchesCategory(r.item.categories, this.categoryFilter))
        .sort((a, b) =>
          this.directProductMatchRank(b.item, text) - this.directProductMatchRank(a.item, text)
          || Math.floor((a.score ?? 1) * 5) - Math.floor((b.score ?? 1) * 5)
          || this.compareRelevanceDesc(a.item, b.item))
        .map(r => r.item);
    } else {
      const list = this.products.filter(p => matchesCategory(p.categories, this.categoryFilter));
      result = list.sort((a, b) => this.compareBySort(a, b));
    }

    this._filteredCache = result;
    return result;
  }

  get pageCount(): number { return Math.ceil(this.filtered.length / this.pageSize); }
  get paginated(): Product[] { return this.filtered.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize); }
  get pageStart(): number { return this.filtered.length ? this.page * this.pageSize + 1 : 0; }
  get pageEnd(): number { return Math.min((this.page + 1) * this.pageSize, this.filtered.length); }

  load() {
    this.api.getPromotions().subscribe({
      next: p => {
        this.products = p;
        this.fuse = new Fuse(p, FUSE_OPTIONS);
        this._filteredKey = '';
      },
      error: () => this.message = 'Aktionen konnten nicht geladen werden'
    });
  }

  syncPromotions() {
    this.syncBusy = true;
    this.api.syncPromotions().subscribe({
      next: result => {
        this.syncBusy = false;
        this.message = result.alreadyRunning
          ? 'Aktions-Sync läuft bereits'
          : `${result.promotionsStored} Aktionen aktualisiert`;
        this.load();
      },
      error: () => {
        this.syncBusy = false;
        this.message = 'Aktions-Sync fehlgeschlagen';
      }
    });
  }

  syncAllMigros() {
    this.orderImport.start();
  }

  stopSyncAll() {
    this.orderImport.cancel();
  }

  syncAllAvailabilityLabel(): string {
    const total = this.syncAllTotal > 0 ? this.syncAllTotal : this.syncAllAvailabilityTotal;
    return total > 0
      ? `Verfügbarkeit ${this.syncAllCurrent}/${total}`
      : 'Verfügbarkeit prüfen…';
  }

  formatWeight(p: Product): string {
    return p.weightText || '–';
  }

  formatLastOrder(p: Product): string {
    if (!p.lastOrderDate) return '–';
    const d = new Date(p.lastOrderDate);
    if (isNaN(d.getTime())) return '–';
    return d.toLocaleDateString('de-CH', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  relevanceDash(r: number): string {
    const filled = (Math.min(Math.max(r, 0), 10) / 10) * this.pieC;
    return `${filled} ${this.pieC}`;
  }

  relevanceColor(r: number): string {
    const t = Math.min(Math.max(r, 0), 10) / 10;
    const red   = Math.round(249 + (22  - 249) * t);
    const green = Math.round(115 + (163 - 115) * t);
    const blue  = Math.round(22  + (74  - 22)  * t);
    return `rgb(${red},${green},${blue})`;
  }

  basketQuantity(p: Product): number {
    if (p.migrosUid == null) return 0;
    return this.basketByUid.get(String(p.migrosUid))?.quantity ?? 0;
  }

  canBasket(p: Product): boolean {
    return p.migrosUid != null;
  }

  addToBasket(p: Product) {
    this.changeBasket(p, this.basketQuantity(p) + 1);
  }

  removeFromBasket(p: Product) {
    const current = this.basketQuantity(p);
    if (current <= 0) return;
    this.changeBasket(p, current - 1);
  }

  private loadBasket() {
    this.api.getBasket().subscribe({
      next: items => { this.basketByUid = new Map(items.map(i => [i.uid, i])); },
      error: () => { /* not logged in or offline */ }
    });
  }

  private changeBasket(p: Product, next: number) {
    if (p.migrosUid == null) return;
    const uid = String(p.migrosUid);
    const previous = this.basketQuantity(p);
    this.basketBusyIds.add(p.id);
    this.applyBasketQuantity(p, uid, next);
    this.api.setBasketQuantity(uid, next).subscribe({
      next: () => { this.basketBusyIds.delete(p.id); },
      error: () => {
        this.applyBasketQuantity(p, uid, previous);
        this.basketBusyIds.delete(p.id);
        this.message = 'Warenkorb-Update fehlgeschlagen';
      }
    });
  }

  private applyBasketQuantity(p: Product, uid: string, quantity: number) {
    if (quantity <= 0) {
      this.basketByUid.delete(uid);
      return;
    }
    const existing = this.basketByUid.get(uid);
    if (existing) {
      existing.quantity = quantity;
    } else {
      this.basketByUid.set(uid, {
        uid,
        productName: p.name,
        imageUrl: p.imageUrl ?? null,
        quantity,
        multiplier: p.multiplier,
        weightText: p.weightText ?? null,
        price: p.price ?? null,
        promotionPrice: p.promotionPrice ?? null,
        promotionBadgeDescription: p.promotionBadgeDescription ?? null,
        available: p.available ?? true,
        category: p.categories ?? '',
        migrosProductUrl: p.migrosUrl
      });
    }
  }

  private compareBySort(a: Product, b: Product): number {
    if (this.sortCol === 'name') return a.name.localeCompare(b.name) * this.sortDir;
    if (this.sortCol === 'lastOrderDate') {
      const oa = a.lastOrderDate ? new Date(a.lastOrderDate).getTime() : 0;
      const ob = b.lastOrderDate ? new Date(b.lastOrderDate).getTime() : 0;
      return (oa - ob) * this.sortDir || this.compareRelevanceDesc(a, b);
    }
    return this.compareRelevanceDesc(a, b) * -this.sortDir;
  }

  private compareRelevanceDesc(a: Product, b: Product): number {
    return b.relevance - a.relevance || b.orderCount - a.orderCount;
  }

  private directProductMatchRank(product: Product, query: string): number {
    const q = this.normalizedSearchText(query);
    if (!q) return 0;
    return this.normalizedSearchText(`${product.name} ${product.barcodes}`).includes(q) ? 1 : 0;
  }

  private normalizedSearchText(value: string): string {
    return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
}
