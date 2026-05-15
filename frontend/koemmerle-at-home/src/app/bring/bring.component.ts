import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Fuse, { type IFuseOptions } from 'fuse.js';
import { BringMatch, BringSuggestion, Product, ScanApiService } from '../services/scan-api.service';
import { ConfirmationService } from '../shared/confirmation.service';

const SEARCH_RESULT_LIMIT = 50;
const FUSE_OPTIONS: IFuseOptions<Product> = {
  keys: ['name'],
  threshold: 0.35,
  ignoreLocation: true,
  minMatchCharLength: 2,
  includeScore: true,
};

@Component({
  selector: 'app-bring',
  imports: [CommonModule, FormsModule],
  templateUrl: './bring.component.html',
  styleUrl: './bring.component.scss'
})
export class BringComponent implements OnInit {
  items: BringMatch[] = [];
  selectedUid: Record<number, number | null> = {};
  quantities: Record<number, number> = {};
  startBusy = false;
  extractBusy = false;
  enqueueBusy = false;
  message = '';
  error = '';
  customSearchIndex: number | null = null;
  customSearch: Record<number, string> = {};
  customResults: Record<number, BringSuggestion[]> = {};
  customBusy: Record<number, boolean> = {};
  products: Product[] = [];
  private fuse = new Fuse<Product>([], FUSE_OPTIONS);
  private customSearchTimer: any = null;
  private readonly storageKey = 'bring-sync-review-state-v1';
  readonly pieR = 9;
  readonly pieC = 2 * Math.PI * this.pieR;

  constructor(
    private api: ScanApiService,
    private confirmation: ConfirmationService
  ) {}

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.customSearchIndex !== null) {
      this.customSearchIndex = null;
      this.persistState();
    }
  }

  @HostListener('document:click')
  onDocumentClick() {
    if (this.customSearchIndex !== null) {
      this.customSearchIndex = null;
      this.persistState();
    }
  }

  ngOnInit() {
    this.restoreState();
    this.api.getProducts().subscribe(products => {
      this.products = products;
      this.fuse = new Fuse(products, FUSE_OPTIONS);
    });
  }

  startSync() {
    this.startBusy = true;
    this.message = '';
    this.error = '';
    this.api.startBringSync().subscribe({
      next: () => {
        this.startBusy = false;
        this.message = 'Bring ist im Browser geöffnet. Wähle dort die richtige Liste aus.';
      },
      error: () => {
        this.startBusy = false;
        this.error = 'Bring konnte nicht geöffnet werden.';
      }
    });
  }

  extract() {
    this.extractBusy = true;
    this.message = '';
    this.error = '';
    this.api.extractBringList().subscribe({
      next: response => {
        this.items = response.items;
        this.selectedUid = {};
        this.quantities = {};
        this.customSearchIndex = null;
        this.customSearch = {};
        this.customResults = {};
        this.customBusy = {};
        for (const item of this.items) {
          this.selectedUid[item.index] = item.suggestions[0]?.migrosUid ?? null;
          this.quantities[item.index] = 1;
        }
        this.extractBusy = false;
        this.message = this.items.length ? '' : 'Keine offenen Bring-Artikel gefunden.';
        this.persistState();
      },
      error: err => {
        this.extractBusy = false;
        this.error = err?.error?.message ?? 'Bring-Liste konnte nicht ausgelesen werden.';
      }
    });
  }

  select(item: BringMatch, suggestion: BringSuggestion) {
    this.selectedUid[item.index] = suggestion.migrosUid;
    this.persistState();
  }

  selectedSuggestion(item: BringMatch): BringSuggestion | null {
    const uid = this.selectedUid[item.index];
    return item.suggestions.find(s => s.migrosUid === uid) ?? null;
  }

  otherSuggestions(item: BringMatch): BringSuggestion[] {
    return item.suggestions.slice(1, 5);
  }

  selectedCount(): number {
    return this.items.filter(item => this.selectedUid[item.index]).length;
  }

  async enqueueSelected() {
    const selected = this.items
      .map(item => ({
        item,
        suggestion: this.selectedSuggestion(item)
      }))
      .filter((entry): entry is { item: BringMatch; suggestion: BringSuggestion } => !!entry.suggestion)
      .map(entry => ({
        index: entry.item.index,
        name: entry.item.name,
        specification: entry.item.specification,
        migrosUid: entry.suggestion.migrosUid,
        quantity: Math.max(1, this.quantities[entry.item.index] ?? 1)
      }));

    if (selected.length === 0) return;
    const confirmed = await this.confirmation.confirm({
      title: 'Zum Warenkorb hinzufügen?',
      message: `${selected.length} ausgewählte Artikel werden zur Verarbeitung an deinen Migros-Warenkorb übergeben.`,
      confirmText: 'Hinzufügen',
      cancelText: 'Abbrechen'
    });
    if (!confirmed) return;

    this.enqueueBusy = true;
    this.message = '';
    this.error = '';
    this.api.enqueueBringItems(selected).subscribe({
      next: result => {
        this.enqueueBusy = false;
        const message = `${result.enqueued} Artikel werden zum Warenkorb hinzugefügt.`;
        const error = result.skipped ? `${result.skipped} Artikel konnten nicht verknüpft werden.` : '';
        this.clearReviewState(message, error);
      },
      error: () => {
        this.enqueueBusy = false;
        this.error = 'Artikel konnten nicht in die Queue gelegt werden.';
      }
    });
  }

  clearSelection(item: BringMatch) {
    this.selectedUid[item.index] = null;
    this.persistState();
  }

  clearResults() {
    this.clearReviewState();
  }

  adjustQuantity(item: BringMatch, delta: number) {
    const current = this.quantities[item.index] ?? 1;
    this.quantities[item.index] = Math.max(1, current + delta);
    this.persistState();
  }

  private clearReviewState(message = '', error = '') {
    this.items = [];
    this.selectedUid = {};
    this.quantities = {};
    this.customSearchIndex = null;
    this.customSearch = {};
    this.customResults = {};
    this.customBusy = {};
    this.message = message;
    this.error = error;
    localStorage.removeItem(this.storageKey);
  }

  openCustomSearch(item: BringMatch) {
    this.customSearchIndex = this.customSearchIndex === item.index ? null : item.index;
    if (this.customSearchIndex === item.index && !this.customSearch[item.index]) {
      this.customSearch[item.index] = this.itemLabel(item);
    }
    if (this.customSearchIndex === item.index) this.runCustomSearch(item);
    this.persistState();
  }

  onCustomSearchInput(item: BringMatch, value: string) {
    this.customSearch[item.index] = value;
    this.persistState();
    clearTimeout(this.customSearchTimer);
    this.customSearchTimer = setTimeout(() => this.runCustomSearch(item), 250);
  }

  runCustomSearch(item: BringMatch) {
    const query = (this.customSearch[item.index] ?? '').trim();
    if (query.length < 2) {
      this.customResults[item.index] = [];
      this.customBusy[item.index] = false;
      return;
    }

    this.customBusy[item.index] = true;
    this.customResults[item.index] = this.localSearchResults(query);
    this.api.getScanAlternatives(query, 0, SEARCH_RESULT_LIMIT).subscribe({
      next: response => {
        if ((this.customSearch[item.index] ?? '').trim() !== query) return;
        this.customResults[item.index] = this.mergeSearchResults(
          query,
          this.localSearchResults(query),
          response.choices.map(choice => ({
            migrosUid: choice.migrosUid,
            name: choice.name,
            imageUrl: choice.imageUrl,
            weightText: choice.weightText,
            price: choice.price,
            multiplier: choice.multiplier,
            relevance: 0.9,
            orderCount: 0,
            matchedQuery: query
          }))
        );
        this.customBusy[item.index] = false;
        this.persistState();
      },
      error: () => {
        if ((this.customSearch[item.index] ?? '').trim() === query) {
          this.customResults[item.index] = [];
          this.customBusy[item.index] = false;
          this.persistState();
        }
      }
    });
  }

  pickCustomSuggestion(item: BringMatch, suggestion: BringSuggestion) {
    item.suggestions = [
      suggestion,
      ...item.suggestions.filter(s => s.migrosUid !== suggestion.migrosUid)
    ].slice(0, 5);
    this.select(item, suggestion);
    this.customSearchIndex = null;
    this.persistState();
  }

  itemLabel(item: BringMatch): string {
    return item.specification ? `${item.name} ${item.specification}` : item.name;
  }

  private localSearchResults(query: string): BringSuggestion[] {
    const q = query.trim();
    const results = q
      ? this.fuse.search(q)
          .sort((a, b) =>
            this.directProductMatchRank(b.item, q) - this.directProductMatchRank(a.item, q)
            || Math.floor((a.score ?? 1) * 5) - Math.floor((b.score ?? 1) * 5)
            || this.compareRelevanceDesc(a.item, b.item))
          .map(r => r.item)
      : [...this.products].sort((a, b) => this.compareRelevanceDesc(a, b));

    return results
      .filter(product => product.migrosUid != null)
      .slice(0, SEARCH_RESULT_LIMIT)
      .map(product => ({
        migrosUid: product.migrosUid!,
        name: product.name,
        imageUrl: product.imageData || product.imageUrl,
        weightText: product.weightText,
        price: product.price,
        multiplier: product.multiplier,
        relevance: product.relevance,
        orderCount: product.orderCount,
        matchedQuery: q
      }));
  }

  private mergeSearchResults(query: string, local: BringSuggestion[], remote: BringSuggestion[]): BringSuggestion[] {
    const byUid = new Map<number, BringSuggestion>();
    for (const suggestion of [...local, ...remote]) {
      const existing = byUid.get(suggestion.migrosUid);
      if (!existing || suggestion.relevance > existing.relevance) byUid.set(suggestion.migrosUid, suggestion);
    }

    return [...byUid.values()]
      .sort((a, b) =>
        this.directSuggestionMatchRank(b, query) - this.directSuggestionMatchRank(a, query)
        || b.relevance - a.relevance
        || b.orderCount - a.orderCount
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

  private directSuggestionMatchRank(suggestion: BringSuggestion, query: string): number {
    const q = this.normalizedSearchText(query);
    if (!q) return 0;
    return this.normalizedSearchText(suggestion.name).includes(q) ? 1 : 0;
  }

  private normalizedSearchText(value: string): string {
    return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  relevanceDash(relevance: number): string {
    const filled = (Math.min(Math.max(relevance, 0), 10) / 10) * this.pieC;
    return `${filled} ${this.pieC}`;
  }

  relevanceColor(relevance: number): string {
    const t = Math.min(Math.max(relevance, 0), 10) / 10;
    const red = Math.round(249 + (22 - 249) * t);
    const green = Math.round(115 + (163 - 115) * t);
    const blue = Math.round(22 + (74 - 22) * t);
    return `rgb(${red},${green},${blue})`;
  }

  persistState() {
    try {
      const state: BringReviewState = {
        items: this.items,
        selectedUid: this.selectedUid,
        quantities: this.quantities,
        customSearchIndex: this.customSearchIndex,
        customSearch: this.customSearch,
        customResults: this.customResults,
        message: this.message,
        error: this.error,
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      /* localStorage can be unavailable or full; the live state still works. */
    }
  }

  private restoreState() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const state = JSON.parse(raw) as Partial<BringReviewState>;
      if (!Array.isArray(state.items)) return;

      this.items = state.items;
      this.selectedUid = this.cleanNullableNumberRecord(state.selectedUid);
      this.quantities = this.cleanNumberRecord(state.quantities);
      this.customSearchIndex = typeof state.customSearchIndex === 'number' ? state.customSearchIndex : null;
      this.customSearch = this.cleanStringRecord(state.customSearch);
      this.customResults = this.cleanSuggestionRecord(state.customResults);
      this.customBusy = {};
      this.message = typeof state.message === 'string' ? state.message : '';
      this.error = typeof state.error === 'string' ? state.error : '';

      for (const item of this.items) {
        if (!(item.index in this.selectedUid)) this.selectedUid[item.index] = item.suggestions[0]?.migrosUid ?? null;
        if (!(item.index in this.quantities)) this.quantities[item.index] = 1;
      }
    } catch {
      localStorage.removeItem(this.storageKey);
    }
  }

  private cleanNullableNumberRecord(value: unknown): Record<number, number | null> {
    if (!value || typeof value !== 'object') return {};
    const result: Record<number, number | null> = {};
    for (const [key, raw] of Object.entries(value)) {
      const index = Number(key);
      if (!Number.isInteger(index)) continue;
      if (raw === null) result[index] = null;
      else if (typeof raw === 'number' && Number.isFinite(raw)) result[index] = raw;
    }
    return result;
  }

  private cleanNumberRecord(value: unknown): Record<number, number> {
    if (!value || typeof value !== 'object') return {};
    const result: Record<number, number> = {};
    for (const [key, raw] of Object.entries(value)) {
      const index = Number(key);
      if (Number.isInteger(index) && typeof raw === 'number' && Number.isFinite(raw)) result[index] = raw;
    }
    return result;
  }

  private cleanStringRecord(value: unknown): Record<number, string> {
    if (!value || typeof value !== 'object') return {};
    const result: Record<number, string> = {};
    for (const [key, raw] of Object.entries(value)) {
      const index = Number(key);
      if (Number.isInteger(index) && typeof raw === 'string') result[index] = raw;
    }
    return result;
  }

  private cleanSuggestionRecord(value: unknown): Record<number, BringSuggestion[]> {
    if (!value || typeof value !== 'object') return {};
    const result: Record<number, BringSuggestion[]> = {};
    for (const [key, raw] of Object.entries(value)) {
      const index = Number(key);
      if (Number.isInteger(index) && Array.isArray(raw)) result[index] = raw as BringSuggestion[];
    }
    return result;
  }
}

interface BringReviewState {
  items: BringMatch[];
  selectedUid: Record<number, number | null>;
  quantities: Record<number, number>;
  customSearchIndex: number | null;
  customSearch: Record<number, string>;
  customResults: Record<number, BringSuggestion[]>;
  message: string;
  error: string;
  savedAt: string;
}
