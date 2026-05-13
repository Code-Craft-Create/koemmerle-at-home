import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScanApiService } from '../services/scan-api.service';

@Component({
  selector: 'app-settings',
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  sessionStatus: { isLoggedIn: boolean; expiresAt: string | null; expiresInSec: number | null } | null = null;
  tokenInput = '';
  tokenMessage = '';
  thumbnailSyncing = false;
  thumbnailResult = '';
  autoUpdateOrders = true;
  autoUpdateSaving = false;
  settingsMessage = '';
  Math = Math;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.refreshSessionStatus();
    this.api.getSettings().subscribe(s => this.autoUpdateOrders = s.autoUpdateOrders);
  }

  refreshSessionStatus() {
    this.api.getMigrosSession().subscribe(s => this.sessionStatus = s);
  }

  startLogin() {
    this.api.startMigrosLogin().subscribe({
      next: () => {
        this.tokenMessage = 'Browser geöffnet — nach dem Login wird das Token automatisch erfasst.';
        setTimeout(() => this.refreshSessionStatus(), 5000);
      },
      error: () => { this.tokenMessage = 'Fehler beim Starten des Browsers'; }
    });
  }

  saveToken() {
    const token = this.tokenInput.trim().replace(/^Bearer\s+/i, '');
    if (!token) return;
    this.api.setMigrosToken(token).subscribe({
      next: () => {
        this.tokenMessage = 'Token gespeichert';
        this.tokenInput = '';
        this.refreshSessionStatus();
      },
      error: () => { this.tokenMessage = 'Fehler beim Speichern'; }
    });
  }

  syncThumbnails() {
    this.thumbnailSyncing = true;
    this.thumbnailResult = '';
    this.api.syncThumbnails().subscribe({
      next: r => {
        const status = r.cancelled ? 'Abgebrochen' : 'Fertig';
        this.thumbnailResult = `${status}: ${r.synced} geladen, ${r.failed} fehlgeschlagen.`;
        this.thumbnailSyncing = false;
      },
      error: () => {
        this.thumbnailResult = 'Fehler beim Synchronisieren.';
        this.thumbnailSyncing = false;
      }
    });
  }

  toggleAutoUpdateOrders(enabled: boolean) {
    this.autoUpdateOrders = enabled;
    this.autoUpdateSaving = true;
    this.settingsMessage = '';
    this.api.setAutoUpdateOrders(enabled).subscribe({
      next: s => {
        this.autoUpdateOrders = s.autoUpdateOrders;
        this.autoUpdateSaving = false;
        this.settingsMessage = 'Einstellung gespeichert.';
      },
      error: () => {
        this.autoUpdateOrders = !enabled;
        this.autoUpdateSaving = false;
        this.settingsMessage = 'Einstellung konnte nicht gespeichert werden.';
      }
    });
  }

  deleteAllProducts() {
    if (!confirm('Bist du sicher, dass du ALLE Produktdaten löschen möchtest? Dies kann nicht rückgängig gemacht werden.')) return;
    this.api.deleteAllProducts().subscribe(() => alert('Alle Produkte wurden gelöscht.'));
  }

  deleteAllOrders() {
    if (!confirm('Bist du sicher, dass du ALLE Bestelldaten löschen möchtest? Dies kann nicht rückgängig gemacht werden.')) return;
    this.api.deleteAllOrders().subscribe(() => alert('Alle Bestellungen wurden gelöscht.'));
  }

  deleteAllRecipes() {
    if (!confirm('Bist du sicher, dass du ALLE Rezepte und Mappings löschen möchtest? Dies kann nicht rückgängig gemacht werden.')) return;
    this.api.deleteAllRecipes().subscribe(() => alert('Alle Rezepte wurden gelöscht.'));
  }
}
