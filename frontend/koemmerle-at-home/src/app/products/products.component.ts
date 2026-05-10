import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { ScanApiService, Product } from '../services/scan-api.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

const FUSE_OPTIONS: IFuseOptions<Product> = {
  keys: ['name', 'barcodes'],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

@Component({
  selector: 'app-products',
  imports: [CommonModule, FormsModule, RouterModule, CategoryFilterComponent],
  templateUrl: './products.component.html',
  styleUrl: './products.component.scss'
})
export class ProductsComponent implements OnInit, OnDestroy {
  products: Product[] = [];
  private fuse = new Fuse<Product>([], FUSE_OPTIONS);
  syncingIds = new Set<number>();
  message = '';

  searchRaw = '';        // bound to the input — updates immediately
  textFilter = '';       // debounced — what Fuse actually runs on
  categoryFilter = '';
  sortCol: 'name' | 'lastSyncedAt' | 'relevance' = 'relevance';
  sortDir: 1 | -1 = -1;
  pageSize = 100;
  page = 0;
  readonly pageSizes = [20, 50, 100, 200, 500];

  private searchSubject = new Subject<string>();
  private searchSub!: Subscription;

  // memoization
  private _filteredKey = '';
  private _filteredCache: Product[] = [];

  setSort(col: 'name' | 'lastSyncedAt' | 'relevance') {
    if (this.sortCol === col) this.sortDir = this.sortDir === 1 ? -1 : 1;
    else { this.sortCol = col; this.sortDir = col === 'lastSyncedAt' ? -1 : 1; }
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
      result = list.sort((a, b) => {
        if (this.sortCol === 'name') return a.name.localeCompare(b.name) * this.sortDir;
        if (this.sortCol === 'relevance') return this.compareRelevanceDesc(a, b) * -this.sortDir;
        const da = a.lastSyncedAt ? new Date(a.lastSyncedAt).getTime() : 0;
        const db2 = b.lastSyncedAt ? new Date(b.lastSyncedAt).getTime() : 0;
        return (da - db2) * this.sortDir;
      });
    }
    this._filteredCache = result;
    return result;
  }

  get pageCount(): number { return Math.ceil(this.filtered.length / this.pageSize); }
  get paginated(): Product[] { return this.filtered.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize); }
  get pageStart(): number { return this.filtered.length ? this.page * this.pageSize + 1 : 0; }
  get pageEnd(): number { return Math.min((this.page + 1) * this.pageSize, this.filtered.length); }

  readonly pieR = 9;
  readonly pieC = 2 * Math.PI * this.pieR;

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

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.searchSub = this.searchSubject.pipe(debounceTime(150)).subscribe(v => {
      this.textFilter = v;
      this.page = 0;
    });
    this.load();
  }

  ngOnDestroy() { this.searchSub.unsubscribe(); }

  load() {
    this.api.getProducts().subscribe(p => {
      this.products = p;
      this.fuse = new Fuse(p, FUSE_OPTIONS);
      this._filteredKey = '';
    });
  }

  sync(p: Product) {
    this.syncingIds.add(p.id);
    this.api.syncProduct(p.id).subscribe({
      next: updated => {
        const idx = this.products.findIndex(x => x.id === p.id);
        if (idx >= 0) this.products[idx] = { ...this.products[idx], ...updated };
        this.syncingIds.delete(p.id);
        this.message = `"${p.name}" aktualisiert`;
      },
      error: () => { this.syncingIds.delete(p.id); this.message = 'Sync fehlgeschlagen'; }
    });
  }

  delete(p: Product) {
    if (!confirm(`Produkt "${p.name}" löschen?`)) return;
    this.api.deleteProduct(p.id).subscribe(() => {
      this.products = this.products.filter(x => x.id !== p.id);
    });
  }

  formatWeight(p: Product): string {
    if (!p.weightText) return '–';
    return p.weightText;
  }
}
