import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ScanApiService, Product } from '../services/scan-api.service';

@Component({
  selector: 'app-product-detail',
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './product-detail.component.html',
  styleUrl: './product-detail.component.scss'
})
export class ProductDetailComponent implements OnInit {
  product: Product | null = null;
  loading = true;
  saving = false;
  syncing = false;
  message = '';
  messageIsError = false;

  // Editable draft
  draft = {
    name: '',
    barcodes: '',
    weightText: '',
    weightMinGrams: null as number | null,
    weightMaxGrams: null as number | null,
    weightUnit: '',
    price: null as number | null,
    categories: '',
  };

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ScanApiService,
  ) {}

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.api.getProduct(id).subscribe({
      next: p => { this.product = p; this.toDraft(p); this.loading = false; },
      error: () => { this.loading = false; this.showMsg('Produkt nicht gefunden', true); }
    });
  }

  toDraft(p: Product) {
    this.draft = {
      name: p.name,
      barcodes: p.barcodes,
      weightText: p.weightText ?? '',
      weightMinGrams: p.weightMinGrams ?? null,
      weightMaxGrams: p.weightMaxGrams ?? null,
      weightUnit: p.weightUnit ?? '',
      price: p.price ?? null,
      categories: p.categories ?? '',
    };
  }

  get categoryList(): string[] {
    return this.product?.categories?.split('|').map(s => s.trim()).filter(Boolean) ?? [];
  }

  save() {
    if (!this.product) return;
    this.saving = true;
    this.api.updateProduct(this.product.id, {
      name: this.draft.name,
      barcodes: this.draft.barcodes,
      weightText: this.draft.weightText || undefined,
      weightMinGrams: this.draft.weightMinGrams ?? undefined,
      weightMaxGrams: this.draft.weightMaxGrams ?? undefined,
      weightUnit: this.draft.weightUnit || undefined,
      price: this.draft.price ?? undefined,
      categories: this.draft.categories || undefined,
    }).subscribe({
      next: p => { this.product = p; this.toDraft(p); this.saving = false; this.showMsg('Gespeichert'); },
      error: () => { this.saving = false; this.showMsg('Speichern fehlgeschlagen', true); }
    });
  }

  sync() {
    if (!this.product) return;
    this.syncing = true;
    this.api.syncProduct(this.product.id).subscribe({
      next: p => { this.product = p; this.toDraft(p); this.syncing = false; this.showMsg('Sync abgeschlossen'); },
      error: () => { this.syncing = false; this.showMsg('Sync fehlgeschlagen', true); }
    });
  }

  private showMsg(text: string, isError = false) {
    this.message = text;
    this.messageIsError = isError;
    setTimeout(() => { if (this.message === text) this.message = ''; }, 3000);
  }
}
