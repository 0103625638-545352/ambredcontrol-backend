import { describe, it, expect } from "vitest";
import { esTardanza } from "./marcaciones";

describe("esTardanza", () => {
  it("no es tardanza si llega antes de la hora esperada", () => {
    expect(esTardanza(new Date(2026, 6, 21, 7, 55), "08:00")).toBe(false);
  });

  it("no es tardanza si llega EXACTO a la hora esperada", () => {
    expect(esTardanza(new Date(2026, 6, 21, 8, 0), "08:00")).toBe(false);
  });

  it("es tardanza si llega después de la hora esperada", () => {
    expect(esTardanza(new Date(2026, 6, 21, 8, 15), "08:00")).toBe(true);
  });

  it("compara minutos correctamente, no solo horas", () => {
    expect(esTardanza(new Date(2026, 6, 21, 8, 1), "08:00")).toBe(true);
    expect(esTardanza(new Date(2026, 6, 21, 7, 59), "08:00")).toBe(false);
  });
});
