import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { BasketItem, BasketSwimlane, ScanApiService } from '../services/scan-api.service';

export type Swimlane = BasketSwimlane;

const STORAGE_KEY = 'basket-swimlanes';
const SIZE_KEY    = 'basket-card-size';
const SHOW_PRICES_KEY = 'basket-show-prices';
const SHOW_QUANTITY_KEY = 'basket-show-quantity';

const DEFAULT_SWIMLANES: Swimlane[] = [
  {
    id: 'fruechte-gemuese',
    label: 'Früchte & Gemüse',
    categories: ['Früchte & Gemüse']
  },
  {
    id: 'milch-fleisch',
    label: 'Milch & Fleisch',
    categories: [
      'Fleisch & Fisch',
      'Milchprodukte Eier & frische Fertiggerichte'
    ]
  },
  {
    id: 'andere-lebensmittel',
    label: 'Andere Lebensmittel',
    categories: [
      'Tiefkühlprodukte',
      'Wein Bier & Spirituosen',
      'Snacks & Süssigkeiten',
      'Getränke Kaffee & Tee',
      'Pasta Würzmittel & Konserven',
      'Brot Backwaren & Frühstück'
    ]
  },
  {
    id: 'diverses',
    label: 'Diverses',
    categories: [
      'Andere',
      'Bekleidung & Accessoires',
      'Drogerie & Kosmetik',
      'Haushalt & Wohnen',
      'Baby & Kinder',
      'Waschen & Putzen',
      'Tierbedarf'
    ]
  }
];

@Component({
  selector: 'app-basket',
  imports: [CommonModule, FormsModule],
  templateUrl: './basket.component.html',
  styleUrl: './basket.component.scss'
})
export class BasketComponent implements OnInit, OnDestroy {
  basket: BasketItem[] = [];
  swimlanes: Swimlane[] = [];
  cardSize = 1;
  openPickerId: string | null = null;
  editingLabelId: string | null = null;
  activeItemUid: string | null = null;
  actionsMenuOpen = false;
  refreshing = false;
  showPrices = true;
  showQuantity = true;

  private sub!: Subscription;
  private loadingConfig = false;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.cardSize = parseFloat(localStorage.getItem(SIZE_KEY) ?? '1') || 1;
    this.showPrices = localStorage.getItem(SHOW_PRICES_KEY) !== 'false';
    this.showQuantity = localStorage.getItem(SHOW_QUANTITY_KEY) !== 'false';
    this.loadConfig();
    this.refresh();
    this.sub = this.api.queueUpdated$Obs.subscribe(() => this.refresh());
  }

  ngOnDestroy() { this.sub.unsubscribe(); }

  get knownCategories(): string[] {
    return [...new Set(this.basket.map(i => i.category))].sort();
  }

  availableCategories(lane: Swimlane): string[] {
    return [...new Set([...this.knownCategories, ...lane.categories])].sort();
  }

  itemsFor(lane: Swimlane): BasketItem[] {
    if (lane.categories.length === 0) return [];
    return this.basket.filter(i => lane.categories.includes(i.category));
  }

  get uncategorisedItems(): BasketItem[] {
    const assigned = new Set(this.swimlanes.flatMap(l => l.categories));
    return this.basket.filter(i => !assigned.has(i.category));
  }

  basketTotalPrice(): number {
    return this.basket.reduce((sum, item) => {
      const price = item.promotionPrice ?? item.price;
      return sum + (price == null ? 0 : price * item.quantity);
    }, 0);
  }

  basketHasMissingPrices(): boolean {
    return this.basket.some(item => (item.promotionPrice ?? item.price) == null);
  }

  addLane(event?: MouseEvent) {
    event?.stopPropagation();
    const lane: Swimlane = { id: crypto.randomUUID(), label: 'Neue Spalte', categories: [] };
    this.swimlanes = [...this.swimlanes, lane];
    this.editingLabelId = lane.id;
    this.actionsMenuOpen = false;
    this.saveConfig();
  }

  removeLane(id: string) {
    this.swimlanes = this.swimlanes.filter(l => l.id !== id);
    if (this.openPickerId === id) this.openPickerId = null;
    this.saveConfig();
  }

  toggleCategory(lane: Swimlane, cat: string) {
    const ownsCategory = lane.categories.includes(cat);
    this.swimlanes = this.swimlanes.map(current => {
      if (current.id === lane.id) {
        return {
          ...current,
          categories: ownsCategory
            ? current.categories.filter(c => c !== cat)
            : [...new Set([...current.categories, cat])]
        };
      }

      return {
        ...current,
        categories: current.categories.filter(c => c !== cat)
      };
    });
    this.saveConfig();
  }

  togglePicker(id: string, event: MouseEvent) {
    event.stopPropagation();
    this.openPickerId = this.openPickerId === id ? null : id;
  }

  toggleActionsMenu(event: MouseEvent) {
    event.stopPropagation();
    this.actionsMenuOpen = !this.actionsMenuOpen;
  }

  closePickers() {
    this.openPickerId = null;
    this.activeItemUid = null;
    this.actionsMenuOpen = false;
  }

  toggleItem(uid: string, event: MouseEvent) {
    event.stopPropagation();
    this.activeItemUid = this.activeItemUid === uid ? null : uid;
  }

  onQuantityControlClick(uid: string, event: MouseEvent) {
    if (this.activeItemUid === uid) event.stopPropagation();
  }

  startEditLabel(id: string, event: MouseEvent) {
    event.stopPropagation();
    this.editingLabelId = id;
  }

  commitLabel() { this.editingLabelId = null; this.saveConfig(); }

  refresh(event?: MouseEvent) {
    event?.stopPropagation();
    if (this.refreshing) return;

    this.actionsMenuOpen = false;
    this.refreshing = true;
    this.api.getBasket().subscribe({
      next: items => {
        this.basket = items;
        this.refreshing = false;
      },
      error: () => { this.refreshing = false; }
    });
  }

  resetToDefault(event?: MouseEvent) {
    event?.stopPropagation();
    const defaults = this.cloneDefaultSwimlanes();
    this.swimlanes = defaults;
    this.openPickerId = null;
    this.editingLabelId = null;
    this.actionsMenuOpen = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    this.api.resetBasketSwimlanes().subscribe({
      next: swimlanes => this.swimlanes = this.normaliseSwimlanes(swimlanes, defaults),
      error: () => {}
    });
  }

  private loadConfig() {
    this.loadingConfig = true;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.swimlanes = raw
        ? this.normaliseSwimlanes(JSON.parse(raw), this.cloneDefaultSwimlanes())
        : this.cloneDefaultSwimlanes();
    } catch { this.swimlanes = this.cloneDefaultSwimlanes(); }

    this.api.getBasketSwimlanes().subscribe({
      next: swimlanes => {
        this.swimlanes = this.normaliseSwimlanes(swimlanes, this.cloneDefaultSwimlanes());
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.swimlanes));
        this.loadingConfig = false;
      },
      error: () => { this.loadingConfig = false; }
    });
  }

  onSizeChange() {
    localStorage.setItem(SIZE_KEY, String(this.cardSize));
  }

  toggleShowPrices(enabled: boolean) {
    this.showPrices = enabled;
    localStorage.setItem(SHOW_PRICES_KEY, String(enabled));
  }

  toggleShowQuantity(enabled: boolean) {
    this.showQuantity = enabled;
    localStorage.setItem(SHOW_QUANTITY_KEY, String(enabled));
  }

  adjustQuantity(item: BasketItem, delta: number) {
    const next = item.quantity + delta;
    if (next < 0) return;
    const prev = item.quantity;
    item.quantity = next;
    this.api.setBasketQuantity(item.uid, next).subscribe({
      next: () => {
        if (next === 0) this.basket = this.basket.filter(i => i.uid !== item.uid);
      },
      error: () => { item.quantity = prev; }
    });
  }

  private saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.swimlanes));
    if (this.loadingConfig) return;

    this.api.saveBasketSwimlanes(this.swimlanes).subscribe({
      next: swimlanes => {
        this.swimlanes = this.normaliseSwimlanes(swimlanes, this.swimlanes);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.swimlanes));
      },
      error: () => {}
    });
  }

  private cloneDefaultSwimlanes(): Swimlane[] {
    return DEFAULT_SWIMLANES.map(lane => ({
      ...lane,
      categories: [...lane.categories]
    }));
  }

  private normaliseSwimlanes(value: unknown, fallback: Swimlane[]): Swimlane[] {
    if (!Array.isArray(value)) return fallback;

    return value
      .filter((lane): lane is Partial<Swimlane> => !!lane && typeof lane === 'object')
      .map(lane => ({
        id: typeof lane.id === 'string' && lane.id.trim() ? lane.id.trim() : crypto.randomUUID(),
        label: typeof lane.label === 'string' && lane.label.trim() ? lane.label.trim() : 'Neue Spalte',
        categories: Array.isArray(lane.categories)
          ? [...new Set(lane.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(c => c.trim()))]
          : []
      }));
  }
}
