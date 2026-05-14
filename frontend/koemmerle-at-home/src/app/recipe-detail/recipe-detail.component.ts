import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { ScanApiService, RecipeDto, Product, ScanChoice } from '../services/scan-api.service';
import { ScanBridgeService } from '../services/scan-bridge.service';

const FUSE_OPTIONS: IFuseOptions<Product> = {
  keys: ['name'],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};
const SEARCH_RESULT_LIMIT = 50;

@Component({
  selector: 'app-recipe-detail',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './recipe-detail.component.html',
  styleUrl: './recipe-detail.component.scss'
})
export class RecipeDetailComponent implements OnInit {
  recipe: RecipeDto | null = null;
  loading = true;
  notFound = false;
  message = '';

  products: Product[] = [];
  private fuse = new Fuse<Product>([], FUSE_OPTIONS);

  // Recipe header editing
  editMode = false;
  editBarcode = '';
  editName = '';

  // Add-item state
  addSearch = '';
  addProductId: number | null = null;
  showDropdown = false;
  showUnavailable = false;
  gtinStatus: 'idle' | 'searching' | 'found' | 'unknown' | 'choosing' = 'idle';
  gtinCandidates: ScanChoice[] = [];
  migrosSearchChoices: ScanChoice[] = [];
  private migrosSearchTimer: any = null;

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

  private recipeId = 0;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ScanApiService,
    private bridge: ScanBridgeService
  ) {}

  ngOnInit() {
    this.recipeId = Number(this.route.snapshot.paramMap.get('id'));
    this.load();
    this.api.getProducts().subscribe(p => {
      this.products = p;
      this.fuse = new Fuse(p, FUSE_OPTIONS);
    });
  }

  load() {
    this.loading = true;
    this.api.getRecipe(this.recipeId).subscribe({
      next: r => { this.recipe = r; this.loading = false; },
      error: () => { this.notFound = true; this.loading = false; }
    });
  }

  // ── Header editing ─────────────────────────────────────────────────────────

  startEdit() {
    if (!this.recipe) return;
    this.editBarcode = this.recipe.barcode;
    this.editName = this.recipe.name;
    this.editMode = true;
  }

  saveEdit() {
    if (!this.recipe) return;
    this.api.updateRecipe(this.recipe.id, this.editBarcode, this.editName).subscribe(() => {
      this.recipe!.barcode = this.editBarcode;
      this.recipe!.name = this.editName;
      this.editMode = false;
    });
  }

  cancelEdit() { this.editMode = false; }

  // ── Image ──────────────────────────────────────────────────────────────────

  onImageFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !this.recipe) return;
    this.resizeAndUpload(file, dataUrl => {
      this.api.setRecipeImage(this.recipe!.id, dataUrl).subscribe(() => {
        this.recipe!.imageData = dataUrl;
        this.message = 'Bild gespeichert';
      });
    });
  }

  clearImage() {
    if (!this.recipe) return;
    this.api.setRecipeImage(this.recipe.id, null).subscribe(() => {
      this.recipe!.imageData = undefined;
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────────

  updateItemQty(itemId: number, qty: number) {
    if (!this.recipe) return;
    this.api.updateRecipeItem(this.recipe.id, itemId, qty).subscribe(updated => {
      const idx = this.recipe!.items.findIndex(i => i.id === itemId);
      if (idx >= 0) this.recipe!.items[idx].quantity = updated.quantity;
    });
  }

  removeItem(itemId: number) {
    if (!this.recipe) return;
    this.api.removeRecipeItem(this.recipe.id, itemId).subscribe(() => {
      this.recipe!.items = this.recipe!.items.filter(i => i.id !== itemId);
    });
  }

  // ── Add item ───────────────────────────────────────────────────────────────

  unusedProducts(): Product[] {
    if (!this.recipe) return this.products;
    const usedIds = new Set(this.recipe.items.map(i => i.productId));
    return this.products.filter(p => !usedIds.has(p.id));
  }

  filteredProducts(): Product[] {
    const sorted = [...this.unusedProducts()]
      .sort((a, b) => this.compareRelevanceDesc(a, b));
    const available = this.showUnavailable ? sorted : sorted.filter(p => p.available !== false);
    const q = this.addSearch.trim();
    const filtered = q
      ? this.fuse.search(q)
          .filter(r => available.includes(r.item))
          .sort((a, b) =>
            this.directProductMatchRank(b.item, q) - this.directProductMatchRank(a.item, q)
            || Math.floor((a.score ?? 1) * 5) - Math.floor((b.score ?? 1) * 5)
            || this.compareRelevanceDesc(a.item, b.item))
          .map(r => r.item)
      : available;
    return filtered.slice(0, SEARCH_RESULT_LIMIT);
  }

  searchOptions(): ProductSearchOption[] {
    const localOptions: ProductSearchOption[] = this.filteredProducts().map(p => ({
      key: `local-${p.id}`,
      source: 'local',
      name: p.name,
      imageUrl: p.imageData || p.imageUrl,
      weightText: p.weightText,
      price: p.price,
      multiplier: p.multiplier,
      relevance: p.relevance,
      product: p,
    }));

    const usedUids = new Set(this.products.map(p => p.migrosUid).filter((uid): uid is number => uid != null));
    const remoteOptions: ProductSearchOption[] = this.migrosSearchChoices
      .filter(c => !usedUids.has(c.migrosUid))
      .map(c => ({
        key: `migros-${c.migrosUid}`,
        source: 'migros',
        name: c.name,
        imageUrl: c.imageUrl,
        weightText: c.weightText,
        price: c.price,
        multiplier: c.multiplier,
        relevance: 0.9,
        choice: c,
      }));

    const query = this.addSearch.trim();
    return [...localOptions, ...remoteOptions]
      .sort((a, b) =>
        this.directOptionMatchRank(b, query) - this.directOptionMatchRank(a, query)
        || b.relevance - a.relevance
        || a.name.localeCompare(b.name))
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  private compareRelevanceDesc(a: Product, b: Product): number {
    return b.relevance - a.relevance || b.orderCount - a.orderCount;
  }

  private directProductMatchRank(product: Product, query: string): number {
    const q = this.normalizedSearchText(query);
    if (!q) return 0;
    return this.normalizedSearchText(`${product.name} ${product.barcodes}`).includes(q) ? 1 : 0;
  }

  private directOptionMatchRank(option: ProductSearchOption, query: string): number {
    const q = this.normalizedSearchText(query);
    if (!q) return 0;
    return this.normalizedSearchText(option.name).includes(q) ? 1 : 0;
  }

  private normalizedSearchText(value: string): string {
    return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  addItem() {
    if (!this.addProductId || !this.recipe) return;
    const existing = this.recipe.items.find(i => i.productId === this.addProductId);
    if (existing) {
      this.updateItemQty(existing.id, existing.quantity + 1);
      this.resetAddState();
      return;
    }
    this.api.addRecipeItem(this.recipe.id, this.addProductId, 1).subscribe(item => {
      this.recipe!.items.push(item);
      this.resetAddState();
    });
  }

  selectProduct(p: Product) {
    this.addProductId = p.id;
    this.addSearch = p.name;
    this.showDropdown = false;
    this.gtinStatus = 'idle';
    this.gtinCandidates = [];
  }

  selectAndAdd(p: Product) {
    this.selectProduct(p);
    this.addItem();
  }

  selectMigrosAndAdd(choice: ScanChoice) {
    this.gtinStatus = 'searching';
    this.api.getProductByUid(choice.migrosUid).subscribe({
      next: product => {
        this.upsertProduct(product);
        this.selectProduct(product);
        this.addItem();
      },
      error: () => { this.gtinStatus = 'unknown'; }
    });
  }

  hideDropdown() { setTimeout(() => this.showDropdown = false, 150); }

  onAddSearchFocus() {
    this.showDropdown = true;
    this.bridge.suppressGlobal();
  }

  onAddSearchBlur() {
    this.hideDropdown();
    this.bridge.unsuppressGlobal();
  }

  onSearchInput() {
    this.addProductId = null;
    this.gtinStatus = 'idle';
    this.showDropdown = true;
    this.scheduleMigrosSearch();
  }

  onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { this.showDropdown = false; return; }
    if (e.key !== 'Enter') return;
    const val = this.addSearch.trim();
    if (/^\d{8,14}$/.test(val)) { this.handleGtin(val); return; }
    if (this.addProductId) { this.addItem(); return; }
    const first = this.searchOptions()[0];
    if (!first) return;
    if (first.source === 'local' && first.product) this.selectAndAdd(first.product);
    else if (first.choice) this.selectMigrosAndAdd(first.choice);
  }

  private scheduleMigrosSearch() {
    clearTimeout(this.migrosSearchTimer);
    const query = this.addSearch.trim();
    if (query.length < 2 || /^\d{8,14}$/.test(query)) {
      this.migrosSearchChoices = [];
      return;
    }

    this.migrosSearchTimer = setTimeout(() => {
      this.api.getScanAlternatives(query, 0, SEARCH_RESULT_LIMIT).subscribe({
        next: r => {
          if (this.addSearch.trim() === query) this.migrosSearchChoices = r.choices;
        },
        error: () => {
          if (this.addSearch.trim() === query) this.migrosSearchChoices = [];
        }
      });
    }, 250);
  }

  handleGtin(gtin: string) {
    const local = this.products.find(p =>
      p.barcodes.split(',').map(b => b.trim()).includes(gtin));
    if (local) { this.selectProduct(local); this.addItem(); return; }

    this.gtinStatus = 'searching';
    this.showDropdown = false;
    this.api.getProductByBarcode(gtin).subscribe({
      next: r => {
        if (r.type === 'found' && r.products?.length) {
          this.selectProduct(r.products[0]);
          this.addItem();
        } else if (r.type === 'candidates' && r.choices?.length) {
          this.gtinStatus = 'choosing';
          this.gtinCandidates = r.choices;
          this.showDropdown = true;
        } else {
          this.gtinStatus = 'unknown';
          setTimeout(() => { if (this.gtinStatus === 'unknown') this.gtinStatus = 'idle'; }, 3000);
        }
      },
      error: () => {
        this.gtinStatus = 'unknown';
        setTimeout(() => { if (this.gtinStatus === 'unknown') this.gtinStatus = 'idle'; }, 3000);
      }
    });
  }

  pickGtinCandidate(choice: ScanChoice) {
    this.gtinStatus = 'searching';
    this.api.getProductByUid(choice.migrosUid).subscribe({
      next: product => {
        this.upsertProduct(product);
        this.selectProduct(product);
        this.addItem();
      },
      error: () => { this.gtinStatus = 'unknown'; }
    });
  }

  private resetAddState() {
    this.addProductId = null;
    this.addSearch = '';
    this.showDropdown = false;
    this.gtinStatus = 'idle';
    this.gtinCandidates = [];
    this.migrosSearchChoices = [];
  }

  private upsertProduct(product: Product) {
    const idx = this.products.findIndex(p => p.id === product.id);
    if (idx >= 0) this.products[idx] = product;
    else this.products.push(product);
    this.fuse = new Fuse(this.products, FUSE_OPTIONS);
  }

  // ── Delete recipe ──────────────────────────────────────────────────────────

  deleteRecipe() {
    if (!this.recipe || !confirm(`Rezept "${this.recipe.name}" löschen?`)) return;
    this.api.deleteRecipe(this.recipe.id).subscribe(() => {
      this.router.navigate(['/recipes']);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resizeAndUpload(file: File, callback: (dataUrl: string) => void) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 300;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      callback(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = url;
  }
}

interface ProductSearchOption {
  key: string;
  source: 'local' | 'migros';
  name: string;
  imageUrl?: string;
  weightText?: string;
  price?: number;
  multiplier: number;
  relevance: number;
  product?: Product;
  choice?: ScanChoice;
}
