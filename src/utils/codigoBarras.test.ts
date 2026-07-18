import { describe, it, expect } from "vitest";
import { validarCodigoBarras } from "./codigoBarras";

describe("validarCodigoBarras", () => {
  it("acepta un EAN-13 válido", () => {
    expect(validarCodigoBarras("4006381333931")).toBe(true);
  });

  it("rechaza un EAN-13 con el dígito de control incorrecto", () => {
    expect(validarCodigoBarras("4006381333930")).toBe(false);
  });

  it("acepta un UPC-A válido", () => {
    expect(validarCodigoBarras("123456789012")).toBe(true);
  });

  it("rechaza un UPC-A con el dígito de control incorrecto", () => {
    expect(validarCodigoBarras("123456789013")).toBe(false);
  });

  it("pasa sin validar un código alfanumérico (Code128 interno)", () => {
    expect(validarCodigoBarras("FERR-00123")).toBe(true);
  });

  it("pasa sin validar un vacío (campo opcional)", () => {
    expect(validarCodigoBarras("")).toBe(true);
  });

  it("pasa sin validar una longitud no estándar (ni 8, 12 ni 13)", () => {
    expect(validarCodigoBarras("1234567890")).toBe(true);
  });
});
