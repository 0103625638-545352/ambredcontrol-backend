// Conciliación bancaria: dado un movimiento del extracto del banco (fecha,
// descripción, monto, referencia), sugiere a qué cliente de internet
// corresponde. Funciones puras (sin I/O), testeadas en conciliacion.test.ts;
// la ruta que las usa es routes/conciliacionBancaria.ts.
//
// Señales, de la más fuerte a la más débil:
//  - La cédula/RUC del cliente aparece en la descripción (los bancos suelen
//    incluir la identificación del ordenante en las transferencias).
//  - Palabras del nombre del cliente aparecen en la descripción.
//  - El monto coincide con lo que paga ese cliente por mes (precio del plan,
//    o el precio con su promoción vigente), o con un múltiplo exacto.
// Solo se SUGIERE: la persona confirma cada fila antes de registrar el pago.

export interface MovimientoBanco {
  fila: number;
  fecha: string | null;
  descripcion: string;
  monto: number;
  referencia: string | null;
}

export interface ClienteCandidato {
  id: number;
  razonSocial: string;
  identificacion: string;
  montosEsperados: number[]; // precio del plan y precio con promoción, si aplica
  pendienteEsteCiclo: boolean;
}

export interface Coincidencia {
  clienteId: number;
  puntaje: number;
  motivos: string[];
}

export type EstadoConciliacion = "SUGERIDO" | "AMBIGUO" | "SIN_COINCIDENCIA" | "NO_ES_INGRESO";

export interface ResultadoConciliacion {
  estado: EstadoConciliacion;
  sugerido: Coincidencia | null;
  candidatos: Coincidencia[]; // los mejores, de mayor a menor puntaje
}

const PUNTAJE_SUGERIR = 60;
const VENTAJA_MINIMA = 20; // sobre el segundo candidato, para no adivinar entre dos parecidos
const PUNTAJE_CANDIDATO = 30;

// Palabras que aparecen en cualquier nombre o descripción bancaria y no
// identifican a nadie.
const PALABRAS_VACIAS = new Set([
  "DE", "DEL", "LA", "LAS", "LOS", "Y", "SA", "S.A", "CIA", "LTDA", "TRANSFERENCIA", "TRANSF", "PAGO", "DEPOSITO",
  "INTERNET", "SERVICIO", "BANCO", "CTA", "CUENTA", "AHORROS", "CORRIENTE", "REF", "NRO", "INTERBANCARIA", "SPI",
]);

export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function palabras(texto: string): string[] {
  return normalizarTexto(texto)
    .split(" ")
    .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p) && !/^\d+$/.test(p));
}

// Acepta "1.234,56", "1,234.56", "1234.56", "$ 25,00", "(25.00)" o "-25".
export function interpretarMonto(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== "string") return null;
  let t = valor.trim();
  if (!t) return null;
  const negativo = /^\(.*\)$/.test(t) || t.startsWith("-");
  t = t.replace(/[^\d.,]/g, "");
  if (!t) return null;
  const ultimaComa = t.lastIndexOf(",");
  const ultimoPunto = t.lastIndexOf(".");
  if (ultimaComa > ultimoPunto) {
    t = t.replace(/\./g, "").replace(",", "."); // formato 1.234,56
  } else {
    t = t.replace(/,/g, ""); // formato 1,234.56
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

function igualesEnCentavos(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

export function puntuarCliente(mov: MovimientoBanco, cliente: ClienteCandidato): Coincidencia {
  const motivos: string[] = [];
  let puntaje = 0;
  const descripcion = normalizarTexto(`${mov.descripcion} ${mov.referencia ?? ""}`);
  const digitos = descripcion.replace(/\D+/g, " ");

  if (cliente.identificacion && /^\d{10,13}$/.test(cliente.identificacion) && digitos.includes(cliente.identificacion)) {
    puntaje += 100;
    motivos.push("su cédula/RUC aparece en la transferencia");
  }

  const delCliente = new Set(palabras(cliente.razonSocial));
  const enDescripcion = new Set(palabras(mov.descripcion));
  const comunes = [...delCliente].filter((p) => enDescripcion.has(p));
  if (comunes.length >= 2) {
    puntaje += 40 + 10 * (comunes.length - 2);
    motivos.push(`el nombre coincide (${comunes.join(", ")})`);
  } else if (comunes.length === 1) {
    puntaje += 12;
    motivos.push(`una palabra del nombre coincide (${comunes[0]})`);
  }

  if (cliente.montosEsperados.some((m) => igualesEnCentavos(mov.monto, m))) {
    puntaje += 30;
    motivos.push("el monto es exactamente su mensualidad");
  } else if (cliente.montosEsperados.some((m) => m > 0 && [2, 3, 6, 12].some((k) => igualesEnCentavos(mov.monto, m * k)))) {
    puntaje += 15;
    motivos.push("el monto es un múltiplo de su mensualidad");
  }

  if (puntaje > 0 && cliente.pendienteEsteCiclo) {
    puntaje += 5;
    motivos.push("tiene el pago de este mes pendiente");
  }

  return { clienteId: cliente.id, puntaje, motivos };
}

export function conciliarMovimiento(mov: MovimientoBanco, clientes: ClienteCandidato[]): ResultadoConciliacion {
  if (!(mov.monto > 0)) return { estado: "NO_ES_INGRESO", sugerido: null, candidatos: [] };

  const puntuados = clientes
    .map((c) => puntuarCliente(mov, c))
    .filter((c) => c.puntaje >= PUNTAJE_CANDIDATO)
    .sort((a, b) => b.puntaje - a.puntaje);
  const candidatos = puntuados.slice(0, 5);
  const [primero, segundo] = candidatos;

  if (primero && primero.puntaje >= PUNTAJE_SUGERIR && (!segundo || primero.puntaje - segundo.puntaje >= VENTAJA_MINIMA)) {
    return { estado: "SUGERIDO", sugerido: primero, candidatos };
  }
  if (candidatos.length > 0) return { estado: "AMBIGUO", sugerido: null, candidatos };
  return { estado: "SIN_COINCIDENCIA", sugerido: null, candidatos: [] };
}

// Referencia con la que se guarda el Pago para no registrar dos veces el
// mismo movimiento si se vuelve a subir el mismo extracto: la del banco si
// viene, o una armada con fecha + monto + inicio de la descripción.
export function referenciaDeMovimiento(mov: MovimientoBanco): string {
  if (mov.referencia && mov.referencia.trim()) return `BANCO ${mov.referencia.trim()}`.slice(0, 120);
  return `BANCO ${mov.fecha ?? "s/f"} ${mov.monto.toFixed(2)} ${normalizarTexto(mov.descripcion).slice(0, 40)}`.slice(0, 120);
}
