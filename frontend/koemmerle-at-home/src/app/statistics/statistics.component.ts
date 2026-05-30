import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Chart, BarController, BarElement, CategoryScale, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import { ScanApiService, OrderStat, ProductHistory, ProductHistoryPeriod } from '../services/scan-api.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

Chart.register(BarController, BarElement, CategoryScale, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip);

@Component({
  selector: 'app-statistics',
  imports: [CommonModule, FormsModule, RouterModule, CategoryFilterComponent],
  templateUrl: './statistics.component.html',
  styleUrl: './statistics.component.scss'
})
export class StatisticsComponent implements OnInit, OnDestroy {
  @ViewChild('historyCanvas') set historyCanvasRef(ref: ElementRef<HTMLCanvasElement> | undefined) {
    this.historyCanvas = ref;
    if (ref && this.history.length) this.buildHistoryChart();
  }
  @ViewChild('hoverCanvas') set hoverCanvasRef(ref: ElementRef<HTMLCanvasElement> | undefined) {
    this.hoverCanvas = ref;
    if (ref && this.hoverHistory.length) this.buildHoverChart();
  }

  stats: OrderStat[] = [];
  loading = false;

  dateFrom = this.toDateStr(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  dateTo = this.toDateStr(new Date());
  categoryFilter = '';
  sortCol: 'count' | 'weight' = 'count';
  sortDir: 1 | -1 = -1;

  selected = new Set<string>();
  private readonly maxSelectedProducts = 5;
  history: ProductHistory[] = [];
  historyPeriod: ProductHistoryPeriod = 'month';
  historyLoading = false;
  historyError = '';
  private historyCanvas?: ElementRef<HTMLCanvasElement>;
  private historyChart: Chart | null = null;
  hoverStat: OrderStat | null = null;
  hoverHistory: ProductHistory[] = [];
  hoverLoading = false;
  hoverError = '';
  private hoverCanvas?: ElementRef<HTMLCanvasElement>;
  private hoverChart: Chart | null = null;
  private hoverRequestId = 0;
  private readonly palette = ['#ff6600', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#475569'];

  constructor(private api: ScanApiService) {}

  ngOnInit() { this.load(); }

  ngOnDestroy() {
    this.historyChart?.destroy();
    this.hoverChart?.destroy();
  }

  load() {
    this.loading = true;
    this.clearSelection();
    this.hideProductPreview();
    this.api.getOrderStats(this.dateFrom, this.dateTo).subscribe({
      next: s => {
        this.stats = s.map((stat, index) => ({
          ...stat,
          productKey: stat.productKey || `legacy:${stat.productId ?? stat.productName}:${index}`
        }));
        this.loading = false;
      },
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

  isSelected(s: OrderStat): boolean {
    return this.selected.has(s.productKey);
  }

  toggleSelect(s: OrderStat) {
    if (this.selected.has(s.productKey)) this.selected.delete(s.productKey);
    else {
      if (this.selected.size >= this.maxSelectedProducts) {
        const oldest = this.selected.values().next().value;
        if (oldest) this.selected.delete(oldest);
      }
      this.selected.add(s.productKey);
    }
    this.loadHistory();
  }

  clearSelection() {
    this.selected.clear();
    this.history = [];
    this.historyLoading = false;
    this.historyError = '';
    this.historyChart?.destroy();
    this.historyChart = null;
  }

  setHistoryPeriod(period: ProductHistoryPeriod) {
    if (this.historyPeriod === period) return;
    this.historyPeriod = period;
    this.loadHistory();
    if (this.hoverStat) this.showProductPreview(this.hoverStat);
  }

  showAllOrders() {
    this.api.getOrderRange().subscribe({
      next: range => {
        if (!range.firstOrderDate || !range.lastOrderDate) return;
        this.dateFrom = this.toDateStr(new Date(range.firstOrderDate));
        this.dateTo = this.toDateStr(new Date(range.lastOrderDate));
        this.load();
      }
    });
  }

  showProductPreview(s: OrderStat) {
    this.hoverRequestId++;
    const requestId = this.hoverRequestId;
    this.hoverStat = s;
    this.hoverHistory = [];
    this.hoverLoading = true;
    this.hoverError = '';
    this.hoverChart?.destroy();
    this.hoverChart = null;

    this.api.getProductHistory([s.productKey], this.dateFrom, this.dateTo, this.historyPeriod).subscribe({
      next: history => {
        if (requestId !== this.hoverRequestId) return;
        this.hoverHistory = history;
        this.hoverLoading = false;
        this.buildHoverChart();
      },
      error: err => {
        if (requestId !== this.hoverRequestId) return;
        this.hoverHistory = [];
        this.hoverLoading = false;
        this.hoverError = `HTTP ${err.status}`;
      }
    });
  }

  hideProductPreview() {
    this.hoverRequestId++;
    this.hoverStat = null;
    this.hoverHistory = [];
    this.hoverLoading = false;
    this.hoverError = '';
    this.hoverChart?.destroy();
    this.hoverChart = null;
  }

  private loadHistory() {
    const productKeys = [...this.selected];
    this.historyChart?.destroy();
    this.historyChart = null;

    if (!productKeys.length) {
      this.history = [];
      this.historyLoading = false;
      this.historyError = '';
      return;
    }

    this.historyLoading = true;
    this.historyError = '';
    this.api.getProductHistory(productKeys, this.dateFrom, this.dateTo, this.historyPeriod).subscribe({
      next: history => {
        this.history = history;
        this.historyLoading = false;
        this.buildHistoryChart();
      },
      error: err => {
        this.history = [];
        this.historyLoading = false;
        this.historyError = `HTTP ${err.status} – ${err.message}`;
      }
    });
  }

  private buildHistoryChart() {
    if (!this.historyCanvas || !this.history.length) return;
    this.historyChart?.destroy();
    this.historyChart = this.createHistoryChart(this.historyCanvas.nativeElement, this.history, false);
  }

  private buildHoverChart() {
    if (!this.hoverCanvas || !this.hoverHistory.length) return;
    this.hoverChart?.destroy();
    this.hoverChart = this.createHistoryChart(this.hoverCanvas.nativeElement, this.hoverHistory, true);
  }

  private createHistoryChart(canvas: HTMLCanvasElement, history: ProductHistory[], compact: boolean): Chart {
    const datasets: any[] = [];
    const allXValues: number[] = [];

    history.forEach((series, index) => {
      const color = this.palette[index % this.palette.length];
      const priceColor = this.darkenHexColor(color, 38);
      const orderPoints = this.orderPointsOf(series);
      const pricePoints = this.pricePointsOf(series);

      allXValues.push(
        ...orderPoints.map(point => this.toTimestamp(point.periodStart)),
        ...pricePoints.map(point => this.toTimestamp(point.orderDate))
      );

      datasets.push({
        type: 'bar',
        label: `${series.productName} · Bestellungen`,
        data: orderPoints.map(point => ({
          x: this.toTimestamp(point.periodStart),
          y: point.orderCount
        })),
        backgroundColor: color,
        borderRadius: 4,
        borderSkipped: false,
        barThickness: compact ? 8 : this.historyPeriod === 'quarter' ? 28 : this.historyPeriod === 'month' ? 18 : 10,
        order: 10,
        yAxisID: 'y'
      });
      datasets.push({
        type: 'line',
        label: `${series.productName} · Preis`,
        data: pricePoints.map(point => ({
          x: this.toTimestamp(point.orderDate),
          y: point.unitPrice
        })),
        borderColor: priceColor,
        backgroundColor: priceColor,
        borderWidth: compact ? 2 : 2.5,
        pointRadius: compact ? 2 : 3,
        pointHoverRadius: compact ? 4 : 5,
        spanGaps: true,
        tension: 0.25,
        order: 0,
        yAxisID: 'price'
      });
    });

    return new Chart(canvas, {
      type: 'bar',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        transitions: {
          active: { animation: { duration: 0 } },
          resize: { animation: { duration: 0 } },
          show: { animations: {} },
          hide: { animations: {} }
        },
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: !compact, position: 'bottom' },
          tooltip: {
            mode: 'nearest',
            callbacks: {
              title: items => items.length && items[0].parsed.x != null ? this.formatTimelineLabel(items[0].parsed.x) : '',
              label: context => {
                const label = context.dataset.label ?? '';
                const value = context.parsed.y;
                if (context.dataset.yAxisID === 'price') {
                  return value == null ? `${label}: –` : `${label}: CHF ${value.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
                return `${label}: ${value}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: allXValues.length ? Math.min(...allXValues) : undefined,
            max: allXValues.length ? Math.max(...allXValues) : undefined,
            grid: { display: false },
            ticks: {
              maxTicksLimit: compact ? 4 : 8,
              callback: value => this.formatTimelineLabel(Number(value))
            }
          },
          y: {
            beginAtZero: true,
            title: { display: !compact, text: 'Bestellungen' },
            ticks: { precision: 0 }
          },
          price: {
            beginAtZero: true,
            position: 'right',
            title: { display: !compact, text: 'Preis (CHF)' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  }

  private darkenHexColor(hex: string, percent: number): string {
    const clean = hex.replace('#', '');
    const factor = (100 - percent) / 100;
    const parts = [0, 2, 4].map(start => {
      const value = Math.round(parseInt(clean.slice(start, start + 2), 16) * factor);
      return value.toString(16).padStart(2, '0');
    });
    return `#${parts.join('')}`;
  }

  private orderPointsOf(series: ProductHistory) {
    return series.orderPoints ?? (series as any).points ?? [];
  }

  private pricePointsOf(series: ProductHistory) {
    return series.pricePoints ?? ((series as any).points ?? [])
      .filter((point: any) => point.unitPrice != null)
      .map((point: any) => ({ orderDate: point.periodStart, unitPrice: point.unitPrice }));
  }

  private toTimestamp(value: string): number {
    return new Date(value).getTime();
  }

  private formatTimelineLabel(value: number): string {
    const date = new Date(value);
    if (this.historyPeriod === 'biweekly') {
      return date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
    }
    if (this.historyPeriod === 'quarter') {
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return `Q${quarter} ${date.getFullYear().toString().slice(-2)}`;
    }
    return date.toLocaleDateString('de-CH', { month: 'short', year: '2-digit' });
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

  private toDateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
