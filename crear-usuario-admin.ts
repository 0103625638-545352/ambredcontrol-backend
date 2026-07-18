// Script de UN SOLO USO para crear el primer usuario administrador de la
// empresa "principal" (la que siembra sembrarEmpresaPrincipalSiHaceFalta()
// al primer arranque del backend — ver utils/empresas.ts). Para cualquier
// empresa creada DESPUÉS con "Crear empresa" en el login, su primer admin
// ya se crea solo (ver utils/provisionarEmpresa.ts); este script no aplica ahí.
// No exponemos esto como una ruta pública de la API por seguridad
// (no queremos que cualquiera pueda crear un usuario ADMIN desde internet).
//
// Uso: npx ts-node crear-usuario-admin.ts

import { prisma, ejecutarConEmpresa } from "./src/db";
import { hashPassword } from "./src/utils/auth";
import * as readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function preguntar(texto: string): Promise<string> {
  return new Promise((resolve) => rl.question(texto, resolve));
}

async function main() {
  console.log("=== Crear usuario administrador ===\n");

  const nombre = await preguntar("Nombre completo: ");
  const usuario = await preguntar("Nombre de usuario (para iniciar sesión): ");
  const password = await preguntar("Contraseña: ");

  rl.close();

  const passwordHash = await hashPassword(password);

  // "prisma" (el import de arriba) solo resuelve a la base correcta
  // DENTRO de ejecutarConEmpresa — igual que en jobs/reintentoAutorizacionSri.ts,
  // porque este script corre suelto, sin pasar por requireAuth.
  const nuevoUsuario = await ejecutarConEmpresa("principal", () =>
    prisma.usuario.create({
      data: { nombre, usuario, passwordHash, rol: "ADMIN" },
    })
  );

  console.log(`\n✅ Usuario administrador creado: ${nuevoUsuario.usuario} (id: ${nuevoUsuario.id})`);
  console.log("Ya puedes iniciar sesión en el sistema con este usuario y contraseña.");

  process.exit(0);
}

main().catch((error) => {
  console.error("Error al crear el usuario:", error);
  process.exit(1);
});
