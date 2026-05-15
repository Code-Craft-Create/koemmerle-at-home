import { Routes } from '@angular/router';
import { ScanComponent } from './scan/scan.component';
import { QueueComponent } from './queue/queue.component';
import { RecipesComponent } from './recipes/recipes.component';
import { RecipeDetailComponent } from './recipe-detail/recipe-detail.component';
import { SettingsComponent } from './settings/settings.component';
import { ProductsComponent } from './products/products.component';
import { ProductDetailComponent } from './product-detail/product-detail.component';
import { OrdersComponent } from './orders/orders.component';
import { StatisticsComponent } from './statistics/statistics.component';
import { StickersComponent } from './stickers/stickers.component';
import { ForecastComponent } from './forecast/forecast.component';
import { BasketComponent } from './basket/basket.component';

export const routes: Routes = [
  { path: '', redirectTo: 'basket', pathMatch: 'full' },
  { path: 'scan', component: ScanComponent },
  { path: 'queue', component: QueueComponent },
  { path: 'basket', component: BasketComponent },
  { path: 'products', component: ProductsComponent },
  { path: 'products/:id', component: ProductDetailComponent },
  { path: 'orders', component: OrdersComponent },
  { path: 'statistics', component: StatisticsComponent },
  { path: 'forecast', component: ForecastComponent },
  { path: 'stickers', component: StickersComponent },
  { path: 'recipes', component: RecipesComponent },
  { path: 'recipes/:id', component: RecipeDetailComponent },
  { path: 'settings', component: SettingsComponent },
  { path: 'admin', redirectTo: 'settings', pathMatch: 'full' },
];
