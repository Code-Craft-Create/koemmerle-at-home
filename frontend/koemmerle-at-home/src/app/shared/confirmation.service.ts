import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'default' | 'danger';
}

export interface ConfirmationRequest extends Required<Omit<ConfirmationOptions, 'tone'>> {
  tone: 'default' | 'danger';
}

@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  private resolver: ((confirmed: boolean) => void) | null = null;
  private readonly requestSubject = new BehaviorSubject<ConfirmationRequest | null>(null);
  readonly request$ = this.requestSubject.asObservable();

  confirm(options: ConfirmationOptions): Promise<boolean> {
    if (this.resolver) this.resolve(false);

    const request: ConfirmationRequest = {
      title: options.title,
      message: options.message,
      confirmText: options.confirmText ?? 'Bestätigen',
      cancelText: options.cancelText ?? 'Abbrechen',
      tone: options.tone ?? 'default'
    };

    this.requestSubject.next(request);
    return new Promise<boolean>(resolve => {
      this.resolver = resolve;
    });
  }

  resolve(confirmed: boolean) {
    const resolver = this.resolver;
    this.resolver = null;
    this.requestSubject.next(null);
    resolver?.(confirmed);
  }
}
