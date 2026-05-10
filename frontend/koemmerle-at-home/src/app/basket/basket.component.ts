import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { BasketItem, ScanApiService } from '../services/scan-api.service';

export interface Swimlane {
  id: string;
  label: string;
  categories: string[];
}

const STORAGE_KEY = 'basket-swimlanes';
const SIZE_KEY    = 'basket-card-size';

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
  refreshing = false;

  private sub!: Subscription;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.cardSize = parseFloat(localStorage.getItem(SIZE_KEY) ?? '1') || 1;
    this.loadConfig();
    this.refresh();
    this.sub = this.api.queueUpdated$Obs.subscribe(() => this.refresh());
  }

  ngOnDestroy() { this.sub.unsubscribe(); }

  get knownCategories(): string[] {
    return [...new Set(this.basket.map(i => i.category))].sort();
  }

  availableCategories(lane: Swimlane): string[] {
    const usedByOthers = new Set(
      this.swimlanes.filter(l => l.id !== lane.id).flatMap(l => l.categories)
    );
    return this.knownCategories.filter(cat => !usedByOthers.has(cat));
  }

  itemsFor(lane: Swimlane): BasketItem[] {
    if (lane.categories.length === 0) return [];
    return this.basket.filter(i => lane.categories.includes(i.category));
  }

  get uncategorisedItems(): BasketItem[] {
    const assigned = new Set(this.swimlanes.flatMap(l => l.categories));
    return this.basket.filter(i => !assigned.has(i.category));
  }

  addLane() {
    const lane: Swimlane = { id: crypto.randomUUID(), label: 'Neue Swimlane', categories: [] };
    this.swimlanes = [...this.swimlanes, lane];
    this.editingLabelId = lane.id;
    this.saveConfig();
  }

  removeLane(id: string) {
    this.swimlanes = this.swimlanes.filter(l => l.id !== id);
    if (this.openPickerId === id) this.openPickerId = null;
    this.saveConfig();
  }

  toggleCategory(lane: Swimlane, cat: string) {
    const idx = lane.categories.indexOf(cat);
    lane.categories = idx === -1
      ? [...lane.categories, cat]
      : lane.categories.filter(c => c !== cat);
    this.saveConfig();
  }

  togglePicker(id: string, event: MouseEvent) {
    event.stopPropagation();
    this.openPickerId = this.openPickerId === id ? null : id;
  }

  closePickers() { this.openPickerId = null; this.activeItemUid = null; }

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

    this.refreshing = true;
    this.api.getBasket().subscribe({
      next: items => {
        this.basket = items;
        this.ensureDefaultLane();
        this.refreshing = false;
      },
      error: () => { this.refreshing = false; }
    });
  }

  private ensureDefaultLane() {
    if (this.swimlanes.length === 0 && this.knownCategories.length > 0) {
      this.swimlanes = [{
        id: crypto.randomUUID(),
        label: 'Warenkorb',
        categories: [...this.knownCategories]
      }];
      this.saveConfig();
    }
  }

  private loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.swimlanes = JSON.parse(raw);
    } catch { this.swimlanes = []; }
  }

  onSizeChange() {
    localStorage.setItem(SIZE_KEY, String(this.cardSize));
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
  }
}
