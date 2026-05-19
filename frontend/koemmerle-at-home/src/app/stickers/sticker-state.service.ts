import { Injectable } from '@angular/core';
import type { StickerItem } from './stickers.component';

@Injectable({ providedIn: 'root' })
export class StickerStateService {
  selectedKeys: string[] = [];
  searchRaw = '';
  categoryFilter = '';
  showUnavailable = false;
  hidePrinted = true;
  currentPage = 0;
  pageSize = 30;
  migrosItems: StickerItem[] = [];
  hasState = false;
}
