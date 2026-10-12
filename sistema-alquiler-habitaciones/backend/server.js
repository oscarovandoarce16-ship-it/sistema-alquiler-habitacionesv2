const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || "alquiler_habitaciones",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../frontend")));

const sessions = new Map();
const SESSION_COOKIE = "alquiler_session";
const money = value => Number(Number(value).toFixed(2));
const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Sesión no autorizada. Inicie sesión nuevamente." });
  }
  req.usuario = sessions.get(token);
  next();
}

app.post("/api/login", (req, res) => {
  const usuario = String(req.body.usuario || "").trim();
  const password = String(req.body.password || "");
  const adminUser = String(process.env.ADMIN_USER || "").trim();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "");

  if (!adminUser || !adminPassword) {
    return res.status(500).json({ error: "El acceso privado no está configurado. Configure ADMIN_USER y ADMIN_PASSWORD en backend/.env." });
  }

  if (usuario !== adminUser || password !== adminPassword) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { usuario, rol: "ADMINISTRADOR" });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true, usuario, rol: "ADMINISTRADOR" });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => res.json({ ok: true, ...req.usuario }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mensaje: "Servidor funcionando correctamente" });
});

app.get("/api/db-test", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS fecha, current_database() AS base_de_datos");
    res.json({ ok: true, mensaje: "Conexión a PostgreSQL correcta", ...result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, mensaje: "No se pudo conectar a PostgreSQL", detalle: error.message });
  }
});

app.get("/api/habitaciones", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT h.*,
             CASE WHEN EXISTS (
               SELECT 1 FROM alquileres a
               WHERE a.habitacion_id = h.id AND a.estado = 'ACTIVO'
             ) THEN 'OCUPADA' ELSE h.estado END AS estado_actual
      FROM habitaciones h
      ORDER BY h.numero
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clientes", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM clientes ORDER BY nombre_completo");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/clientes", requireAuth, async (req, res) => {
  const { nombre_completo, documento, telefono, correo, direccion } = req.body;
  if (!nombre_completo?.trim()) {
    return res.status(400).json({ error: "El nombre del inquilino es obligatorio." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO clientes(nombre_completo, documento, telefono, correo, direccion)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [nombre_completo.trim(), documento || null, telefono || null, correo || null, direccion || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/clientes/:id", requireAuth, async (req, res) => {
  const { nombre_completo, documento, telefono, correo, direccion } = req.body;
  if (!nombre_completo?.trim()) {
    return res.status(400).json({ error: "El nombre del inquilino es obligatorio." });
  }
  try {
    const result = await pool.query(
      `UPDATE clientes
       SET nombre_completo=$1, documento=$2, telefono=$3, correo=$4, direccion=$5
       WHERE id=$6
       RETURNING *`,
      [nombre_completo.trim(), documento || null, telefono || null, correo || null, direccion || null, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "No se encontró el inquilino." });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/clientes/:id", requireAuth, async (req, res) => {
  try {
    const active = await pool.query(
      "SELECT COUNT(*)::int AS total FROM alquileres WHERE cliente_id=$1 AND estado='ACTIVO'",
      [req.params.id]
    );
    if (active.rows[0].total > 0) {
      return res.status(400).json({ error: "No se puede eliminar el inquilino porque tiene un alquiler activo. Finalice primero el alquiler." });
    }

    const history = await pool.query(
      "SELECT COUNT(*)::int AS total FROM alquileres WHERE cliente_id=$1",
      [req.params.id]
    );
    if (history.rows[0].total > 0) {
      return res.status(400).json({ error: "No se puede eliminar el inquilino porque tiene historial de alquileres o pagos. Para conservar los registros, modifique sus datos en lugar de eliminarlo." });
    }

    const result = await pool.query("DELETE FROM clientes WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "No se encontró el inquilino." });
    res.json({ ok: true, mensaje: "Inquilino eliminado correctamente." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/clientes/:id/alquileres-activos", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM alquileres a
      JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
      WHERE ai.cliente_id = $1 AND a.estado = 'ACTIVO'
    `, [req.params.id]);
    res.json({ count: result.rows[0].count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/alquileres", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*,
             COALESCE(d.meses_deuda, 0)::int AS meses_deuda,
             COALESCE(d.monto_pendiente, 0)::numeric AS monto_pendiente
      FROM vw_alquileres_detalle v
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM pagos p
            WHERE p.alquiler_id = v.id
              AND p.mes_pagado = meses.mes::date
          ))::int AS meses_deuda,
          COALESCE(COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM pagos p
            WHERE p.alquiler_id = v.id
              AND p.mes_pagado = meses.mes::date
          )), 0) * v.precio_mensual AS monto_pendiente
        FROM generate_series(
          date_trunc('month', v.fecha_inicio)::date,
          date_trunc('month', CURRENT_DATE)::date,
          interval '1 month'
        ) AS meses(mes)
        WHERE v.estado = 'ACTIVO'
          AND date_trunc('month', v.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
      ) d ON TRUE
      ORDER BY v.estado, v.habitacion
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/alquileres", requireAuth, async (req, res) => {
  const { habitacion_id, fecha_inicio, cliente1_id, observaciones } = req.body;
  if (!habitacion_id || !fecha_inicio || !cliente1_id) {
    return res.status(400).json({ error: "Habitación, fecha de inicio e inquilino titular son obligatorios." });
  }
  const precioBase = 400;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const customer = await client.query(
      "SELECT id, nombre_completo FROM clientes WHERE id = $1 FOR UPDATE",
      [cliente1_id]
    );
    if (!customer.rowCount) throw new Error("El cliente titular no existe.");

    const room = await client.query(
      "SELECT * FROM habitaciones WHERE id = $1 FOR UPDATE",
      [habitacion_id]
    );
    if (!room.rowCount) throw new Error("La habitación no existe.");
    if (room.rows[0].estado === "MANTENIMIENTO") throw new Error("La habitación está en mantenimiento.");

    const activeRoom = await client.query(
      "SELECT id FROM alquileres WHERE habitacion_id = $1 AND estado = 'ACTIVO' FOR UPDATE",
      [habitacion_id]
    );
    if (activeRoom.rowCount) throw new Error("La habitación ya tiene un alquiler activo.");

    const activeForCustomer = await client.query(`
      SELECT a.id, a.habitacion_id
      FROM alquileres a
      JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
      WHERE ai.cliente_id = $1 AND a.estado = 'ACTIVO'
      FOR UPDATE
    `, [cliente1_id]);

    if (activeForCustomer.rowCount >= 2) {
      throw new Error("El cliente ya tiene 2 habitaciones activas.");
    }

    const esSegundoCuarto = activeForCustomer.rowCount === 1;
    const descuentoPorcentaje = esSegundoCuarto ? 12.5 : 0;
    const montoDescuento = money(precioBase * (descuentoPorcentaje / 100));
    const precioMensual = money(precioBase - montoDescuento);

    const rentalResult = await client.query(`
      INSERT INTO alquileres(
        cliente_id, habitacion_id, fecha_inicio, precio_base, cantidad_inquilinos,
        descuento_porcentaje, monto_descuento, precio_mensual, estado, observaciones
      ) VALUES($1,$2,$3,$4,1,$5,$6,$7,'ACTIVO',$8)
      RETURNING *
    `, [cliente1_id, habitacion_id, fecha_inicio, precioBase, descuentoPorcentaje, montoDescuento, precioMensual, observaciones || null]);

    const alquiler = rentalResult.rows[0];
    await client.query(
      "INSERT INTO alquiler_inquilinos(alquiler_id, cliente_id, titular) VALUES($1,$2,true)",
      [alquiler.id, cliente1_id]
    );

    await client.query("UPDATE habitaciones SET estado = 'OCUPADA' WHERE id = $1", [habitacion_id]);
    await client.query("COMMIT");

    const mensaje = esSegundoCuarto
      ? `Alquiler creado. Es el segundo cuarto activo del cliente: 12,5% de descuento. Mensualidad: Bs ${precioMensual.toFixed(2)}.`
      : `Alquiler creado. Mensualidad: Bs ${precioMensual.toFixed(2)}.`;

    res.status(201).json({ ok: true, alquiler, mensaje });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put("/api/alquileres/:id/finalizar", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "UPDATE alquileres SET estado='FINALIZADO' WHERE id=$1 AND estado='ACTIVO' RETURNING habitacion_id",
      [req.params.id]
    );
    if (!result.rowCount) throw new Error("No se encontró el alquiler activo.");
    await client.query(`
      UPDATE habitaciones SET estado='DISPONIBLE'
      WHERE id=$1 AND NOT EXISTS (
        SELECT 1 FROM alquileres WHERE habitacion_id=$1 AND estado='ACTIVO'
      )
    `, [result.rows[0].habitacion_id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/api/pagos", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, h.numero AS habitacion,
             STRING_AGG(c.nombre_completo,' / ' ORDER BY ai.titular DESC,c.nombre_completo) AS inquilinos
      FROM pagos p
      JOIN alquileres a ON a.id=p.alquiler_id
      JOIN habitaciones h ON h.id=a.habitacion_id
      JOIN alquiler_inquilinos ai ON ai.alquiler_id=a.id
      JOIN clientes c ON c.id=ai.cliente_id
      GROUP BY p.id,h.numero
      ORDER BY p.fecha_pago DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/pagos", requireAuth, async (req, res) => {
  const { alquiler_id, mes_pagado, monto, metodo_pago, concepto, observaciones } = req.body;
  if (!alquiler_id || !mes_pagado || monto === undefined || monto === null) {
    return res.status(400).json({ error: "Alquiler, mes y monto son obligatorios." });
  }
  try {
    const rental = await pool.query(
      "SELECT precio_mensual FROM alquileres WHERE id=$1 AND estado='ACTIVO'",
      [alquiler_id]
    );
    if (!rental.rowCount) return res.status(400).json({ error: "El alquiler no está activo." });
    const precio = Number(rental.rows[0].precio_mensual);
    if (money(monto) !== money(precio)) {
      return res.status(400).json({ error: `El monto debe ser exactamente Bs ${precio.toFixed(2)}.` });
    }
    const existing = await pool.query(
      "SELECT id FROM pagos WHERE alquiler_id=$1 AND mes_pagado=$2",
      [alquiler_id, mes_pagado]
    );
    if (existing.rowCount) return res.status(400).json({ error: "Ese mes ya fue pagado para este alquiler." });

    const numero = `REC-${Date.now()}`;
    const result = await pool.query(`
      INSERT INTO pagos(alquiler_id,numero_recibo,mes_pagado,concepto,monto,metodo_pago,observaciones)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [alquiler_id, numero, mes_pagado, concepto || "Alquiler mensual", precio, metodo_pago || "EFECTIVO", observaciones || null]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/reportes/estado", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id AS alquiler_id,
        h.numero AS habitacion,
        a.cliente_id,
        a.precio_base,
        a.precio_mensual,
        a.monto_descuento,
        a.fecha_inicio,
        a.cantidad_inquilinos,
        a.descuento_porcentaje,
        MAX(CASE WHEN ai.titular THEN c.nombre_completo END) AS titular,
        COALESCE(d.meses_deuda, 0)::int AS meses_deuda,
        COALESCE(d.monto_pendiente, 0)::numeric AS monto_pendiente,
        CASE WHEN COALESCE(d.meses_deuda, 0) = 0 THEN 'AL_DIA' ELSE 'DEBE' END AS estado_pago_mes,
        COALESCE((SELECT SUM(p2.monto) FROM pagos p2 WHERE p2.alquiler_id = a.id), 0)::numeric AS total_pagado
      FROM alquileres a
      JOIN habitaciones h ON h.id = a.habitacion_id
      JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
      JOIN clientes c ON c.id = ai.cliente_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM pagos p
            WHERE p.alquiler_id = a.id
              AND p.mes_pagado = meses.mes::date
          ))::int AS meses_deuda,
          COALESCE(COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM pagos p
            WHERE p.alquiler_id = a.id
              AND p.mes_pagado = meses.mes::date
          )), 0) * a.precio_mensual AS monto_pendiente
        FROM generate_series(
          date_trunc('month', a.fecha_inicio)::date,
          date_trunc('month', CURRENT_DATE)::date,
          interval '1 month'
        ) AS meses(mes)
        WHERE date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
      ) d ON TRUE
      WHERE a.estado = 'ACTIVO'
      GROUP BY a.id, h.numero, d.meses_deuda, d.monto_pendiente
      ORDER BY d.meses_deuda DESC, h.numero
    `);
    const resumen = {
      total: result.rowCount,
      al_dia: result.rows.filter(x => Number(x.meses_deuda) === 0).length,
      deben: result.rows.filter(x => Number(x.meses_deuda) > 0).length,
      monto_pendiente: money(result.rows.reduce((sum, x) => sum + Number(x.monto_pendiente || 0), 0))
    };
    res.json({ mes: currentMonth(), resumen, filas: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/resumen", requireAuth, async (req, res) => {
  try {
    const [rooms, active, paid, due, dueAmount] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE estado='DISPONIBLE')::int AS disponibles, COUNT(*) FILTER (WHERE estado='MANTENIMIENTO')::int AS mantenimiento FROM habitaciones"),
      pool.query("SELECT COUNT(*)::int AS total FROM alquileres WHERE estado='ACTIVO'"),
      pool.query("SELECT COALESCE(SUM(monto),0)::numeric AS total FROM pagos WHERE mes_pagado=date_trunc('month',CURRENT_DATE)::date"),
      pool.query(`SELECT COUNT(*)::int AS total FROM (
        SELECT a.id
        FROM alquileres a
        WHERE a.estado='ACTIVO'
          AND date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
          AND EXISTS (
            SELECT 1 FROM generate_series(
              date_trunc('month', a.fecha_inicio)::date,
              date_trunc('month', CURRENT_DATE)::date,
              interval '1 month'
            ) meses(mes)
            WHERE NOT EXISTS (SELECT 1 FROM pagos p WHERE p.alquiler_id=a.id AND p.mes_pagado=meses.mes::date)
          )
      ) q`),
      pool.query(`SELECT COALESCE(SUM(
        (SELECT COUNT(*)::numeric FROM generate_series(
          date_trunc('month', a.fecha_inicio)::date,
          date_trunc('month', CURRENT_DATE)::date,
          interval '1 month'
        ) meses(mes)
        WHERE NOT EXISTS (SELECT 1 FROM pagos p WHERE p.alquiler_id=a.id AND p.mes_pagado=meses.mes::date)
        ) * a.precio_mensual
      ),0)::numeric AS total FROM alquileres a WHERE a.estado='ACTIVO' AND date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date`)
    ]);
    res.json({ rooms: rooms.rows[0], active: active.rows[0].total, paid: paid.rows[0].total, due: due.rows[0].total, due_amount: dueAmount.rows[0].total });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../frontend", "index.html")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Sistema de alquiler mensual: http://localhost:${PORT}`);
});
