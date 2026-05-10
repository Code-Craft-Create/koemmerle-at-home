import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ScanApiService, OrderStat } from '../services/scan-api.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

@Component({
  selector: 'app-statistics',
  imports: [CommonModule, FormsModule, RouterModule, CategoryFilterComponent],
  templateUrl: './statistics.component.html',
  styleUrl: './statistics.component.scss'
})
export class StatisticsComponent implements OnInit {
  stats: OrderStat[] = [];
  loading = false;

  dateFrom = this.toDateStr(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  dateTo = this.toDateStr(new Date());
  categoryFilter = '';
  sortCol: 'count' | 'weight' = 'count';
  sortDir: 1 | -1 = -1;

  showDebug = false;
  debug: any = null;
  debugError = '';
  debugLoading = false;

  constructor(private api: ScanApiService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.api.getOrderStats(this.dateFrom, this.dateTo).subscribe({
      next: s => { this.stats = s; this.loading = false; },
      error: () => { this.loading = false; }
    });
  }

  get filtered(): OrderStat[] {
    return this.stats
      .filter(s => matchesCategory(s.categories, this.categoryFilter))
      .sort((a, b) => {
        const va = this.sortCol === 'count' ? a.totalQuantity : (a.totalWeightGrams ?? -1);
        const vb = this.sortCol === 'count' ? b.totalQuantity : (b.totalWeightGrams ?? -1);
        return (va - vb) * this.sortDir;
      });
  }

  setSort(col: 'count' | 'weight') {
    if (this.sortCol === col) this.sortDir = this.sortDir === 1 ? -1 : 1;
    else { this.sortCol = col; this.sortDir = -1; }
  }

  get totalItems(): number {
    return this.filtered.reduce((sum, s) => sum + s.totalQuantity, 0);
  }

  get totalWeightGrams(): number | null {
    const items = this.filtered.filter(s => s.totalWeightGrams != null);
    if (!items.length) return null;
    return items.reduce((sum, s) => sum + s.totalWeightGrams!, 0);
  }

  formatWeight(grams: number | null | undefined): string {
    if (grams == null) return '–';
    if (grams >= 1000) return (grams / 1000).toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' kg';
    return Math.round(grams).toLocaleString('de-CH') + ' g';
  }

  categoryList(s: OrderStat): string[] {
    return s.categories?.split('|').map(c => c.trim()).filter(Boolean) ?? [];
  }

  loadDebug() {
    this.debugLoading = true;
    this.debugError = '';
    this.api.getStatisticsDebug(this.dateFrom, this.dateTo).subscribe({
      next: d => {
        console.log('[Statistics debug]', d);
        this.debug = d;
        this.debugLoading = false;
      },
      error: err => {
        console.error('[Statistics debug error]', err);
        this.debugError = `HTTP ${err.status} – ${err.message}`;
        this.debugLoading = false;
      }
    });
  }

  toggleDebug() {
    this.showDebug = !this.showDebug;
    if (this.showDebug && !this.debug) this.loadDebug();
  }

  private toDateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
