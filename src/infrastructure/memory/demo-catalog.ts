/** A synthetic product list for the dev console's pretend engine. Products and prices are made up. */
import type { PretendProduct } from "./memory-engine";

function product(productId: string, names: readonly string[], aliases: readonly string[], lempiras: number): PretendProduct {
  return { productId, names, aliases, barcode: null, price: lempiras * 100 };
}

export const DEMO_CATALOG: readonly PretendProduct[] = [
  product("demo-arroz", ["Arroz 1 lb", "Arroz"], ["libra de arroz"], 18),
  product("demo-frijoles", ["Frijoles rojos 1 lb", "Frijoles"], ["frijol", "frijoles rojos"], 22),
  product("demo-huevos", ["Cartón de huevos (30)", "Huevos"], ["carton de huevos", "cartón de huevos"], 120),
  product("demo-azucar", ["Azúcar 1 lb", "Azúcar"], ["azucar"], 16),
  product("demo-aceite-1l", ["Aceite 1 L"], ["aceite", "aceite de litro"], 58),
  product("demo-cafe", ["Café molido 200 g", "Café"], ["cafe"], 45),
  product("demo-leche", ["Leche entera 1 L", "Leche"], [], 32),
  product("demo-pan", ["Pan de molde", "Pan"], [], 40),
  product("demo-jabon", ["Jabón de lavar"], ["jabon"], 25),
];
