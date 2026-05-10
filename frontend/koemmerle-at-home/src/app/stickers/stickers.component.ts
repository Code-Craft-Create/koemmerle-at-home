import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { ScanApiService, Product, RecipeDto, ScanChoice } from '../services/scan-api.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

export interface StickerItem {
  key: string;
  type: 'product' | 'recipe';
  id: number;
  name: string;
  imageUrl?: string;
  imageData?: string;
  barcode: string;
  categories?: string;
  available: boolean;
  relevance: number;
  orderCount: number;
  multiplier: number;
  migrosUid?: number;
  source: 'local' | 'migros';
}

const FUSE_OPTIONS: IFuseOptions<StickerItem> = {
  keys: ['name', 'barcode'],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

@Component({
  selector: 'app-stickers',
  imports: [CommonModule, FormsModule, CategoryFilterComponent],
  templateUrl: './stickers.component.html',
  styleUrl: './stickers.component.scss'
})
export class StickersComponent implements OnInit, OnDestroy {
  allItems: StickerItem[] = [];
  migrosItems: StickerItem[] = [];
  private fuse = new Fuse<StickerItem>([], FUSE_OPTIONS);
  selectedKeys: string[] = [];   // ordered list for sheet layout
  barcodeUrls = new Map<string, string>();
  syncingMigrosKeys = new Set<string>();

  searchRaw = '';        // bound to the input — updates immediately
  textFilter = '';       // debounced — what Fuse actually runs on
  categoryFilter = '';
  showUnavailable = false;

  private searchSubject = new Subject<string>();
  private searchSub!: Subscription;

  // memoization
  private _filteredKey = '';
  private _filteredCache: StickerItem[] = [];

  readonly pageSizes = [20, 30, 50, 100, 200, 500];
  pageSize = 30;
  currentPage = 0;

  readonly pieR = 9;
  readonly pieC = 2 * Math.PI * this.pieR;

  cols = 3;
  rows = 5;
  layout: 'horizontal' | 'vertical' = 'vertical';
  padding = 4.5;
  imageRatio = 55;
  fontSize = 13;
  marginTop = 8;
  marginRight = 8;
  marginBottom = 8;
  marginLeft = 8;
  showCutlines = true;

  generatingPdf = false;
  private readonly pdfImageCache = new Map<string, string>();

  constructor(private api: ScanApiService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    this.searchSub = this.searchSubject.pipe(debounceTime(150)).subscribe(v => {
      this.textFilter = v;
      this.currentPage = 0;
      this.searchMigros(v);
    });
    this.load();
  }

  ngOnDestroy() { this.searchSub.unsubscribe(); }

  onTextInput(val: string) {
    this.searchRaw = val;
    this.searchSubject.next(val);
  }

  resetSearch() {
    this.searchRaw = '';
    this.textFilter = '';
    this.categoryFilter = '';
    this.currentPage = 0;
  }

  load() {
    forkJoin([
      this.api.getProducts(),
      this.api.getRecipes(),
    ]).subscribe(([products, recipes]) => {
      const productItems: StickerItem[] = products
        .map(p => ({
          key: `p-${p.id}`,
          type: 'product' as const,
          id: p.id,
          name: p.name,
          imageUrl: p.imageUrl,
          imageData: p.imageData,
          barcode: p.barcodes.split(',')[0].trim(),
          categories: p.categories,
          available: p.available ?? true,
          relevance: p.relevance,
          orderCount: p.orderCount,
          multiplier: p.multiplier ?? 1,
          migrosUid: p.migrosUid,
          source: 'local' as const,
        }))
        .filter(p => p.barcode);

      const recipeItems: StickerItem[] = recipes
        .map(r => ({
          key: `r-${r.id}`,
          type: 'recipe' as const,
          id: r.id,
          name: r.name,
          imageUrl: r.imageData ?? r.items[0]?.imageUrl,
          barcode: r.barcode,
          categories: undefined,
          available: true,
          relevance: 0,
          orderCount: 0,
          multiplier: 1,
          source: 'local' as const,
        }))
        .filter(r => r.barcode);

      this.allItems = [...productItems, ...recipeItems].sort((a, b) => {
        if (a.type === 'recipe' && b.type !== 'recipe') return -1;
        if (b.type === 'recipe' && a.type !== 'recipe') return 1;
        return this.compareRelevanceDesc(a, b);
      });
      this.fuse = new Fuse(this.allItems, FUSE_OPTIONS);
      this.migrosItems = [];
      this._filteredKey = '';
      this.generateBarcodeUrls();
    });
  }

  private async generateBarcodeUrls() {
    const { default: JsBarcode } = await import('jsbarcode');
    for (const item of this.allItems) {
      if (this.barcodeUrls.has(item.barcode)) continue;
      const canvas = document.createElement('canvas');
      try {
        JsBarcode(canvas, item.barcode, {
          format: this.detectFormat(item.barcode),
          margin: 4, height: 50, width: 1.5, displayValue: false,
        });
        this.barcodeUrls.set(item.barcode, canvas.toDataURL('image/png'));
      } catch { /* invalid barcode string */ }
    }
    this.cdr.detectChanges();
  }

  hideOnError(event: Event) {
    (event.target as HTMLElement).style.display = 'none';
  }

  private detectFormat(_barcode: string): string {
    return 'CODE128';
  }

  // ── Filtering & Pagination ─────────────────────────────────────────────────

  get filteredItems(): StickerItem[] {
    const key = `${this.textFilter}|${this.categoryFilter}|${this.showUnavailable}|${this.migrosItems.map(i => i.key).join(',')}`;
    if (key === this._filteredKey) return this._filteredCache;
    this._filteredKey = key;

    const text = this.textFilter.trim();
    let result: StickerItem[];
    if (text) {
      result = this.fuse.search(text)
        .filter(r => {
          const item = r.item;
          if (!this.showUnavailable && item.type === 'product' && !item.available) return false;
          return matchesCategory(item.categories, this.categoryFilter);
        })
        .sort((a, b) => {
          const directRank = this.directItemMatchRank(b.item, text) - this.directItemMatchRank(a.item, text);
          if (directRank) return directRank;
          if (a.item.type === 'recipe' && b.item.type !== 'recipe') return -1;
          if (b.item.type === 'recipe' && a.item.type !== 'recipe') return 1;
          return Math.floor((a.score ?? 1) * 5) - Math.floor((b.score ?? 1) * 5)
            || this.compareRelevanceDesc(a.item, b.item);
        })
        .map(r => r.item);

      const remoteMatches = this.migrosItems.filter(item =>
        matchesCategory(item.categories, this.categoryFilter) &&
        !this.allItems.some(local => local.migrosUid != null && local.migrosUid === item.migrosUid));
      result = [...result, ...remoteMatches]
        .sort((a, b) => {
          const directRank = this.directItemMatchRank(b, text) - this.directItemMatchRank(a, text);
          if (directRank) return directRank;
          if (a.type === 'recipe' && b.type !== 'recipe') return -1;
          if (b.type === 'recipe' && a.type !== 'recipe') return 1;
          return this.compareRelevanceDesc(a, b);
        });
    } else {
      result = this.allItems.filter(item => {
        if (!this.showUnavailable && item.type === 'product' && !item.available) return false;
        return matchesCategory(item.categories, this.categoryFilter);
      });
    }
    this._filteredCache = result;
    return result;
  }

  get totalPages(): number { return Math.max(1, Math.ceil(this.filteredItems.length / this.pageSize)); }
  get pageStart(): number { return this.filteredItems.length ? this.currentPage * this.pageSize + 1 : 0; }
  get pageEnd(): number { return Math.min((this.currentPage + 1) * this.pageSize, this.filteredItems.length); }

  get pageItems(): StickerItem[] {
    const start = this.currentPage * this.pageSize;
    return this.filteredItems.slice(start, start + this.pageSize);
  }

  setPageSize(size: number) { this.pageSize = size; this.currentPage = 0; }
  goToPage(page: number) { this.currentPage = Math.max(0, Math.min(page, this.totalPages - 1)); }
  resetPage() { this.currentPage = 0; }

  relevanceDash(r: number): string {
    const filled = (Math.min(Math.max(r, 0), 10) / 10) * this.pieC;
    return `${filled} ${this.pieC}`;
  }

  relevanceColor(r: number): string {
    const t = Math.min(Math.max(r, 0), 10) / 10;
    const red = Math.round(249 + (22 - 249) * t);
    const green = Math.round(115 + (163 - 115) * t);
    const blue = Math.round(22 + (74 - 22) * t);
    return `rgb(${red},${green},${blue})`;
  }

  private compareRelevanceDesc(a: StickerItem, b: StickerItem): number {
    const aRel = a.type === 'product' ? a.relevance : 0;
    const bRel = b.type === 'product' ? b.relevance : 0;
    const aCount = a.type === 'product' ? a.orderCount : 0;
    const bCount = b.type === 'product' ? b.orderCount : 0;
    return bRel - aRel || bCount - aCount;
  }

  private directItemMatchRank(item: StickerItem, query: string): number {
    const q = this.normalizedSearchText(query);
    if (!q) return 0;
    return this.normalizedSearchText(`${item.name} ${item.barcode}`).includes(q) ? 1 : 0;
  }

  private normalizedSearchText(value: string): string {
    return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  private searchMigros(queryRaw: string) {
    const query = queryRaw.trim();
    if (query.length < 2) {
      this.migrosItems = [];
      this._filteredKey = '';
      return;
    }

    this.api.getScanAlternatives(query, 0, 10).subscribe({
      next: result => {
        if (this.textFilter.trim() !== query) return;
        this.migrosItems = result.choices
          .filter(c => !this.allItems.some(item => item.migrosUid != null && item.migrosUid === c.migrosUid))
          .map(c => this.choiceToStickerItem(c));
        this._filteredKey = '';
      },
      error: () => {
        if (this.textFilter.trim() === query) {
          this.migrosItems = [];
          this._filteredKey = '';
        }
      }
    });
  }

  private choiceToStickerItem(choice: ScanChoice): StickerItem {
    return {
      key: `m-${choice.migrosUid}`,
      type: 'product',
      id: 0,
      name: choice.name,
      imageUrl: choice.imageUrl,
      barcode: '',
      categories: undefined,
      available: true,
      relevance: 0.9,
      orderCount: 0,
      multiplier: choice.multiplier ?? 1,
      migrosUid: choice.migrosUid,
      source: 'migros',
    };
  }

  get allPageSelected(): boolean {
    return this.pageItems.length > 0 && this.pageItems.every(i => this.isSelected(i));
  }

  toggleSelectPage() {
    if (this.allPageSelected) {
      const keys = new Set(this.pageItems.map(i => i.key));
      this.selectedKeys = this.selectedKeys.filter(k => !keys.has(k));
    } else {
      for (const item of this.pageItems) {
        if (!this.isSelected(item)) this.selectItem(item);
      }
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  isSelected(item: StickerItem): boolean {
    return this.selectedKeys.includes(item.key);
  }

  toggleSelect(item: StickerItem) {
    if (this.isSelected(item)) {
      this.selectedKeys = this.selectedKeys.filter(k => k !== item.key);
      return;
    }

    this.selectItem(item);
  }

  private selectItem(item: StickerItem) {
    if (item.source === 'migros' && item.migrosUid != null) {
      this.syncAndSelectMigrosItem(item);
      return;
    }

    this.selectedKeys.push(item.key);
  }

  private syncAndSelectMigrosItem(item: StickerItem) {
    if (this.syncingMigrosKeys.has(item.key)) return;
    this.syncingMigrosKeys.add(item.key);
    this.api.getProductByUid(item.migrosUid!).subscribe({
      next: product => {
        const localItem = this.productToStickerItem(product);
        this.upsertStickerItem(localItem);
        this.migrosItems = this.migrosItems.filter(i => i.key !== item.key);
        if (!this.selectedKeys.includes(localItem.key)) this.selectedKeys.push(localItem.key);
        this.generateBarcodeUrls();
        this.syncingMigrosKeys.delete(item.key);
      },
      error: () => this.syncingMigrosKeys.delete(item.key)
    });
  }

  private productToStickerItem(p: Product): StickerItem {
    return {
      key: `p-${p.id}`,
      type: 'product',
      id: p.id,
      name: p.name,
      imageUrl: p.imageUrl,
      imageData: p.imageData,
      barcode: p.barcodes.split(',')[0].trim(),
      categories: p.categories,
      available: p.available ?? true,
      relevance: p.relevance,
      orderCount: p.orderCount,
      multiplier: p.multiplier ?? 1,
      migrosUid: p.migrosUid,
      source: 'local',
    };
  }

  private upsertStickerItem(item: StickerItem) {
    const idx = this.allItems.findIndex(i => i.key === item.key);
    if (idx >= 0) this.allItems[idx] = item;
    else this.allItems.push(item);
    this.allItems = this.allItems
      .filter(i => i.barcode)
      .sort((a, b) => {
        if (a.type === 'recipe' && b.type !== 'recipe') return -1;
        if (b.type === 'recipe' && a.type !== 'recipe') return 1;
        return this.compareRelevanceDesc(a, b);
      });
    this.fuse = new Fuse(this.allItems, FUSE_OPTIONS);
    this._filteredKey = '';
  }

  clearSelection() { this.selectedKeys = []; }

  get selectedItems(): StickerItem[] {
    return this.selectedKeys
      .map(k => this.allItems.find(i => i.key === k))
      .filter((i): i is StickerItem => !!i);
  }

  // ── Sheet layout ───────────────────────────────────────────────────────────

  get perPage(): number { return Math.max(1, this.cols) * Math.max(1, this.rows); }

  get sheetPages(): StickerItem[][] {
    const items = this.selectedItems;
    if (!items.length) return [[]];
    const pages: StickerItem[][] = [];
    for (let i = 0; i < items.length; i += this.perPage)
      pages.push(items.slice(i, i + this.perPage));
    return pages;
  }

  emptySlots(page: StickerItem[]): number[] {
    const count = Math.max(0, this.perPage - page.length);
    return Array.from({ length: count }, (_, i) => i);
  }

  get colsStyle(): string { return `repeat(${Math.max(1, this.cols)}, 1fr)`; }
  get rowsStyle(): string { return `repeat(${Math.max(1, this.rows)}, 1fr)`; }

  // ── PDF generation ─────────────────────────────────────────────────────────

  async downloadPdf() {
    if (!this.selectedItems.length) return;
    this.generatingPdf = true;
    try {
      const { jsPDF } = await import('jspdf');
      const { default: JsBarcode } = await import('jsbarcode');

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = 210, pageH = 297;
      const mT = this.marginTop, mR = this.marginRight, mB = this.marginBottom, mL = this.marginLeft;
      const cols = Math.max(1, this.cols), rows = Math.max(1, this.rows);
      const stickerW = (pageW - mL - mR) / cols;
      const stickerH = (pageH - mT - mB) / rows;
      const pad = (this.padding / 100) * stickerW;
      const imgShare = this.imageRatio / 100;
      const bcShare = 1 - imgShare;

      const items = this.selectedItems;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const pos = i % this.perPage;
        const col = pos % cols;
        const row = Math.floor(pos / cols);

        if (i > 0 && pos === 0) doc.addPage();

        const x = mL + col * stickerW;
        const y = mT + row * stickerH;

        // Border
        if (this.showCutlines) {
          doc.setDrawColor(180);
          doc.setLineWidth(0.15);
          doc.rect(x, y, stickerW, stickerH);
        }

        // Name strip at bottom
        const nameH = 4;
        const innerH = stickerH - nameH - pad * 2;
        const innerY = y + pad;

        // Compute image and barcode zones
        let imgX: number, imgY: number, imgSize: number;
        let bcX: number, bcY: number, bcW: number, bcH: number;

        if (this.layout === 'horizontal') {
          const innerW = stickerW - pad * 2;
          const imgW = innerW * imgShare;
          const bcW2 = innerW * bcShare;
          imgSize = Math.min(imgW, innerH);
          imgX = x + pad + (imgW - imgSize) / 2;
          imgY = innerY + (innerH - imgSize) / 2;
          bcX = x + pad + imgW; bcY = innerY; bcW = bcW2; bcH = innerH;
        } else {
          const imgH = innerH * imgShare;
          const bcH2 = innerH * bcShare;
          imgSize = Math.min(stickerW - pad * 2, imgH);
          imgX = x + pad + ((stickerW - pad * 2) - imgSize) / 2;
          imgY = innerY + (imgH - imgSize) / 2;
          bcX = x + pad; bcY = innerY + imgH; bcW = stickerW - pad * 2; bcH = bcH2;
        }

        // Image
        const imageSource = item.imageUrl || item.imageData;
        if (imageSource && this.imageRatio > 0) {
          try {
            const imgData = await this.getPdfImageData(imageSource, imgSize);
            const el = await this.loadImage(imgData);
            const aspect = el.naturalWidth / el.naturalHeight;
            let drawW = imgSize, drawH = imgSize;
            if (aspect > 1) drawH = imgSize / aspect;
            else drawW = imgSize * aspect;
            doc.addImage(imgData, 'JPEG',
              imgX + (imgSize - drawW) / 2,
              imgY + (imgSize - drawH) / 2,
              drawW, drawH);
          } catch { /* CORS or load failure — skip */ }
        }

        // Barcode
        try {
          const canvas = document.createElement('canvas');
          JsBarcode(canvas, item.barcode, {
            format: this.detectFormat(item.barcode),
            margin: 2, height: 60, width: 2, displayValue: false,
          });
          const bcData = canvas.toDataURL('image/png');
          const aspect = canvas.width / canvas.height;
          let w = bcW, h = w / aspect;
          if (h > bcH) { h = bcH; w = h * aspect; }
          doc.addImage(bcData, 'PNG', bcX + (bcW - w) / 2, bcY + (bcH - h) / 2, w, h);
        } catch { /* skip */ }

        // Name
        if (this.fontSize > 0) {
          doc.setFontSize(this.fontSize);
          doc.setTextColor(60);
          const nameY = y + stickerH - pad;
          const name = doc.splitTextToSize(item.name, stickerW - pad * 2)[0];
          doc.text(name, x + stickerW / 2, nameY, { align: 'center' });
        }
      }

      doc.save('stickers.pdf');
    } finally {
      this.generatingPdf = false;
    }
  }

  private loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  private async fetchDataUrl(url: string): Promise<string> {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private async getPdfImageData(source: string, sizeMm: number): Promise<string> {
    const targetPixels = this.mmToPrintPixels(sizeMm);
    const cacheKey = `${source}|${targetPixels}`;
    const cached = this.pdfImageCache.get(cacheKey);
    if (cached) return cached;

    const originalData = source.startsWith('data:') ? source : await this.fetchDataUrl(source);
    const compressed = await this.compressImageForPdf(originalData, targetPixels);
    this.pdfImageCache.set(cacheKey, compressed);
    return compressed;
  }

  private mmToPrintPixels(mm: number): number {
    const dpi = 450;
    return Math.max(96, Math.ceil((mm / 25.4) * dpi));
  }

  private async compressImageForPdf(dataUrl: string, maxDimension: number): Promise<string> {
    const img = await this.loadImage(dataUrl);
    const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }
}
