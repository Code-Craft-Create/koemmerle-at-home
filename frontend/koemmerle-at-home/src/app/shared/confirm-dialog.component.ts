import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConfirmationRequest, ConfirmationService } from './confirmation.service';

@Component({
  selector: 'app-confirm-dialog',
  imports: [CommonModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss'
})
export class ConfirmDialogComponent {
  request: ConfirmationRequest | null = null;

  constructor(private confirmation: ConfirmationService) {
    this.confirmation.request$.subscribe(request => this.request = request);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.request) this.cancel();
  }

  cancel() {
    this.confirmation.resolve(false);
  }

  confirm() {
    this.confirmation.resolve(true);
  }
}
