import { describe, it, expect, beforeAll } from "vitest";
import { cifrar, descifrar, estaCifrado, transformarCampos } from "./cifrado";

beforeAll(() => {
  process.env.CLAVE_CIFRADO_EQUIPOS = "clave-de-prueba-para-tests";
});

describe("cifrado de credenciales de equipos", () => {
  it("cifra y descifra de vuelta al mismo texto", () => {
    const cifrado = cifrar("MiClaveMikrotik#2026") as string;
    expect(estaCifrado(cifrado)).toBe(true);
    expect(cifrado).not.toContain("MiClaveMikrotik");
    expect(descifrar(cifrado)).toBe("MiClaveMikrotik#2026");
  });

  it("dos cifrados del mismo texto son distintos (IV aleatorio)", () => {
    expect(cifrar("public")).not.toBe(cifrar("public"));
  });

  it("no vuelve a cifrar lo ya cifrado ni toca vacíos o null", () => {
    const una = cifrar("x") as string;
    expect(cifrar(una)).toBe(una);
    expect(cifrar("")).toBe("");
    expect(cifrar(null)).toBeNull();
  });

  it("deja pasar el texto plano todavía no migrado", () => {
    expect(descifrar("texto-plano-viejo")).toBe("texto-plano-viejo");
  });

  it("detecta datos alterados", () => {
    const cifrado = cifrar("secreto") as string;
    const alterado = cifrado.slice(0, -4) + (cifrado.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => descifrar(alterado)).toThrow();
  });

  it("transforma { set } de Prisma y arreglos de createMany", () => {
    const mayus = (v: any) => (typeof v === "string" ? v.toUpperCase() : v);
    expect(transformarCampos({ a: "x", b: { set: "y" }, c: "z" }, ["a", "b"], mayus)).toEqual({ a: "X", b: { set: "Y" }, c: "z" });
    expect(transformarCampos([{ a: "x" }, { a: "w" }], ["a"], mayus)).toEqual([{ a: "X" }, { a: "W" }]);
  });
});
