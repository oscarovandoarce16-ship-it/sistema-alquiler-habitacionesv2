# Sistema de Alquiler de Habitaciones

Sistema web para administrar el alquiler mensual de cinco habitaciones, clientes, pagos y reportes.

## Objetivo

Gestionar las habitaciones, clientes, alquileres y pagos conservando la interfaz del proyecto original y aplicando correctamente la regla de descuento por segundo cuarto.

## Tecnologías

- Node.js
- Express
- PostgreSQL
- JavaScript
- HTML5
- CSS3
- pg
- dotenv

No se agregaron frameworks innecesarios.

## Estructura

```text
sistema-alquiler-habitaciones/
├── backend/
│   ├── server.js
│   └── package.json
├── database/
│   ├── schema.sql
│   └── seed.sql
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── README.md
```

## Instalación

1. Instalar Node.js.
2. Instalar PostgreSQL.
3. Crear una base de datos llamada `alquiler_habitaciones`.
4. Ejecutar `database/schema.sql`.
5. Ejecutar `database/seed.sql`.
6. Configurar las variables de conexión.
7. Entrar a `backend/`.
8. Ejecutar `npm install`.
9. Ejecutar `npm start`.
10. Abrir `http://localhost:3000`.

## PostgreSQL

Ejemplo con `psql`:

```sql
CREATE DATABASE alquiler_habitaciones;
```

Luego:

```text
\c alquiler_habitaciones
\i 'ruta/database/schema.sql'
\i 'ruta/database/seed.sql'
```

También se pueden ejecutar ambos archivos desde pgAdmin.

## Configuración de entorno

Copia `backend/.env.example` como `backend/.env` y completa tus datos reales. El archivo `.env` no debe compartirse.

Ejemplo:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=alquiler_habitaciones
DB_USER=postgres
DB_PASSWORD=TU_PASSWORD_POSTGRESQL
ADMIN_USER=TU_USUARIO_ADMIN
ADMIN_PASSWORD=TU_CONTRASENA_ADMIN
```

El usuario y contraseña del administrador ya no aparecen en la pantalla de login ni están escritos dentro de `app.js`. El backend valida el acceso mediante estas variables y crea una sesión HTTP-only.

## Ejecución

Desde PowerShell:

```powershell
cd "ruta\sistema-alquiler-habitaciones\backend"
npm install
npm start
```

La aplicación queda disponible en:

```text
http://localhost:3000
```

## Regla de negocio

Cada alquiler registra **un solo inquilino titular**.

- Primer cuarto activo de una persona: **Bs 400**.
- Segundo cuarto activo de la misma persona: **12,5% de descuento**, es decir **Bs 350** sobre un precio base de Bs 400.
- Una persona puede tener como máximo **2 habitaciones activas simultáneamente**.
- No existe un campo para registrar un segundo inquilino dentro del alquiler.
- Al intentar registrar una tercera habitación, el backend responde: **"El cliente ya tiene 2 habitaciones activas."**

El backend calcula la regla dentro de una transacción y PostgreSQL también la protege mediante transacciones, bloqueos y triggers.

## Pagos

Cada pago mensual utiliza el `precio_mensual` almacenado en el alquiler. Por eso el segundo cuarto exige Bs 350 y no Bs 400.

Se conserva:

- número de recibo
- mes pagado
- monto
- método de pago
- observaciones
- estado de pago

## Habitaciones

El sistema conserva las cinco habitaciones y sus estados:

- DISPONIBLE
- OCUPADA
- MANTENIMIENTO

Una habitación con un alquiler activo no puede recibir otro alquiler activo.

## Interfaz

La interfaz visual se conserva del proyecto original: distribución, tarjetas, menú lateral, dashboard, formularios, tablas, modal, tipografías, colores y estilos responsive. Solo se cambiaron textos y elementos de información que describían incorrectamente la regla del descuento.

## Pruebas funcionales recomendadas

1. Registrar a Juan Pérez.
2. Alquilarle el cuarto 1: debe quedar en Bs 400.
3. Alquilarle el cuarto 2: debe quedar en Bs 350 y mostrar 12,5%.
4. Intentar alquilarle un tercer cuarto: debe rechazarse.
5. Registrar a María López en un cuarto junto con otra persona: no debe aparecer descuento por compartir.
6. Registrar a María en otro cuarto: si ese es su segundo cuarto activo, debe recibir 12,5%.
7. Registrar el pago del segundo cuarto: el monto permitido debe ser Bs 350.
8. Revisar Reporte de pagos: deben aparecer los precios y descuentos correctos.

## Acceso privado

Ya no se muestran credenciales de demostración en la pantalla de inicio de sesión.

Configura en `backend/.env`:

```env
ADMIN_USER=TU_USUARIO_ADMIN
ADMIN_PASSWORD=TU_CONTRASENA_ADMIN
```

El navegador no recibe ni muestra estas credenciales. Después de iniciar sesión, el backend mantiene una sesión HTTP-only y las rutas de datos requieren autenticación.

## Modificación de inquilinos

Desde **Inquilinos** existe un botón **Editar** para corregir nombre, documento, teléfono, correo o dirección de una persona ya registrada.

## Control automático de deuda y recibos

El reporte de pagos calcula automáticamente los meses pendientes de cada alquiler activo tomando como referencia la fecha de inicio y el mes actual. No es necesario registrar manualmente una deuda: si no existe un pago para un mes, ese mes se acumula como pendiente.

Ejemplo: si una mensualidad es Bs 400 y existen 2 meses sin pagar, el reporte muestra 2 meses pendientes y Bs 800 de deuda acumulada.

El registro de pagos utiliza un flujo de dos pasos: primero se prepara el recibo para revisar y modificar el mes, método, concepto u observaciones; solamente al pulsar **Confirmar y registrar pago** se guarda el pago en PostgreSQL.

Los inquilinos pueden editarse. La eliminación se permite cuando el inquilino no tiene alquileres asociados; si existe historial o un alquiler activo, el sistema evita eliminarlo para no perder información histórica.
