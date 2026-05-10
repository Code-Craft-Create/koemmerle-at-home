import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ScanApiService, RecipeDto, RecipeExportDocument } from '../services/scan-api.service';

@Component({
  selector: 'app-recipes',
  imports: [CommonModule, FormsModule],
  templateUrl: './recipes.component.html',
  styleUrl: './recipes.component.scss'
})
export class RecipesComponent implements OnInit {
  recipes: RecipeDto[] = [];
  selectedIds = new Set<number>();
  message = '';
  error = '';
  busy = false;

  newBarcode = '';
  newName = '';
  showNewForm = false;

  constructor(private api: ScanApiService, private router: Router) {}

  ngOnInit() {
    this.loadRecipes();
  }

  loadRecipes() {
    this.api.getRecipes().subscribe(r => {
      this.recipes = r;
      this.selectedIds = new Set([...this.selectedIds].filter(id => r.some(recipe => recipe.id === id)));
    });
  }

  goToDetail(id: number) {
    this.router.navigate(['/recipes', id]);
  }

  get selectedCount(): number {
    return this.selectedIds.size;
  }

  get allSelected(): boolean {
    return this.recipes.length > 0 && this.recipes.every(r => this.selectedIds.has(r.id));
  }

  toggleAll(checked: boolean) {
    this.selectedIds = checked ? new Set(this.recipes.map(r => r.id)) : new Set();
  }

  toggleRecipe(id: number, checked: boolean) {
    const next = new Set(this.selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    this.selectedIds = next;
  }

  createRecipe() {
    if (!this.newBarcode.trim() || !this.newName.trim()) return;
    this.api.createRecipe(this.newBarcode.trim(), this.newName.trim()).subscribe(r => {
      this.router.navigate(['/recipes', r.id]);
    });
  }

  delete(event: Event, id: number, name: string) {
    event.stopPropagation();
    if (!confirm(`Rezept "${name}" löschen?`)) return;
    this.api.deleteRecipe(id).subscribe(() => {
      this.recipes = this.recipes.filter(r => r.id !== id);
      this.selectedIds.delete(id);
    });
  }

  exportSelected() {
    const ids = [...this.selectedIds];
    if (ids.length === 0 || this.busy) return;

    this.busy = true;
    this.message = '';
    this.error = '';
    this.api.exportRecipes(ids).subscribe({
      next: document => {
        this.downloadJson(document);
        this.message = `${document.recipes.length} Rezept(e) exportiert.`;
        this.busy = false;
      },
      error: () => {
        this.error = 'Export fehlgeschlagen.';
        this.busy = false;
      }
    });
  }

  importFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy) return;

    this.busy = true;
    this.message = '';
    this.error = '';

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const document = JSON.parse(String(reader.result)) as RecipeExportDocument;
        this.api.importRecipes(document).subscribe({
          next: result => {
            this.message = `${result.imported} importiert, ${result.updated} aktualisiert` +
              (result.skippedProducts ? `, ${result.skippedProducts} Produkt(e) übersprungen.` : '.');
            this.busy = false;
            this.loadRecipes();
          },
          error: () => {
            this.error = 'Import fehlgeschlagen. Prüfe, ob die Datei ein KoemmerleAtHome-Rezept-Export ist.';
            this.busy = false;
          }
        });
      } catch {
        this.error = 'Die ausgewählte Datei ist kein gültiges JSON.';
        this.busy = false;
      }
    };
    reader.onerror = () => {
      this.error = 'Datei konnte nicht gelesen werden.';
      this.busy = false;
    };
    reader.readAsText(file);
  }

  private downloadJson(document: RecipeExportDocument) {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `koemmerleathome-recipes-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
