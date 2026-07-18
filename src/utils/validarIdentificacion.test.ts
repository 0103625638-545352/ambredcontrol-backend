import { describe, it, expect } from "vitest";
import { validarCedula, validarRuc, validarIdentificacion } from "./validarIdentificacion";

describe("validarCedula", () => {
  it("acepta \"9999999999\" como código especial de Consumidor Final", () => {
    expect(validarCedula("9999999999").valido).toBe(true);
  });

  it("rechaza cédulas que no tienen exactamente 10 dígitos", () => {
    const resultado = validarCedula("12345");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/10 dígitos/);
  });

  it("rechaza un código de provincia inválido", () => {
    const resultado = validarCedula("9910034065");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/provincia/);
  });

  it("rechaza cuando el tercer dígito indica que no es persona natural", () => {
    const resultado = validarCedula("1760034065");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/persona natural/);
  });

  it("acepta una cédula real con dígito verificador correcto", () => {
    expect(validarCedula("1710034065").valido).toBe(true);
  });

  it("rechaza la misma cédula si el dígito verificador no coincide", () => {
    const resultado = validarCedula("1710034066");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/dígito verificador/);
  });
});

describe("validarRuc", () => {
  it("rechaza RUC que no tienen exactamente 13 dígitos", () => {
    const resultado = validarRuc("123");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/13 dígitos/);
  });

  it("acepta un RUC de persona natural válido (cédula + establecimiento)", () => {
    expect(validarRuc("1710034065001").valido).toBe(true);
  });

  it("rechaza un RUC de persona natural con establecimiento 000", () => {
    const resultado = validarRuc("1710034065000");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/establecimiento/);
  });

  it("rechaza un RUC de persona natural si la cédula base es inválida", () => {
    const resultado = validarRuc("1710034066001");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/RUC de persona natural inválido/);
  });

  it("acepta un RUC de sociedad privada con dígito verificador correcto", () => {
    // Construido y validado en vivo contra esta misma función durante pruebas manuales.
    expect(validarRuc("1799999990001").valido).toBe(true);
  });

  it("rechaza un RUC de sociedad privada con dígito verificador incorrecto", () => {
    const resultado = validarRuc("1799999991001");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/sociedad privada/);
  });

  it("acepta un RUC del sector público con dígito verificador correcto", () => {
    expect(validarRuc("1760000070001").valido).toBe(true);
  });

  it("rechaza un RUC del sector público con dígito verificador incorrecto", () => {
    const resultado = validarRuc("1760000000001");
    expect(resultado.valido).toBe(false);
    expect(resultado.mensaje).toMatch(/sector público/);
  });
});

describe("validarIdentificacion", () => {
  it("delega en validarCedula cuando tipo es CEDULA", () => {
    expect(validarIdentificacion("CEDULA", "9999999999").valido).toBe(true);
  });

  it("delega en validarRuc cuando tipo es RUC", () => {
    expect(validarIdentificacion("RUC", "123").valido).toBe(false);
  });

  it("no aplica dígito verificador a pasaportes", () => {
    expect(validarIdentificacion("PASAPORTE", "ABC123XYZ").valido).toBe(true);
  });
});
