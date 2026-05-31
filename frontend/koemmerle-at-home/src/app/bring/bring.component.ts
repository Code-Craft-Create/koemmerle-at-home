import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BringListChoice, BringMatch, BringSuggestion, ScanApiService } from '../services/scan-api.service';
import { ConfirmationService } from '../shared/confirmation.service';

const SEARCH_RESULT_LIMIT = 50;

@Component({
  selector: 'app-bring',
  imports: [CommonModule, FormsModule],
  templateUrl: './bring.component.html',
  styleUrl: './bring.component.scss'
})
export class BringComponent implements OnInit, OnDestroy {
  items: BringMatch[] = [];
  bringLists: BringListChoice[] = [];
  selectedUid: Record<number, number | null> = {};
  quantities: Record<number, number> = {};
  startBusy = false;
  listsBusy = false;
  extractBusy = false;
  enqueueBusy = false;
  message = '';
  error = '';
  selectedListName: string | null = null;
  customSearchIndex: number | null = null;
  customSearch: Record<number, string> = {};
  customResults: Record<number, BringSuggestion[]> = {};
  customBusy: Record<number, boolean> = {};
  customFallback: Record<number, CustomFallbackNotice | null> = {};
  private customSearchTimer: any = null;
  private listPollTimer: any = null;
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
    this.refreshBringLists(false);
  }

  ngOnDestroy() {
    this.stopListPolling();
  }

  startSync() {
    this.startBusy = true;
    this.message = '';
    this.error = '';
    this.api.startBringSync().subscribe({
      next: () => {
        this.startBusy = false;
        this.message = 'Bring ist im Browser geöffnet. Melde dich dort an; die verfügbaren Listen erscheinen danach hier.';
        this.startListPolling();
      },
      error: () => {
        this.startBusy = false;
        this.error = 'Bring konnte nicht geöffnet werden.';
      }
    });
  }

  refreshBringLists(showBusy = true) {
    if (showBusy) this.listsBusy = true;
    this.api.getBringLists().subscribe({
      next: response => {
        this.bringLists = response.lists ?? [];
        if (this.bringLists.length > 0) {
          const selected = this.bringLists.find(list => list.selected) ?? this.bringLists[0];
          if (!this.selectedListName || !this.bringLists.some(list => list.name === this.selectedListName)) {
            this.selectedListName = selected.name;
          }
          if (this.items.length === 0) {
            this.message = 'Wähle aus, welche Bring-Liste du laden möchtest.';
          }
          this.stopListPolling();
        }
        this.listsBusy = false;
      },
      error: () => {
        this.listsBusy = false;
      }
    });
  }

  loadBringList(list: BringListChoice) {
    this.selectedListName = list.name;
    this.extract(list.name);
  }

  extract(listName = this.selectedListName ?? undefined) {
    this.extractBusy = true;
    this.message = '';
    this.error = '';
    this.api.extractBringList(listName).subscribe({
      next: response => {
        this.items = response.items.map(item => ({
          ...item,
          suggestions: this.preferFirstAvailable(item.suggestions)
        }));
        this.selectedUid = {};
        this.quantities = {};
        this.customSearchIndex = null;
        this.customSearch = {};
        this.customResults = {};
        this.customBusy = {};
        this.customFallback = {};
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

  private startListPolling() {
    this.stopListPolling();
    this.refreshBringLists(false);
    this.listPollTimer = setInterval(() => this.refreshBringLists(false), 1500);
  }

  private stopListPolling() {
    if (!this.listPollTimer) return;
    clearInterval(this.listPollTimer);
    this.listPollTimer = null;
  }

  select(item: BringMatch, suggestion: BringSuggestion) {
    this.selectedUid[item.index] = suggestion.migrosUid;
    this.persistState();
  }

  selectedSuggestion(item: BringMatch): BringSuggestion | null {
    const uid = this.selectedUid[item.index];
    return item.suggestions.find(s => s.migrosUid === uid) ?? null;
  }

  suggestionEffectivePrice(suggestion: BringSuggestion): number | null {
    return suggestion.promotionPrice ?? suggestion.price ?? null;
  }

  suggestionHasPromotion(suggestion: BringSuggestion): boolean {
    return suggestion.promotionPrice != null && (suggestion.price == null || suggestion.promotionPrice < suggestion.price);
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
    this.customFallback = {};
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

  closeCustomSearch() {
    this.customSearchIndex = null;
    this.persistState();
  }

  onCustomSearchInput(item: BringMatch, value: string) {
    this.customSearch[item.index] = value;
    this.customFallback[item.index] = null;
    this.persistState();
    clearTimeout(this.customSearchTimer);
    this.customSearchTimer = setTimeout(() => this.runCustomSearch(item), 250);
  }

  runCustomSearch(item: BringMatch) {
    const query = (this.customSearch[item.index] ?? '').trim();
    this.customFallback[item.index] = null;
    if (query.length < 2) {
      this.customResults[item.index] = [];
      this.customBusy[item.index] = false;
      this.persistState();
      return;
    }

    this.customBusy[item.index] = true;
    this.api.searchBringProducts(query, SEARCH_RESULT_LIMIT).subscribe({
      next: response => {
        if ((this.customSearch[item.index] ?? '').trim() !== query) return;
        const suggestions = this.preferFirstAvailable(response.suggestions);
        this.customResults[item.index] = suggestions;
        this.customFallback[item.index] = this.fallbackNoticeFromResults(query, suggestions);
        this.customBusy[item.index] = false;
        this.persistState();
      },
      error: () => {
        if ((this.customSearch[item.index] ?? '').trim() !== query) return;
        this.customResults[item.index] = [];
        this.customFallback[item.index] = null;
        this.customBusy[item.index] = false;
        this.persistState();
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

  private fallbackNoticeFromResults(query: string, suggestions: BringSuggestion[]): CustomFallbackNotice | null {
    if (suggestions.length === 0) return null;

    const exactQuery = this.normalizedSearchText(query);
    const matchedQueries = suggestions
      .map(s => s.matchedQuery?.trim())
      .filter((matchedQuery): matchedQuery is string => !!matchedQuery);

    if (matchedQueries.some(matchedQuery => this.normalizedSearchText(matchedQuery) === exactQuery)) {
      return null;
    }

    const fallbackQuery = matchedQueries
      .sort((a, b) => this.normalizedSearchText(b).length - this.normalizedSearchText(a).length)[0];

    return fallbackQuery ? { originalQuery: query, fallbackQuery } : null;
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
        customFallback: this.customFallback,
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

      this.items = state.items.map(item => ({
        ...item,
        suggestions: this.normaliseSuggestions(item.suggestions)
      }));
      this.selectedUid = this.cleanNullableNumberRecord(state.selectedUid);
      this.quantities = this.cleanNumberRecord(state.quantities);
      this.customSearchIndex = typeof state.customSearchIndex === 'number' ? state.customSearchIndex : null;
      this.customSearch = this.cleanStringRecord(state.customSearch);
      this.customResults = this.cleanSuggestionRecord(state.customResults);
      this.customFallback = this.cleanFallbackRecord(state.customFallback);
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
      if (Number.isInteger(index) && Array.isArray(raw)) result[index] = this.normaliseSuggestions(raw);
    }
    return result;
  }

  private normaliseSuggestions(value: unknown): BringSuggestion[] {
    if (!Array.isArray(value)) return [];
    const suggestions = value
      .filter((suggestion): suggestion is Partial<BringSuggestion> =>
        !!suggestion
        && typeof suggestion === 'object'
        && typeof suggestion.migrosUid === 'number'
        && typeof suggestion.name === 'string')
      .map(suggestion => ({
        migrosUid: suggestion.migrosUid!,
        name: suggestion.name!,
        imageUrl: suggestion.imageUrl,
        weightText: suggestion.weightText,
        price: suggestion.price,
        multiplier: suggestion.multiplier ?? 1,
        relevance: suggestion.relevance ?? 0,
        orderCount: suggestion.orderCount ?? 0,
        matchedQuery: suggestion.matchedQuery ?? '',
        promotionPrice: suggestion.promotionPrice,
        promotionBadgeDescription: suggestion.promotionBadgeDescription,
        available: suggestion.available ?? ((suggestion.promotionPrice ?? suggestion.price) != null)
      }));
    return this.preferFirstAvailable(suggestions);
  }

  private preferFirstAvailable(suggestions: BringSuggestion[]): BringSuggestion[] {
    if (suggestions.length <= 1 || suggestions[0]?.available !== false) return suggestions;

    const firstAvailableIndex = suggestions.findIndex(s => s.available !== false);
    if (firstAvailableIndex <= 0) return suggestions;

    const result = suggestions.slice();
    const [firstAvailable] = result.splice(firstAvailableIndex, 1);
    result.unshift(firstAvailable);
    return result;
  }

  private cleanFallbackRecord(value: unknown): Record<number, CustomFallbackNotice | null> {
    if (!value || typeof value !== 'object') return {};
    const result: Record<number, CustomFallbackNotice | null> = {};
    for (const [key, raw] of Object.entries(value)) {
      const index = Number(key);
      if (!Number.isInteger(index)) continue;
      if (raw === null) {
        result[index] = null;
        continue;
      }
      if (!raw || typeof raw !== 'object') continue;
      const notice = raw as Partial<CustomFallbackNotice>;
      if (typeof notice.originalQuery === 'string' && typeof notice.fallbackQuery === 'string') {
        result[index] = {
          originalQuery: notice.originalQuery,
          fallbackQuery: notice.fallbackQuery
        };
      }
    }
    return result;
  }
}

interface CustomFallbackNotice {
  originalQuery: string;
  fallbackQuery: string;
}

interface BringReviewState {
  items: BringMatch[];
  selectedUid: Record<number, number | null>;
  quantities: Record<number, number>;
  customSearchIndex: number | null;
  customSearch: Record<number, string>;
  customResults: Record<number, BringSuggestion[]>;
  customFallback: Record<number, CustomFallbackNotice | null>;
  message: string;
  error: string;
  savedAt: string;
}
