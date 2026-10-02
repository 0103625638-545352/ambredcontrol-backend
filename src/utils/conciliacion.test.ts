import { describe, it, expect } from "vitest";
import { conciliarMovimiento, interpretarMonto, normalizarTexto, referenciaDeMovimiento, type ClienteCandidato, type MovimientoBanco } from "./conciliacion";

const clientes: ClienteCandidato[] = [
  { id: 1, razonSocial: "MARÍA JAQUELINE OTAVALO MARIN", identificacion: "1400443501", montosEsperados: [25], pendienteEsteCiclo: true },
  { id: 2, razonSocial: "PABLO BARRETO", identificacion: "0104857180", montosEsperados: [15], pendienteEsteCiclo: true },
  { id: 3, razonSocial: "PABLO ANDRES BARRETO LOPEZ", identificacion: "0102222222", montosEsperados: [25], pendienteEsteCiclo: false },
  { id: 4, razonSocial: "VERONICA RODRIGUEZ", identificacion: "0930536057", montosEsperados: [25, 22.5], pendienteEsteCiclo: true },
];

const mov = (descripcion: string, monto: number, referencia: string | null = null): MovimientoBanco => ({ fila: 1, fecha: "2026-10-01", descripcion, monto, referencia });

describe("interpretarMonto", () => {
  it.each([
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["$ 25,00", 25],
    ["25.5", 25.5],
    ["(25.00)", -25],
    ["-15", -15],
    [22.5, 22.5],
  ])("%s → %s", (entrada, esperado) => {
    expect(interpretarMonto(entrada)).toBe(esperado);
  });
  it("vacío o texto no es monto", () => {
    expect(interpretarMonto("")).toBeNull();
    expect(interpretarMonto("abc")).toBeNull();
  });
});

describe("conciliarMovimiento", () => {
  it("la cédula en la descripción identifica al cliente", () => {
    const r = conciliarMovimiento(mov("TRANSF SPI 1400443501 PAGO", 25), clientes);
    expect(r.estado).toBe("SUGERIDO");
    expect(r.sugerido?.clienteId).toBe(1);
  });

  it("nombre completo + monto exacto sugiere al cliente", () => {
    const r = conciliarMovimiento(mov("TRANSFERENCIA DE OTAVALO MARIN MARIA", 25), clientes);
    expect(r.sugerido?.clienteId).toBe(1);
  });

  it("acepta el precio con promoción", () => {
    const r = conciliarMovimiento(mov("DEP VERONICA RODRIGUEZ", 22.5), clientes);
    expect(r.estado).toBe("SUGERIDO");
    expect(r.sugerido?.clienteId).toBe(4);
  });

  it("dos clientes parecidos sin otra señal quedan como ambiguo", () => {
    const r = conciliarMovimiento(mov("PAGO PABLO BARRETO", 20), clientes);
    expect(r.estado).toBe("AMBIGUO");
    expect(r.candidatos.map((c) => c.clienteId)).toContain(2);
  });

  it("el monto desempata entre dos parecidos", () => {
    const r = conciliarMovimiento(mov("PAGO PABLO BARRETO", 15), clientes);
    expect(r.estado).toBe("SUGERIDO");
    expect(r.sugerido?.clienteId).toBe(2);
  });

  it("un débito no se concilia", () => {
    expect(conciliarMovimiento(mov("COMISION", -0.5), clientes).estado).toBe("NO_ES_INGRESO");
  });

  it("sin ninguna señal no inventa cliente", () => {
    expect(conciliarMovimiento(mov("DEPOSITO EN EFECTIVO", 7.33), clientes).estado).toBe("SIN_COINCIDENCIA");
  });
});

describe("referenciaDeMovimiento", () => {
  it("usa la referencia del banco si viene", () => {
    expect(referenciaDeMovimiento(mov("x", 25, "  98765 "))).toBe("BANCO 98765");
  });
  it("arma una referencia estable sin referencia del banco", () => {
    expect(referenciaDeMovimiento(mov("Transf. María", 25))).toBe(referenciaDeMovimiento(mov("Transf. María", 25)));
    expect(normalizarTexto("Transf. María")).toBe("TRANSF MARIA");
  });
});
