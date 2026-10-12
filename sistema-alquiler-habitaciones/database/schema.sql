-- Base de datos: alquiler_habitaciones
-- Sistema de alquiler mensual de cuartos
-- PostgreSQL
-- Regla: una persona puede tener como máximo 2 habitaciones activas.
-- El segundo cuarto de la misma persona recibe 12,5% de descuento.
-- Cada alquiler nuevo registra un único inquilino titular.

CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    usuario VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(120) NOT NULL,
    password_hash TEXT NOT NULL,
    rol VARCHAR(30) NOT NULL DEFAULT 'ADMINISTRADOR',
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS habitaciones (
    id SERIAL PRIMARY KEY,
    numero INTEGER NOT NULL UNIQUE CHECK (numero BETWEEN 1 AND 5),
    capacidad INTEGER NOT NULL DEFAULT 1 CHECK (capacidad IN (1,2)),
    precio_mensual NUMERIC(10,2) NOT NULL DEFAULT 400.00 CHECK (precio_mensual >= 0),
    estado VARCHAR(20) NOT NULL DEFAULT 'DISPONIBLE'
        CHECK (estado IN ('DISPONIBLE','OCUPADA','MANTENIMIENTO')),
    descripcion TEXT,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY,
    nombre_completo VARCHAR(150) NOT NULL,
    documento VARCHAR(50),
    telefono VARCHAR(30),
    correo VARCHAR(120),
    direccion TEXT,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alquileres (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    habitacion_id INTEGER NOT NULL REFERENCES habitaciones(id),
    fecha_inicio DATE NOT NULL,
    precio_base NUMERIC(10,2) NOT NULL DEFAULT 400.00 CHECK (precio_base >= 0),
    cantidad_inquilinos INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_inquilinos = 1),
    descuento_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (descuento_porcentaje IN (0,12.5)),
    monto_descuento NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monto_descuento >= 0),
    precio_mensual NUMERIC(10,2) NOT NULL CHECK (precio_mensual >= 0),
    estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVO'
        CHECK (estado IN ('ACTIVO','FINALIZADO','CANCELADO')),
    observaciones TEXT,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_alquiler_calculo_precio
        CHECK (precio_mensual = ROUND(precio_base - monto_descuento, 2)),
    CONSTRAINT ck_alquiler_descuento_calculado
        CHECK (monto_descuento = ROUND(precio_base * descuento_porcentaje / 100, 2))
);

-- Si la base ya existía con la regla anterior, las nuevas operaciones quedan protegidas
-- por el trigger de un solo titular definido más abajo. No se eliminan registros históricos.

CREATE TABLE IF NOT EXISTS alquiler_inquilinos (
    id SERIAL PRIMARY KEY,
    alquiler_id INTEGER NOT NULL REFERENCES alquileres(id) ON DELETE CASCADE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    titular BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (alquiler_id, cliente_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_alquiler_titular
ON alquiler_inquilinos(alquiler_id) WHERE titular = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_habitacion_un_alquiler_activo
ON alquileres(habitacion_id) WHERE estado = 'ACTIVO';

CREATE INDEX IF NOT EXISTS idx_alquileres_cliente ON alquileres(cliente_id);
CREATE INDEX IF NOT EXISTS idx_alquileres_habitacion ON alquileres(habitacion_id);
CREATE INDEX IF NOT EXISTS idx_alquiler_inquilinos_cliente ON alquiler_inquilinos(cliente_id);

-- Esta función protege la regla incluso si alguien intenta insertar directamente
-- en PostgreSQL sin pasar por el backend.
CREATE OR REPLACE FUNCTION fn_validar_alquiler_cliente()
RETURNS TRIGGER AS $$
DECLARE
    cantidad_activas INTEGER;
BEGIN
    -- Cada alquiler nuevo tiene un solo titular.
    NEW.cantidad_inquilinos := 1;
    PERFORM pg_advisory_xact_lock(7142, NEW.cliente_id);

    SELECT COUNT(DISTINCT a.id) INTO cantidad_activas
    FROM alquileres a
    JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
    WHERE ai.cliente_id = NEW.cliente_id
      AND a.estado = 'ACTIVO';

    IF NEW.estado = 'ACTIVO' AND cantidad_activas >= 2 THEN
        RAISE EXCEPTION 'El cliente ya tiene 2 habitaciones activas.'
            USING ERRCODE = 'P0001';
    END IF;

    IF NEW.estado = 'ACTIVO' THEN
        IF cantidad_activas = 0 THEN
            NEW.descuento_porcentaje := 0;
        ELSIF cantidad_activas = 1 THEN
            NEW.descuento_porcentaje := 12.5;
        END IF;
        NEW.monto_descuento := ROUND(NEW.precio_base * NEW.descuento_porcentaje / 100, 2);
        NEW.precio_mensual := ROUND(NEW.precio_base - NEW.monto_descuento, 2);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_alquiler_cliente ON alquileres;
CREATE TRIGGER trg_validar_alquiler_cliente
BEFORE INSERT ON alquileres
FOR EACH ROW
EXECUTE FUNCTION fn_validar_alquiler_cliente();

-- Cada alquiler nuevo solo puede tener un titular.
CREATE OR REPLACE FUNCTION fn_validar_inquilino_alquiler()
RETURNS TRIGGER AS $$
DECLARE
    cantidad_personas INTEGER;
    alquiler_activo BOOLEAN;
BEGIN
    PERFORM pg_advisory_xact_lock(7143, NEW.alquiler_id);

    SELECT estado = 'ACTIVO' INTO alquiler_activo
    FROM alquileres
    WHERE id = NEW.alquiler_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El alquiler no existe.' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.titular IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'El alquiler debe tener un único inquilino titular.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COUNT(*) INTO cantidad_personas
    FROM alquiler_inquilinos
    WHERE alquiler_id = NEW.alquiler_id;

    IF cantidad_personas >= 1 THEN
        RAISE EXCEPTION 'Cada alquiler debe tener un solo inquilino titular.' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_inquilino_alquiler ON alquiler_inquilinos;
CREATE TRIGGER trg_validar_inquilino_alquiler
BEFORE INSERT ON alquiler_inquilinos
FOR EACH ROW
EXECUTE FUNCTION fn_validar_inquilino_alquiler();

-- Protege también la regla para alquileres creados directamente en PostgreSQL.
CREATE OR REPLACE FUNCTION fn_validar_un_titular_alquiler()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.cantidad_inquilinos <> 1 THEN
        RAISE EXCEPTION 'Cada alquiler debe tener un solo inquilino titular.' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_un_titular_alquiler ON alquileres;
CREATE TRIGGER trg_validar_un_titular_alquiler
BEFORE INSERT OR UPDATE ON alquileres
FOR EACH ROW
EXECUTE FUNCTION fn_validar_un_titular_alquiler();

CREATE TABLE IF NOT EXISTS pagos (
    id SERIAL PRIMARY KEY,
    alquiler_id INTEGER NOT NULL REFERENCES alquileres(id) ON DELETE CASCADE,
    numero_recibo VARCHAR(30) NOT NULL UNIQUE,
    fecha_pago TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    mes_pagado DATE NOT NULL,
    concepto VARCHAR(200) NOT NULL DEFAULT 'Alquiler mensual',
    monto NUMERIC(10,2) NOT NULL CHECK (monto > 0),
    metodo_pago VARCHAR(30) NOT NULL DEFAULT 'EFECTIVO'
        CHECK (metodo_pago IN ('EFECTIVO','TARJETA','TRANSFERENCIA','QR')),
    observaciones TEXT,
    UNIQUE (alquiler_id, mes_pagado)
);

CREATE INDEX IF NOT EXISTS idx_pagos_mes ON pagos(mes_pagado);

DROP VIEW IF EXISTS vw_alquileres_detalle, vw_estado_mensual;

CREATE OR REPLACE VIEW vw_alquileres_detalle AS
SELECT
    a.id,
    a.cliente_id,
    h.numero AS habitacion,
    a.fecha_inicio,
    a.cantidad_inquilinos,
    a.precio_base,
    a.descuento_porcentaje,
    a.monto_descuento,
    a.precio_mensual,
    a.estado,
    STRING_AGG(c.nombre_completo, ' / ' ORDER BY ai.titular DESC, c.nombre_completo) AS inquilinos,
    MAX(CASE WHEN ai.titular THEN c.nombre_completo END) AS titular,
    CASE WHEN a.estado = 'ACTIVO' THEN COALESCE((
        SELECT COUNT(*)::int
        FROM generate_series(
            date_trunc('month', a.fecha_inicio)::date,
            date_trunc('month', CURRENT_DATE)::date,
            interval '1 month'
        ) AS meses(mes)
        WHERE NOT EXISTS (
            SELECT 1 FROM pagos p
            WHERE p.alquiler_id = a.id
              AND p.mes_pagado = meses.mes::date
        )
    ), 0) ELSE 0 END AS meses_deuda,
    CASE WHEN a.estado = 'ACTIVO' THEN (
        CASE WHEN date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
             THEN COALESCE((
                SELECT COUNT(*)::numeric
                FROM generate_series(
                    date_trunc('month', a.fecha_inicio)::date,
                    date_trunc('month', CURRENT_DATE)::date,
                    interval '1 month'
                ) AS meses(mes)
                WHERE NOT EXISTS (
                    SELECT 1 FROM pagos p
                    WHERE p.alquiler_id = a.id
                      AND p.mes_pagado = meses.mes::date
                )
             ), 0) * a.precio_mensual
             ELSE 0 END
    ) ELSE 0 END AS monto_pendiente
FROM alquileres a
JOIN habitaciones h ON h.id = a.habitacion_id
JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
JOIN clientes c ON c.id = ai.cliente_id
GROUP BY a.id, h.numero;

CREATE OR REPLACE VIEW vw_estado_mensual AS
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
    STRING_AGG(c.nombre_completo, ' / ' ORDER BY ai.titular DESC, c.nombre_completo) AS inquilinos,
    CASE
      WHEN COALESCE((
        SELECT COUNT(*)::int
        FROM generate_series(
          date_trunc('month', a.fecha_inicio)::date,
          date_trunc('month', CURRENT_DATE)::date,
          interval '1 month'
        ) AS meses(mes)
        WHERE NOT EXISTS (
          SELECT 1 FROM pagos p
          WHERE p.alquiler_id = a.id
            AND p.mes_pagado = meses.mes::date
        )
      ), 0) = 0 THEN 'AL_DIA'
      ELSE 'DEBE'
    END AS estado_pago_mes,
    CASE WHEN date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
         THEN COALESCE((
            SELECT COUNT(*)::int
            FROM generate_series(
              date_trunc('month', a.fecha_inicio)::date,
              date_trunc('month', CURRENT_DATE)::date,
              interval '1 month'
            ) AS meses(mes)
            WHERE NOT EXISTS (
              SELECT 1 FROM pagos p
              WHERE p.alquiler_id = a.id
                AND p.mes_pagado = meses.mes::date
            )
         ), 0) ELSE 0 END AS meses_deuda,
    CASE WHEN date_trunc('month', a.fecha_inicio)::date <= date_trunc('month', CURRENT_DATE)::date
         THEN COALESCE((
            SELECT COUNT(*)::numeric
            FROM generate_series(
              date_trunc('month', a.fecha_inicio)::date,
              date_trunc('month', CURRENT_DATE)::date,
              interval '1 month'
            ) AS meses(mes)
            WHERE NOT EXISTS (
              SELECT 1 FROM pagos p
              WHERE p.alquiler_id = a.id
                AND p.mes_pagado = meses.mes::date
            )
         ), 0) * a.precio_mensual ELSE 0 END AS monto_pendiente,
    COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.alquiler_id = a.id),0) AS total_pagado
FROM alquileres a
JOIN habitaciones h ON h.id = a.habitacion_id
JOIN alquiler_inquilinos ai ON ai.alquiler_id = a.id
JOIN clientes c ON c.id = ai.cliente_id
WHERE a.estado = 'ACTIVO'
GROUP BY a.id, h.numero;
