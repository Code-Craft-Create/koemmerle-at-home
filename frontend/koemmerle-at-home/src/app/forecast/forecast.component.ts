import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip } from 'chart.js';
import { ScanApiService, ForecastItem, MonthlyTotal } from '../services/scan-api.service';
import { CategoryFilterComponent, matchesCategory } from '../shared/category-filter.component';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

@Component({
  selector: 'app-forecast',
  standalone: true,
  imports: [CommonModule, RouterModule, CategoryFilterComponent],
  templateUrl: './forecast.component.html',
  styleUrl: './forecast.component.scss'
})
export class ForecastComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;

  forecast: ForecastItem[] = [];
  monthly: MonthlyTotal[] = [];
  loading = false;
  enqueueing = false;
  enqueueResult: string | null = null;
  categoryFilter = '';
  period: 'month' | 'biweekly' = 'month';
  selected = new Set<string>();
  private chart: Chart | null = null;
  private monthlyReady = false;
  private viewReady = false;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.loading = true;
    this.api.getForecast().subscribe({
      next: data => { this.forecast = data; this.loading = false; },
      error: () => { this.loading = false; }
    });
    this.loadMonthly();
  }

  ngAfterViewInit() {
    this.viewReady = true;
    if (this.monthlyReady) this.buildChart();
  }

  ngOnDestroy() { this.chart?.destroy(); }

  setPeriod(p: 'month' | 'biweekly') {
    if (this.period === p) return;
    this.period = p;
    this.monthlyReady = false;
    this.loadMonthly();
  }

  private loadMonthly() {
    this.api.getMonthlyTotals(this.period).subscribe({
      next: data => {
        this.monthly = data;
        this.monthlyReady = true;
        if (this.viewReady) this.buildChart();
      }
    });
  }

  get filtered(): ForecastItem[] {
    return this.forecast.filter(f => matchesCategory(f.categories, this.categoryFilter));
  }

  categoryList(f: ForecastItem): string[] {
    return f.categories?.split('|').map(c => c.trim()).filter(Boolean) ?? [];
  }

  buildChart() {
    if (!this.chartCanvas) return;
    this.chart?.destroy();
    const sliceCount = this.period === 'biweekly' ? 26 : 12;
    const data = this.monthly.slice(-sliceCount);
    const labels = data.map(m => {
      if (this.period === 'biweekly') {
        const start = new Date(m.month);
        const end = new Date(start);
        end.setDate(end.getDate() + 13);
        const fmt = (d: Date) => d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
        return `${fmt(start)}–${fmt(end)}`;
      }
      const [year, month] = m.month.split('-');
      return new Date(+year, +month - 1, 1).toLocaleDateString('de-CH', { month: 'short', year: '2-digit' });
    });
    this.chart = new Chart(this.chartCanvas.nativeElement, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Bestellte Einheiten',
          data: data.map(m => m.totalQuantity),
          backgroundColor: '#ff6600',
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index' } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });
  }

  urgencyClass(f: ForecastItem): string {
    if (f.daysUntilNeeded === null) return 'badge-unknown';
    if (f.daysUntilNeeded <= 0)    return 'badge-overdue';
    if (f.daysUntilNeeded <= 7)    return 'badge-soon';
    if (f.daysUntilNeeded <= 14)   return 'badge-medium';
    return 'badge-ok';
  }

  urgencyLabel(f: ForecastItem): string {
    if (f.daysUntilNeeded === null) return '—';
    if (f.daysUntilNeeded <= 0)    return 'Heute / Überfällig';
    return `${Math.round(f.daysUntilNeeded)} Tage`;
  }

  formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  formatInterval(days: number | null): string {
    if (days === null) return '—';
    return `ca. alle ${Math.round(days)} Tage`;
  }

  isSelected(f: ForecastItem): boolean {
    return !!f.firstBarcode && this.selected.has(f.firstBarcode);
  }

  toggleSelect(f: ForecastItem) {
    if (!f.firstBarcode) return;
    if (this.selected.has(f.firstBarcode)) this.selected.delete(f.firstBarcode);
    else this.selected.add(f.firstBarcode);
  }

  selectAllDue() {
    this.forecast
      .filter(f => f.daysUntilNeeded !== null && f.daysUntilNeeded <= 0 && f.firstBarcode)
      .forEach(f => this.selected.add(f.firstBarcode!));
  }

  clearSelection() {
    this.selected.clear();
  }

  get dueCount(): number {
    return this.forecast.filter(f => f.daysUntilNeeded !== null && f.daysUntilNeeded <= 0 && f.firstBarcode).length;
  }

  enqueueSelected() {
    const barcodes = [...this.selected];
    if (!barcodes.length) return;
    this.enqueueing = true;
    this.enqueueResult = null;
    this.api.enqueueForecast(barcodes).subscribe({
      next: res => {
        this.enqueueing = false;
        this.selected.clear();
        this.enqueueResult = res.enqueued > 0
          ? `${res.enqueued} Produkt${res.enqueued === 1 ? '' : 'e'} in Warteschlange`
          : 'Keine Produkte konnten eingereiht werden';
        setTimeout(() => this.enqueueResult = null, 4000);
      },
      error: () => {
        this.enqueueing = false;
        this.enqueueResult = 'Fehler beim Einreihen';
        setTimeout(() => this.enqueueResult = null, 4000);
      }
    });
  }
}
