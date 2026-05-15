import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/** Returns true when `categories` (pipe-separated) starts with every segment in `filter`. */
export function matchesCategory(categories: string | undefined, filter: string): boolean {
  if (!filter) return true;
  const filterParts = filter.split('|').map(s => s.trim());
  const catParts = (categories ?? '').split('|').map(s => s.trim());
  return filterParts.every((part, i) => catParts[i] === part);
}

/**
 * Renders a series of cascading category-filter dropdowns.
 * Each deeper level only shows sub-categories of the selection above it.
 *
 * Use with two-way binding: <app-category-filter [items]="items" [(value)]="categoryFilter" />
 * `value` is a pipe-joined path, e.g. "Milchprodukte|Joghurt".
 */
@Component({
  selector: 'app-category-filter',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    :host { display: contents; }
    select {
      padding: 0.4rem 0.6rem;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 0.875rem;
      background: white;
      cursor: pointer;
    }
  `],
  template: `
    @for (opts of levels; track $index; let i = $index) {
      <select [ngModel]="selections[i] ?? ''" (ngModelChange)="onSelect(i, $event)">
        <option value="">{{ i === 0 ? 'Alle Kategorien' : 'Alle' }}</option>
        @for (cat of opts; track cat) {
          <option [value]="cat">{{ cat }}</option>
        }
      </select>
    }
  `
})
export class CategoryFilterComponent implements OnChanges {
  @Input() items: { categories?: string }[] = [];
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();

  selections: string[] = [];

  ngOnChanges(changes: SimpleChanges) {
    if (changes['value']) {
      const val = (changes['value'].currentValue as string) ?? '';
      this.selections = val ? val.split('|').map(s => s.trim()) : [];
    }
  }

  /** Computes the list of options available at each visible depth. */
  get levels(): string[][] {
    const result: string[][] = [];

    for (let depth = 0; ; depth++) {
      // Items that match all selections made so far
      const filtered = this.items.filter(item => {
        const parts = item.categories?.split('|').map(s => s.trim()) ?? [];
        for (let i = 0; i < depth; i++) {
          if (parts[i] !== this.selections[i]) return false;
        }
        return true;
      });

      const segments = new Set<string>();
      for (const item of filtered) {
        const seg = item.categories?.split('|')[depth]?.trim();
        if (seg) segments.add(seg);
      }

      if (segments.size === 0) break;
      result.push([...segments].sort());

      // Don't show the next level unless this one has a selection
      if (!this.selections[depth]) break;
    }

    // Always render at least the top-level select so the user sees the filter
    if (result.length === 0) result.push([]);

    return result;
  }

  onSelect(depth: number, value: string) {
    if (value) {
      this.selections = [...this.selections.slice(0, depth), value];
    } else {
      this.selections = this.selections.slice(0, depth);
    }
    this.valueChange.emit(this.selections.join('|'));
  }
}
