// Lectura por SSH (VRP CLI) de las OLT Huawei — complemento de
// utils/oltHuawei.ts (SNMP). Se agregó porque el firmware de estos equipos
// no siempre expone temperatura ni distancia óptica por SNMP estándar, pero
// esos datos SÍ están disponibles por los comandos de consola que ya usa el
// técnico a diario contra el puerto 22 del equipo. Igual que el módulo SNMP:
// SOLO LECTURA, nunca se aprovisiona ni se configura nada de la OLT desde
// acá (ver "Módulo de OLT" en schema.prisma).
//
// *** IMPORTANTE — CALIBRACIÓN CONTRA EL EQUIPO REAL ***
// La sintaxis y las columnas exactas de "display ont info" / "display ont
// optical-info" / "display ont wan-info" varían según la versión de
// firmware del VRP (Huawei no publica un manual único para toda la familia
// MA5608T/MA5800). Los comandos y expresiones regulares de abajo son los
// más comunes en la documentación y en herramientas de la comunidad, pero
// NO están verificados todavía contra un equipo real de esta empresa. Antes
// de confiar en listarOntsDePuertoSsh(), usar ejecutarComandoSshCrudo() (ver
// POST /olts/:id/ssh/ejecutar) con el comando exacto que el técnico ya usa a
// mano, comparar la salida real contra los parsers de acá y ajustar los
// regex si no calzan — un solo lugar para tocar, igual criterio que
// OIDS_HUAWEI_GPON en oltHuawei.ts.
import { Client } from "ssh2";

export interface ConfigSsh {
  direccionIp: string;
  sshPuerto: number;
  sshUsuario: string;
  sshPassword: string;
}

const TIMEOUT_MS = 15_000;

// El VRP de Huawei pagina la salida larga con un prompt "---- More ----" que
// espera cualquier tecla. Este comando (soportado en casi todo VRP moderno)
// desactiva la paginación para la sesión actual — se manda apenas se entra,
// antes de cualquier "display".
const COMANDO_SIN_PAGINACION = "screen-length 0 temporary";

// Abre una sesión SSH, ejecuta una secuencia de comandos en un shell
// interactivo (el VRP de Huawei no funciona bien con "exec" de un solo
// comando, necesita sesión de shell tipo terminal) y devuelve TODO lo que
// fue imprimiendo la consola. Cierra la conexión al terminar o al primer
// error/timeout.
function ejecutarComandosSsh(config: ConfigSsh, comandos: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cliente = new Client();
    let salida = "";
    let terminado = false;

    const finalizar = (error?: Error) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(temporizador);
      cliente.end();
      if (error) reject(error);
      else resolve(salida);
    };

    const temporizador = setTimeout(() => finalizar(new Error("Tiempo de espera agotado conectando por SSH a la OLT")), TIMEOUT_MS);

    cliente
      .on("ready", () => {
        cliente.shell((error, stream) => {
          if (error) return finalizar(error);

          stream.on("data", (datos: Buffer) => {
            salida += datos.toString("utf8");
          });
          stream.stderr.on("data", (datos: Buffer) => {
            salida += datos.toString("utf8");
          });
          stream.on("close", () => finalizar());

          // Los comandos se mandan uno detrás de otro con una pequeña pausa
          // — el VRP es una consola interactiva, no una API: si se manda
          // todo de una sin esperar el prompt anterior, el equipo puede
          // descartar comandos.
          let indice = 0;
          const siguiente = () => {
            if (indice >= comandos.length) {
              // Da tiempo a que llegue la respuesta del último comando antes
              // de cerrar la sesión.
              setTimeout(() => stream.end("quit\n"), 2000);
              return;
            }
            stream.write(comandos[indice] + "\n");
            indice++;
            setTimeout(siguiente, 800);
          };
          siguiente();
        });
      })
      .on("error", (error) => finalizar(error))
      .connect({
        host: config.direccionIp,
        port: config.sshPuerto,
        username: config.sshUsuario,
        password: config.sshPassword,
        readyTimeout: TIMEOUT_MS,
        // Equipos de telecom viejos suelen traer algoritmos que los clientes
        // SSH modernos ya no ofrecen por defecto (ssh2 los deshabilitó por
        // inseguros) — se agregan de vuelta como último recurso, priorizando
        // siempre los modernos primero.
        algorithms: {
          kex: ["diffie-hellman-group14-sha256", "diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha1"],
          cipher: ["aes128-ctr", "aes192-ctr", "aes256-ctr", "aes128-cbc", "3des-cbc"],
          serverHostKey: ["ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256"],
        },
      });
  });
}

// Prueba de conectividad — conecta, corre "display version" (universal en
// VRP) y devuelve la primera línea útil, sin intentar interpretar tablas.
export async function probarConexionSsh(config: ConfigSsh): Promise<string> {
  const salida = await ejecutarComandosSsh(config, [COMANDO_SIN_PAGINACION, "display version"]);
  const lineas = salida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes(COMANDO_SIN_PAGINACION) && !l.includes("display version"));
  return lineas.slice(0, 5).join(" | ") || "Conectado, pero el equipo no devolvió texto reconocible";
}

// Herramienta de calibración: manda el/los comando(s) tal cual el técnico
// los usaría a mano y devuelve la salida cruda completa — para comparar
// contra los parsers de abajo cuando listarOntsDePuertoSsh no encuentra nada
// en un puerto que sí tiene ONTs. Ver POST /olts/:id/ssh/ejecutar.
export async function ejecutarComandoSshCrudo(config: ConfigSsh, comandos: string[]): Promise<string> {
  return ejecutarComandosSsh(config, [COMANDO_SIN_PAGINACION, ...comandos]);
}

export interface OntPuertoSsh {
  onuIndex: number;
  serial: string | null;
  estado: "ONLINE" | "OFFLINE";
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  temperaturaCelsius: number | null;
  distanciaMetros: number | null;
  ipGestion: string | null;
}

// Une varias filas de texto que traen la MISMA columna "ONT" (primer número
// después de F/S/P) en un mapa onuIndex -> resto de columnas, tolerando
// cualquier cantidad de espacios entre columnas (el VRP alinea con espacios,
// no con un separador fijo).
function partirColumnas(linea: string): string[] {
  return linea.trim().split(/\s+/);
}

// Convierte un valor de potencia óptica en texto ("-21.25", "-25.23(dBm)",
// "N/A") a número, o null si el equipo no reporta lectura para esa fila.
function parsearNumero(texto: string | undefined): number | null {
  if (!texto) return null;
  const limpio = texto.replace(/[^\d.-]/g, "");
  if (!limpio || limpio === "-") return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// "display ont info <frame>/<slot>/<puerto>" — identidad + estado. Columnas
// típicas: F/S/P  ONT  SN  Control-flag  Run-State  Config-state  Match-state
// Protect-side. El primer token de cada fila de datos es "frame/slot /puerto"
// (a veces con espacio antes de la barra final, según la versión) — se
// detectan las filas de datos por empezar con el patrón F/S/P exacto que se
// pidió, así no hace falta parsear encabezados.
function parsearOntInfo(salida: string, frame: number, slot: number, puerto: number): Map<number, { serial: string | null; estado: "ONLINE" | "OFFLINE" }> {
  const resultado = new Map<number, { serial: string | null; estado: "ONLINE" | "OFFLINE" }>();
  const prefijo = `${frame}/${slot}/${puerto}`;
  for (const lineaCruda of salida.split("\n")) {
    const linea = lineaCruda.replace(/\s*\/\s*/g, "/").trim();
    if (!linea.startsWith(prefijo)) continue;
    const columnas = partirColumnas(linea);
    const onuIndex = Number(columnas[1]);
    if (!Number.isFinite(onuIndex)) continue;
    const serial = columnas[2] && columnas[2] !== "-" ? columnas[2] : null;
    const textoEstado = linea.toLowerCase();
    const estado: "ONLINE" | "OFFLINE" = textoEstado.includes("online") ? "ONLINE" : "OFFLINE";
    resultado.set(onuIndex, { serial, estado });
  }
  return resultado;
}

// "display ont optical-info <frame>/<slot>/<puerto> all" — potencia óptica y
// temperatura. Columnas típicas: F/S/P  ONT  Rx-power(dBm)  Tx-power(dBm)
// Voltage(V)  Bias-current(mA)  Temperature(C).
function parsearOpticalInfo(salida: string, frame: number, slot: number, puerto: number): Map<number, { rx: number | null; tx: number | null; temp: number | null }> {
  const resultado = new Map<number, { rx: number | null; tx: number | null; temp: number | null }>();
  const prefijo = `${frame}/${slot}/${puerto}`;
  for (const lineaCruda of salida.split("\n")) {
    const linea = lineaCruda.replace(/\s*\/\s*/g, "/").trim();
    if (!linea.startsWith(prefijo)) continue;
    const columnas = partirColumnas(linea);
    const onuIndex = Number(columnas[1]);
    if (!Number.isFinite(onuIndex)) continue;
    resultado.set(onuIndex, {
      rx: parsearNumero(columnas[2]),
      tx: parsearNumero(columnas[3]),
      // La temperatura suele ser la última columna numérica de la fila —
      // más robusto que fijar un índice de columna exacto, porque algunas
      // versiones de firmware agregan/quitan Voltage/Bias entre medio.
      temp: parsearNumero(columnas[columnas.length - 1]),
    });
  }
  return resultado;
}

// "display ont wan-info <frame>/<slot>/<puerto> all" — IP de gestión
// asignada por DHCP a cada ONT, si el equipo lo soporta (no todos los
// perfiles de servicio la reportan; queda null si no aparece).
function parsearWanInfo(salida: string, frame: number, slot: number, puerto: number): Map<number, string> {
  const resultado = new Map<number, string>();
  const prefijo = `${frame}/${slot}/${puerto}`;
  const regexIp = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
  for (const lineaCruda of salida.split("\n")) {
    const linea = lineaCruda.replace(/\s*\/\s*/g, "/").trim();
    if (!linea.startsWith(prefijo)) continue;
    const columnas = partirColumnas(linea);
    const onuIndex = Number(columnas[1]);
    if (!Number.isFinite(onuIndex)) continue;
    const matchIp = linea.match(regexIp);
    if (matchIp) resultado.set(onuIndex, matchIp[1]);
  }
  return resultado;
}

// "display ont distance-info <frame>/<slot>/<puerto>" — distancia óptica
// estimada en metros. No todos los modelos/firmwares soportan este comando
// (algunos responden "Failure: Command not found" o similar) — se ignora el
// error, la distancia simplemente queda null para ese puerto.
function parsearDistanceInfo(salida: string, frame: number, slot: number, puerto: number): Map<number, number> {
  const resultado = new Map<number, number>();
  const prefijo = `${frame}/${slot}/${puerto}`;
  for (const lineaCruda of salida.split("\n")) {
    const linea = lineaCruda.replace(/\s*\/\s*/g, "/").trim();
    if (!linea.startsWith(prefijo)) continue;
    const columnas = partirColumnas(linea);
    const onuIndex = Number(columnas[1]);
    const distancia = parsearNumero(columnas[columnas.length - 1]);
    if (Number.isFinite(onuIndex) && distancia !== null) resultado.set(onuIndex, Math.round(distancia));
  }
  return resultado;
}

// Trae el estado completo de UN puerto GPON puntual (frame/slot/puerto) por
// SSH: identidad+estado, potencia óptica, temperatura, distancia e IP de
// gestión de cada ONT conectada ahí. Pensado para la "Vista por puerto GPON"
// del Mapa de Red — a diferencia de sincronizarOlt (SNMP, trae TODA la OLT),
// esto consulta un solo puerto a demanda, que es como el técnico ya lo usa
// hoy por consola.
export async function listarOntsDePuertoSsh(config: ConfigSsh, frame: number, slot: number, puerto: number): Promise<OntPuertoSsh[]> {
  const objetivo = `${frame}/${slot}/${puerto}`;
  const salida = await ejecutarComandosSsh(config, [
    COMANDO_SIN_PAGINACION,
    `display ont info ${objetivo}`,
    `display ont optical-info ${objetivo} all`,
    `display ont wan-info ${objetivo} all`,
    `display ont distance-info ${objetivo}`,
  ]);

  const info = parsearOntInfo(salida, frame, slot, puerto);
  const optico = parsearOpticalInfo(salida, frame, slot, puerto);
  const wan = parsearWanInfo(salida, frame, slot, puerto);
  const distancias = parsearDistanceInfo(salida, frame, slot, puerto);

  // La tabla de identidad ("display ont info") es la más confiable para
  // saber CUÁLES onuIndex existen en el puerto — las otras tres solo aportan
  // columnas adicionales para los mismos índices.
  const resultado: OntPuertoSsh[] = [];
  for (const [onuIndex, datosInfo] of info) {
    const datosOptico = optico.get(onuIndex);
    resultado.push({
      onuIndex,
      serial: datosInfo.serial,
      estado: datosInfo.estado,
      rxPowerDbm: datosOptico?.rx ?? null,
      txPowerDbm: datosOptico?.tx ?? null,
      temperaturaCelsius: datosOptico?.temp ?? null,
      distanciaMetros: distancias.get(onuIndex) ?? null,
      ipGestion: wan.get(onuIndex) ?? null,
    });
  }
  return resultado.sort((a, b) => a.onuIndex - b.onuIndex);
}
