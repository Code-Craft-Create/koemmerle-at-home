import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastOptions {
  tone?: ToastTone;
  durationMs?: number;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const DEFAULT_DURATION_MS = 3000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly subject = new BehaviorSubject<Toast[]>([]);
  readonly toasts$ = this.subject.asObservable();
  private nextId = 1;

  show(message: string, options: ToastOptions = {}): number {
    const id = this.nextId++;
    const toast: Toast = {
      id,
      message,
      tone: options.tone ?? 'info',
    };
    this.subject.next([...this.subject.value, toast]);
    const duration = options.durationMs ?? DEFAULT_DURATION_MS;
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
    return id;
  }

  success(message: string, options: Omit<ToastOptions, 'tone'> = {}): number {
    return this.show(message, { ...options, tone: 'success' });
  }

  error(message: string, options: Omit<ToastOptions, 'tone'> = {}): number {
    return this.show(message, { ...options, tone: 'error' });
  }

  info(message: string, options: Omit<ToastOptions, 'tone'> = {}): number {
    return this.show(message, { ...options, tone: 'info' });
  }

  dismiss(id: number) {
    this.subject.next(this.subject.value.filter(t => t.id !== id));
  }

  clear() {
    this.subject.next([]);
  }
}
