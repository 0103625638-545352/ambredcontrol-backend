import { describe, it, expect } from "vitest";
import { calcularDigitoVerificador, generarClaveAcceso } from "./claveAcceso";

describe("calcularDigitoVerificador", () => {
  it("rechaza cadenas que no tienen exactamente 48 dígitos", () => {
    expect(() => calcularDigitoVerificador("123")).toThrow("Se esperaban 48 dígitos");
  });

  it("calcula 0 cuando la suma ponderada es múltiplo exacto de 11 (caso especial resultado===11)", () => {
    expect(calcularDigitoVerificador("0".repeat(48))).toBe(0);
  });

  it("calcula 1 cuando el residuo da resultado===10 (caso especial)", () => {
    // "8" repetido: suma = 8 * 216 = 1728; 1728 % 11 = 1; resultado = 11-1 = 10 -> dígito 1
    expect(calcularDigitoVerificador("8".repeat(48))).toBe(1);
  });

  it("calcula el dígito verificador en el caso general", () => {
    // "1" repetido: suma = 216; 216 % 11 = 7; resultado = 11-7 = 4
    expect(calcularDigitoVerificador("1".repeat(48))).toBe(4);
  });
});

describe("generarClaveAcceso", () => {
  const base = {
    fechaEmision: new Date(2026, 6, 15), // 15/07/2026
    ruc: "0999999999001",
    ambiente: "1" as const,
    establecimiento: "001",
    puntoEmision: "002",
    secuencial: 42,
    codigoNumerico: "12345678",
  };

  it("genera una clave de 49 dígitos, todos numéricos", () => {
    const clave = generarClaveAcceso(base);
    expect(clave).toHaveLength(49);
    expect(clave).toMatch(/^\d{49}$/);
  });

  it("arma cada segmento en la posición correcta", () => {
    const clave = generarClaveAcceso(base);
    expect(clave.slice(0, 8)).toBe("15072026"); // fecha ddmmaaaa
    expect(clave.slice(8, 10)).toBe("01"); // tipoComprobante default
    expect(clave.slice(10, 23)).toBe("0999999999001"); // RUC
    expect(clave.slice(23, 24)).toBe("1"); // ambiente
    expect(clave.slice(24, 30)).toBe("001002"); // establecimiento + puntoEmision
    expect(clave.slice(30, 39)).toBe("000000042"); // secuencial a 9 dígitos
    expect(clave.slice(39, 47)).toBe("12345678"); // código numérico
    expect(clave.slice(47, 48)).toBe("1"); // tipoEmision default
  });

  it("usa el tipoComprobante que se le pase (ej. \"04\" para nota de crédito)", () => {
    const clave = generarClaveAcceso({ ...base, tipoComprobante: "04" });
    expect(clave.slice(8, 10)).toBe("04");
  });

  it("rellena el RUC a la izquierda si viene más corto que 13 dígitos", () => {
    const clave = generarClaveAcceso({ ...base, ruc: "123" });
    expect(clave.slice(10, 23)).toBe("0000000000123");
  });

  it("el último dígito siempre coincide con el verificador de los primeros 48", () => {
    const clave = generarClaveAcceso(base);
    const esperado = calcularDigitoVerificador(clave.slice(0, 48));
    expect(Number(clave[48])).toBe(esperado);
  });
});
