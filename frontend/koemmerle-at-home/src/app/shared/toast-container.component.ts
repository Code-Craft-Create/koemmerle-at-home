import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Toast, ToastService } from './toast.service';

@Component({
  selector: 'app-toast-container',
  imports: [CommonModule],
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.scss'
})
export class ToastContainerComponent {
  toasts: Toast[] = [];

  constructor(private toast: ToastService) {
    this.toast.toasts$.subscribe(list => this.toasts = list);
  }

  dismiss(id: number) { this.toast.dismiss(id); }

  trackById(_index: number, toast: Toast) { return toast.id; }
}
